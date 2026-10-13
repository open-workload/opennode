import { describe, expect, it, vi } from "vitest";
import type { CleanupReport, WorkerBackend, WorkerHandle, WorkerResult } from "./backend";
import { WorkerRuntimeError } from "./errors";
import { WorkerRuntime } from "./runtime";
import type { WorkerSpec } from "./spec";

const CLEANUP: CleanupReport = {
  scratchRemoved: true,
  tempCredsRevoked: true,
  cgroupRemoved: true,
  networkRulesRemoved: true,
  imageLayersCleaned: true,
};

function makeSpec(runId: string): WorkerSpec {
  return {
    runId,
    image: { ref: "busybox:1.35", digest: `sha256:${"a".repeat(64)}` },
    command: ["/bin/true"],
    env: { entries: [] },
    limits: {
      cpuMilli: 100,
      memoryBytes: 64 * 1024 * 1024,
      pidLimit: 64,
      diskBytes: 64 * 1024 * 1024,
      wallClockMs: 60_000,
      outputBytes: 65_536,
    },
    network: { mode: "deny_all", allowedEgressHosts: [], blockMetadataEndpoints: true, blockControlPlane: true },
  };
}

function makeResult(runId: string, overrides: Partial<WorkerResult> = {}): WorkerResult {
  return { runId, backendRunId: "backend-1", status: "succeeded", exitCode: 0, outputBytes: 12, ...overrides };
}

function controllableBackend(runId: string) {
  let resolveWait!: (result: WorkerResult) => void;
  let rejectWait!: (error: unknown) => void;
  const wait = new Promise<WorkerResult>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const handle: WorkerHandle = {
    runId,
    backendRunId: "backend-1",
    state: () => "running",
    cancel: async () => {},
    cleanup: async () => CLEANUP,
    wait: () => wait,
  };
  const backend: WorkerBackend = { kind: "fake", start: async () => handle };
  return { backend, resolveWait, rejectWait };
}

describe("WorkerRuntime.waitForCompletion", () => {
  it("resolves with the WorkerResult once the watched attempt finishes", async () => {
    const { backend, resolveWait } = controllableBackend("run-1");
    const runtime = new WorkerRuntime(backend);
    await runtime.submit(makeSpec("run-1"));

    const completion = runtime.waitForCompletion("run-1");
    resolveWait(makeResult("run-1", { status: "failed", exitCode: 3 }));

    await expect(completion).resolves.toMatchObject({ status: "failed", exitCode: 3 });
  });

  it("resolves immediately when the last attempt already has a result", async () => {
    const { backend, resolveWait } = controllableBackend("run-1");
    const runtime = new WorkerRuntime(backend);
    await runtime.submit(makeSpec("run-1"));
    const result = makeResult("run-1");
    resolveWait(result);
    await vi.waitFor(() => expect(runtime.historyFor("run-1").at(-1)?.result).toBeDefined());

    await expect(runtime.waitForCompletion("run-1")).resolves.toBe(result);
  });

  it("rejects with a WorkerRuntimeError when the run is neither active nor in history", async () => {
    const { backend } = controllableBackend("run-1");
    const runtime = new WorkerRuntime(backend);

    await expect(runtime.waitForCompletion("missing")).rejects.toBeInstanceOf(WorkerRuntimeError);
  });

  it("rejects waiters when the background watch fails", async () => {
    const { backend, rejectWait } = controllableBackend("run-1");
    const runtime = new WorkerRuntime(backend);
    await runtime.submit(makeSpec("run-1"));

    const completion = runtime.waitForCompletion("run-1");
    rejectWait(new Error("backend exploded"));

    await expect(completion).rejects.toThrow("backend exploded");
  });
});
