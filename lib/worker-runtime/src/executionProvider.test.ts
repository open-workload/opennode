import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkloadRun } from "@workspace/db";
import { WorkerSpecError } from "./errors";
import { IsolatedProcessBackend } from "./isolatedProcess";
import { WorkerExecutionProvider, workerSpecFromRun } from "./executionProvider";
import { RootlessBackend } from "./rootlessBackend";
import { WorkerRuntime } from "./runtime";
import { validateWorkerSpec } from "./spec";

const BUSYBOX_DIGEST = "6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348";
const PINNED = "a".repeat(64);

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
    const provider = new WorkerExecutionProvider(new WorkerRuntime(new IsolatedProcessBackend()));
    expect(provider.executionMode).toBe("isolated_worker");
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