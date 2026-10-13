import { describe, expect, it, vi } from "vitest";
import type { WorkloadRun } from "@workspace/db";
import { createClusterId } from "@workspace/opennode-domain";
import { MembershipLog, createInMemoryMembershipLogStore } from "@workspace/membership-log";
import type { NodeStore } from "@workspace/node-store";
import {
  RunCoordinator,
  createInMemoryRunLedgerStore,
  type QuotaPolicy,
  type RunSpec,
} from "@workspace/run-coordinator";
import {
  EventLog,
  createHmacSigner,
  createHmacVerifier,
  createInMemoryEventLogStore,
} from "@workspace/sync-engine";
import {
  WorkerExecutionProvider,
  WorkerRuntime,
  type WorkerBackend,
  type WorkerHandle,
  type WorkerResult,
} from "@workspace/worker-runtime";
import { createAttemptLifecycle } from "./attemptLifecycle";

const QUOTAS: QuotaPolicy = {
  maxConcurrentRuns: 8,
  maxQueuedRuns: 32,
  maxDurationMs: 24 * 60 * 60 * 1000,
  maxCpuMilli: 16000,
  maxMemoryMiB: 65536,
  maxDiskMiB: 1048576,
  maxOutputBytes: 64 * 1024 * 1024,
  maxAttempts: 3,
  requireDigestPinnedImage: true,
  allowedImagePrefixes: [],
  allowedSecretRefPrefixes: [],
  maxCpuMilliPerTenant: 8000,
  maxMemoryMiBPerTenant: 32768,
  maxDiskMiBPerTenant: 524288,
  maxConcurrentRunsPerTenant: 4,
};

const SPEC: RunSpec = {
  name: "smoke",
  mode: "container",
  image: `busybox:1.35@sha256:${"a".repeat(64)}`,
  command: ["sh", "-c", "echo hi"],
  resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
  expectedOutputBytes: 0,
  secretRefs: [],
  requiredCapabilities: [],
  networkPolicy: "deny_all",
  sideEffectClass: "at-least-once",
  tenantId: "default",
  projectId: "default",
};

