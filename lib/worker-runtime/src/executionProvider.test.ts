import { describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkloadRun } from "@workspace/db";
import { metricsRegistry } from "@workspace/observability";
import type { WorkerResult } from "./backend";
import { WorkerRuntimeError, WorkerSpecError } from "./errors";
import { IsolatedProcessBackend } from "./isolatedProcess";
import { WorkerExecutionProvider, workerSpecFromRun, type AttemptLifecycle } from "./executionProvider";
import { RootlessBackend } from "./rootlessBackend";
import { WorkerRuntime } from "./runtime";
import { validateWorkerSpec } from "./spec";

const BUSYBOX_DIGEST = "6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348";
const PINNED = "a".repeat(64);

function makeLifecycle(renewEveryMs = 60_000) {
  return {
    renewEveryMs,
    observe: vi.fn<AttemptLifecycle["observe"]>().mockResolvedValue(undefined),
    renewLease: vi.fn<AttemptLifecycle["renewLease"]>().mockResolvedValue(undefined),
  };
}

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return { runId: "run-1", backendRunId: "backend-1", status: "succeeded", exitCode: 0, outputBytes: 42, ...overrides };
}

function makeRun(overrides: Partial<WorkloadRun> = {}): WorkloadRun {
  return {
    id: "run-1",
    clientRequestId: "client-1",
    name: "smoke",
    mode: "container",
    image: "alpine:3.19",
    imageDigest: null,
    command: [],
    status: "queued",
    executionMode: "isolated_worker",
    submittedBy: "actor-1",
    submittedViaNodeId: "node-1",
    workerNodeId: null,
    attemptCount: 0,
    resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
    networkPolicy: "deny_all",
    failureReason: null,
    requestFingerprint: "fp",
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("workerSpecFromRun", () => {
  it("parses the sha256 digest out of a pinned container image ref", () => {
    const image = `alpine:3.19@sha256:${PINNED}`;
    const spec = workerSpecFromRun(makeRun({ image }));

    expect(spec.image).toEqual({ ref: image, digest: `sha256:${PINNED}` });
    expect(validateWorkerSpec(spec).ok).toBe(true);
  });

  it("throws a WorkerSpecError when a container image ref is not pinned", () => {
    expect(() => workerSpecFromRun(makeRun({ image: "alpine:3.19" }))).toThrow(WorkerSpecError);
    expect(() => workerSpecFromRun(makeRun({ image: `alpine:3.19@sha256:short` }))).toThrow(
      WorkerSpecError,
    );
  });

  it("synthesizes a valid pinned built-in image for diagnostic runs", () => {
    const spec = workerSpecFromRun(makeRun({ image: null, mode: "diagnostic" }));

    expect(spec.image).toEqual({ ref: "busybox:1.35", digest: `sha256:${BUSYBOX_DIGEST}` });
    expect(validateWorkerSpec(spec).ok).toBe(true);
  });
});

describe("WorkerExecutionProvider", () => {
  it("reports isolated_worker as the execution mode", () => {
    const provider = new WorkerExecutionProvider(new WorkerRuntime(new IsolatedProcessBackend()), makeLifecycle());
    expect(provider.executionMode).toBe("isolated_worker");
  });
});

/** Read an unlabelled sample value out of the shared exposition. */
function metricValue(name: string): number | undefined {
  for (const line of metricsRegistry.render().split("\n")) {
    if (line.startsWith(`${name} `)) return Number(line.slice(name.length + 1));
  }
  return undefined;
}

describe("WorkerExecutionProvider OPS-03 metric producers", () => {
  const run = makeRun({ image: `alpine:3.19@sha256:${PINNED}` });

  it("sets provider.availability to 1 when the provider starts a run", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const provider = new WorkerExecutionProvider(
      { submit, waitForCompletion: vi.fn().mockResolvedValue(makeResult()) } as unknown as WorkerRuntime,
      makeLifecycle(),
    );

    await provider.startRun(run);

    expect(metricValue("provider.availability")).toBe(1);
  });

  it("sets provider.availability to 0 when the runtime rejects the run", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("backend down"));
    const provider = new WorkerExecutionProvider(
      { submit, waitForCompletion: vi.fn() } as unknown as WorkerRuntime,
      makeLifecycle(),
    );

    await expect(provider.startRun(run)).rejects.toThrow("backend down");
    expect(metricValue("provider.availability")).toBe(0);
  });

  it("does not mark the provider unavailable when only the run spec is invalid", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const provider = new WorkerExecutionProvider(
      { submit, waitForCompletion: vi.fn().mockResolvedValue(makeResult()) } as unknown as WorkerRuntime,
      makeLifecycle(),
    );

    await provider.startRun(run);
    expect(metricValue("provider.availability")).toBe(1);

    await expect(provider.startRun(makeRun({ image: "alpine:3.19" }))).rejects.toThrow(WorkerSpecError);
    expect(metricValue("provider.availability")).toBe(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("WorkerExecutionProvider attempt lifecycle", () => {
  const run = makeRun({ image: `alpine:3.19@sha256:${PINNED}` });

  it("observes running then the terminal status in order", async () => {
    const lifecycle = makeLifecycle();
    const provider = new WorkerExecutionProvider(
      { submit: vi.fn().mockResolvedValue(undefined), waitForCompletion: vi.fn().mockResolvedValue(makeResult()) } as unknown as WorkerRuntime,
      lifecycle,
    );

    await provider.startRun(run, { requestId: "req-1" });

    expect(lifecycle.observe.mock.calls).toEqual([
      [{ runId: run.id, status: "running", requestId: "req-1" }],
      [{ runId: run.id, status: "succeeded", note: "exit=0 outputBytes=42", requestId: "req-1" }],
    ]);
  });

  it("prefers the result error over the exit summary as the terminal note", async () => {
    const lifecycle = makeLifecycle();
    const provider = new WorkerExecutionProvider(
      {
        submit: vi.fn().mockResolvedValue(undefined),
        waitForCompletion: vi.fn().mockResolvedValue(makeResult({ status: "failed", exitCode: 2, error: "segfault" })),
      } as unknown as WorkerRuntime,
      lifecycle,
    );

    await provider.startRun(run, { requestId: "req-1" });

    expect(lifecycle.observe).toHaveBeenLastCalledWith({
      runId: run.id,
      status: "failed",
      note: "segfault",
      requestId: "req-1",
    });
  });

  it("renews the lease on the lifecycle cadence while the run is active, then stops", async () => {
    const lifecycle = makeLifecycle(5);
    let release!: (result: WorkerResult) => void;
    const waitForCompletion = vi.fn().mockReturnValue(
      new Promise<WorkerResult>((resolve) => {
        release = resolve;
      }),
    );
    const provider = new WorkerExecutionProvider(
      { submit: vi.fn().mockResolvedValue(undefined), waitForCompletion } as unknown as WorkerRuntime,
      lifecycle,
    );

    const started = provider.startRun(run, { requestId: "req-1" });
    await vi.waitFor(() => expect(waitForCompletion).toHaveBeenCalled());
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));

    expect(lifecycle.renewLease.mock.calls.length).toBeGreaterThan(0);
    expect(lifecycle.renewLease).toHaveBeenCalledWith(run.id, { requestId: "req-1" });

    release(makeResult());
    await started;

    const callsAtCompletion = lifecycle.renewLease.mock.calls.length;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(lifecycle.renewLease.mock.calls.length).toBe(callsAtCompletion);
  });

  it("observes infrastructure_error when the runtime rejects the run", async () => {
    const lifecycle = makeLifecycle();
    const provider = new WorkerExecutionProvider(
      { submit: vi.fn().mockRejectedValue(new Error("backend down")), waitForCompletion: vi.fn() } as unknown as WorkerRuntime,
      lifecycle,
    );

    await expect(provider.startRun(run, { requestId: "req-1" })).rejects.toThrow("backend down");

    expect(lifecycle.observe).toHaveBeenCalledExactlyOnceWith({
      runId: run.id,
      status: "infrastructure_error",
      note: "backend down",
      requestId: "req-1",
    });
    expect(lifecycle.renewLease).not.toHaveBeenCalled();
  });

  it("does not observe infrastructure_error for a duplicate_run error", async () => {
    const lifecycle = makeLifecycle();
    const provider = new WorkerExecutionProvider(
      {
        submit: vi.fn().mockRejectedValue(new WorkerRuntimeError(`run ${run.id} is already active`, "duplicate_run")),
        waitForCompletion: vi.fn(),
      } as unknown as WorkerRuntime,
      lifecycle,
    );

    await expect(provider.startRun(run, { requestId: "req-1" })).rejects.toThrow("already active");

    expect(lifecycle.observe).not.toHaveBeenCalled();
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const installPrefix = join(repoRoot, ".local", "rootless");
const rootfs = join(installPrefix, "rootfs");

async function untilAttemptSucceeds(runtime: WorkerRuntime, runId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = runtime.historyFor(runId).at(-1);
    if (record?.result !== undefined) {
      expect(record.result.status).toBe("succeeded");
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  expect(runtime.historyFor(runId).at(-1)?.result?.status).toBe("succeeded");
}

describe.skipIf(!existsSync(rootfs))("WorkerExecutionProvider real rootless end-to-end (EXEC-01)", () => {
  it("submits a container run through the userns runtime and records a succeeded attempt", async () => {
    const run = makeRun({
      id: "exec01-e2e",
      mode: "container",
      image: `busybox:1.35@sha256:${BUSYBOX_DIGEST}`,
      command: ["/bin/sh", "-c", "echo exec01-rootless-ok"],
    });
    const spec = workerSpecFromRun(run);
    expect(validateWorkerSpec(spec).ok).toBe(true);

    const runtime = new WorkerRuntime(
      new RootlessBackend({ kind: "userns", installPrefix, rootfs, scratchRoot: tmpdir() }),
    );

    await runtime.submit(spec);
    await untilAttemptSucceeds(runtime, run.id, 15000);
  }, 30000);

  it("rejects an unpinned container image before the runtime touches it", () => {
    const run = makeRun({ mode: "container", image: "alpine:3.19", command: ["/bin/true"] });
    expect(() => workerSpecFromRun(run)).toThrow(WorkerSpecError);
  });
});