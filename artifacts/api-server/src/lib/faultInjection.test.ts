import { describe, expect, it, vi } from "vitest";
import { FaultType } from "@workspace/failure-injection";
import {
  WorkerRuntime,
  type WorkerBackend,
  type WorkerHandle,
  type WorkerResult,
  type WorkerSpec,
} from "@workspace/worker-runtime";
import {
  WORKER_EXECUTION_FAULT_POINT,
  createFaultInjectingBackend,
  faultInjection,
} from "./faultInjection";

const DIGEST = "sha256:" + "a".repeat(64);

function createSpec(runId: string): WorkerSpec {
  return {
    runId,
    image: { ref: "alpine:latest", digest: DIGEST },
    env: { entries: [] },
    limits: {
      cpuMilli: 100,
      memoryBytes: 1024 * 1024,
      pidLimit: 32,
      diskBytes: 1024 * 1024,
      wallClockMs: 60_000,
      outputBytes: 1024,
    },
    network: {
      mode: "deny_all",
      allowedEgressHosts: [],
      blockMetadataEndpoints: true,
      blockControlPlane: true,
    },
  };
}

function createFakeBackend() {
  const started: WorkerSpec[] = [];
  const backend: WorkerBackend = {
    kind: "fake",
    async start(spec: WorkerSpec): Promise<WorkerHandle> {
      started.push(spec);
      const report = {
        scratchRemoved: true,
        tempCredsRevoked: true,
        cgroupRemoved: true,
        networkRulesRemoved: true,
        imageLayersCleaned: true,
      };
      return {
        runId: spec.runId,
        backendRunId: "backend-run-1",
        state: () => "running",
        cancel: async () => {},
        cleanup: async () => report,
        wait: () => new Promise<WorkerResult>(() => {}),
      };
    },
  };
  return { backend, started };
}

describe("api-server fault injection wiring", () => {
  it("bootstraps the injector with registered fault points and a default harness", () => {
    expect(faultInjection.injector.getFaultPoint(WORKER_EXECUTION_FAULT_POINT)).toBeDefined();
    expect(faultInjection.harness.getAllScenarios().length).toBeGreaterThan(0);
  });

  it("passes backend.start through unchanged when no injection is active", async () => {
    faultInjection.injector.reset();
    const { backend, started } = createFakeBackend();
    const runtime = new WorkerRuntime(createFaultInjectingBackend(backend));

    const record = await runtime.submit(createSpec("run-pass-through"));

    expect(started).toHaveLength(1);
    expect(started[0].runId).toBe("run-pass-through");
    expect(record.backendRunId).toBe("backend-run-1");
  });

  it("faults backend.start when an injection is active on the worker-execution fault point", async () => {
    faultInjection.injector.reset();
    faultInjection.injector.enable();
    faultInjection.injector.createInjection(WORKER_EXECUTION_FAULT_POINT, {
      type: FaultType.Error,
      probability: 1.0,
      errorMessage: "injected worker execution failure",
    });

    const consulted = vi.spyOn(faultInjection.injector, "shouldInject");
    const { backend, started } = createFakeBackend();
    const runtime = new WorkerRuntime(createFaultInjectingBackend(backend));

    await expect(runtime.submit(createSpec("run-injected"))).rejects.toThrow(
      "injected worker execution failure",
    );

    expect(consulted).toHaveBeenCalledWith(WORKER_EXECUTION_FAULT_POINT);
    expect(faultInjection.injector.getInjection(WORKER_EXECUTION_FAULT_POINT)?.injectedCount).toBe(1);
    expect(started).toHaveLength(0);
    consulted.mockRestore();
  });
});