const DB_RUN_ROW: WorkloadRun = {
  id: "db-run-1",
  clientRequestId: "client-1",
  name: "smoke",
  mode: "container",
  image: SPEC.image,
  imageDigest: null,
  command: ["sh", "-c", "echo hi"],
  status: "queued",
  executionMode: "isolated_worker",
  submittedBy: "actor-1",
  submittedViaNodeId: "node-a",
  workerNodeId: null,
  attemptCount: 0,
  resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
  networkPolicy: "deny_all",
  failureReason: null,
  requestFingerprint: "",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

async function createHarness() {
  const localNodeId = "node-a";
  const clusterId = createClusterId("test-cluster");
  const secret = "test-secret";
  const signer = createHmacSigner(localNodeId, secret);
  const eventLog = new EventLog(
    createInMemoryEventLogStore(),
    clusterId,
    createHmacVerifier({ [localNodeId]: secret }),
  );
  const membershipStore = createInMemoryMembershipLogStore();
  await membershipStore.save({
    clusterId: clusterId.value,
    epoch: 0,
    memberIds: Object.freeze([localNodeId]),
    appliedSequence: 0,
  });
  const membershipLog = new MembershipLog({
    clusterId,
    consensusLog: {
      isLeader: () => true,
      getLeaderId: () => localNodeId,
      propose: async (entry) => {
        await eventLog.appendEvent(entry.event, signer);
        return entry;
      },
      getHeight: () => eventLog.getHeight(),
      getEntry: (seq) => eventLog.getEntry(seq),
      getRange: (from, to) => eventLog.getRange(from, to),
      start: async () => {},
      stop: async () => {},
    },
    signer,
    store: membershipStore,
  });
  const submitRun = vi.fn();
  submitRun.mockResolvedValue({ run: { id: "db-run-1" }, created: true });
  const createAttempt = vi.fn();
  createAttempt.mockResolvedValue({ id: "db-attempt-1" });
  const transitionAttempt = vi.fn();
  transitionAttempt.mockResolvedValue({ id: "db-attempt-1" });
  const markRunTerminal = vi.fn();
  markRunTerminal.mockResolvedValue({ id: "db-run-1" });
  const setRunRunning = vi.fn();
  setRunRunning.mockResolvedValue({ id: "db-run-1" });
  const requestCancel = vi.fn();
  requestCancel.mockResolvedValue({ id: "db-run-1" });
  const nodeStore = {
    submitRun,
    createAttempt,
    transitionAttempt,
    markRunTerminal,
    setRunRunning,
    requestCancel,
  } as unknown as NodeStore;
  const coordinator = new RunCoordinator({
    clusterId,
    eventLog,
    signer,
    membershipLog,
    store: createInMemoryRunLedgerStore(),
    quotas: QUOTAS,
    capabilities: [{ nodeId: localNodeId, capabilities: ["diagnostic", "container"] }],
    nodeStore,
  });
  return { coordinator, submitRun, createAttempt, transitionAttempt, markRunTerminal, setRunRunning, requestCancel };
}

function testBackend(outcome: "succeeded" | "failed"): WorkerBackend {
  return {
    kind: "test",
    async start(spec): Promise<WorkerHandle> {
      const backendRunId = `backend-${spec.runId}`;
      const result: WorkerResult = {
        runId: spec.runId,
        backendRunId,
        status: outcome,
        exitCode: outcome === "succeeded" ? 0 : 1,
        outputBytes: 0,
      };
      return {
        runId: spec.runId,
        backendRunId,
        state: () => "finished",
        cancel: async () => {},
        cleanup: async () => ({
          scratchRemoved: true,
          tempCredsRevoked: true,
          cgroupRemoved: true,
          networkRulesRemoved: true,
          imageLayersCleaned: true,
        }),
        wait: async () => result,
      };
    },
  };
}

function makeProvider(coordinator: RunCoordinator, backend: WorkerBackend): WorkerExecutionProvider {
  const lifecycle = createAttemptLifecycle(() => Promise.resolve(coordinator));
  return new WorkerExecutionProvider(new WorkerRuntime(backend), lifecycle);
}

async function submitLeaseAndStart(
  coordinator: RunCoordinator,
  provider: WorkerExecutionProvider,
  clientKey: string,
): Promise<string> {
  const now = Date.now();
  const { run, created } = await coordinator.submit({
    clientKey,
    actorId: "actor-1",
    spec: SPEC,
    correlationId: `req-${clientKey}`,
    now,
  });
  expect(created).toBe(true);
  await coordinator.acquireLease({ runId: run.runId, correlationId: `lease-${clientKey}`, now });
  const committed = (await coordinator.getState()).runs.find((r) => r.runId === run.runId);
  const dbRunId = committed?.dbRunId;
  expect(dbRunId).toBe("db-run-1");
  await provider.startRun({ ...DB_RUN_ROW, id: run.runId }, { requestId: `req-${clientKey}` });
  return run.runId;
}

describe("container run execution through the attempt lifecycle", () => {
  it("executes a submitted run to succeeded and mirrors terminal status to the node store", async () => {
    const { coordinator, createAttempt, markRunTerminal, setRunRunning } = await createHarness();
    const provider = makeProvider(coordinator, testBackend("succeeded"));

    const runId = await submitLeaseAndStart(coordinator, provider, "client-1");

    const committed = (await coordinator.getState()).runs.find((r) => r.runId === runId);
    expect(committed?.state).toBe("succeeded");
    expect(createAttempt).toHaveBeenCalled();
    expect(setRunRunning).toHaveBeenCalled();
    expect(markRunTerminal).toHaveBeenCalledWith("db-run-1", "succeeded", null);
  });

  it("keeps tenant quota available across six sequential submissions", async () => {
    const { coordinator } = await createHarness();
    const provider = makeProvider(coordinator, testBackend("succeeded"));

    for (let i = 0; i < 6; i++) {
      await submitLeaseAndStart(coordinator, provider, `client-${i}`);
    }

    const runs = (await coordinator.getState()).runs;
    expect(runs).toHaveLength(6);
    expect(runs.every((r) => r.state === "succeeded")).toBe(true);
  });

  it("mirrors a failed backend result to a failed run", async () => {
    const { coordinator, markRunTerminal } = await createHarness();
    const provider = makeProvider(coordinator, testBackend("failed"));

    const runId = await submitLeaseAndStart(coordinator, provider, "client-fail");

    const committed = (await coordinator.getState()).runs.find((r) => r.runId === runId);
    expect(committed?.state).toBe("failed");
    expect(markRunTerminal).toHaveBeenCalledWith("db-run-1", "failed", "failed");
  });
});
