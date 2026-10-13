import { describe, expect, it, vi } from "vitest";
import { createClusterId } from "@workspace/opennode-domain";
import {
  EventLog,
  createHmacSigner,
  createHmacVerifier,
  createInMemoryEventLogStore,
} from "@workspace/sync-engine";
import {
  MembershipLog,
  createInMemoryMembershipLogStore,
} from "@workspace/membership-log";
import type { NodeStore } from "@workspace/node-store";
import {
  RunCoordinator,
  createInMemoryRunLedgerStore,
  type QuotaPolicy,
  type RunSpec,
} from "./index";

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
  image: `busybox:1.36@sha256:${"a".repeat(64)}`,
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
  const nodeStore = {
    submitRun,
    createAttempt,
    transitionAttempt,
    markRunTerminal,
    setRunRunning,
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
  return {
    coordinator,
    submitRun,
    createAttempt,
    transitionAttempt,
    markRunTerminal,
    setRunRunning,
  };
}

describe("RunCoordinator node store mirror", () => {
  it("forwards the spec command to nodeStore.submitRun", async () => {
    const { coordinator, submitRun } = await createHarness();

    const { run } = await coordinator.submit({
      clientKey: "client-1",
      actorId: "actor-1",
      spec: SPEC,
      correlationId: "req-submit",
      now: 1_000,
    });

    expect(submitRun).toHaveBeenCalledTimes(1);
    expect(submitRun.mock.calls[0][0]).toMatchObject({
      name: SPEC.name,
      mode: "container",
      image: SPEC.image,
      command: SPEC.command,
    });
    expect(run.spec.command).toEqual(SPEC.command);
  });

  it("does not mirror a second idempotent submission", async () => {
    const { coordinator, submitRun } = await createHarness();
    const input = {
      clientKey: "client-1",
      actorId: "actor-1",
      spec: SPEC,
      correlationId: "req-submit",
      now: 1_000,
    };
    await coordinator.submit(input);
    await coordinator.submit(input);

    expect(submitRun).toHaveBeenCalledTimes(1);
  });

  it("mirrors attempt rows and the run row status from committed observations", async () => {
    const { coordinator, createAttempt, transitionAttempt, markRunTerminal, setRunRunning } =
      await createHarness();

    const { run } = await coordinator.submit({
      clientKey: "client-1",
      actorId: "actor-1",
      spec: SPEC,
      correlationId: "req-submit",
      now: 1_000,
    });
    const lease = await coordinator.acquireLease({
      runId: run.runId,
      correlationId: "req-lease",
      now: 1_000,
    });

    await coordinator.observeAttempt({
      report: {
        runId: run.runId,
        attempt: lease.attempt,
        workerNodeId: lease.workerNodeId,
        status: "running",
        reportedAt: 1_500,
        fencingToken: lease.fencingToken,
      },
      correlationId: "req-obs-running",
      now: 1_500,
    });

    expect(createAttempt).toHaveBeenCalledWith("db-run-1", {
      status: "running",
      workerNodeId: lease.workerNodeId,
    });
    expect(setRunRunning).toHaveBeenCalledWith("db-run-1", lease.workerNodeId);

    await coordinator.observeAttempt({
      report: {
        runId: run.runId,
        attempt: lease.attempt,
        workerNodeId: lease.workerNodeId,
        status: "succeeded",
        reportedAt: 2_000,
        fencingToken: lease.fencingToken,
      },
      correlationId: "req-obs-succeeded",
      now: 2_000,
    });

    expect(transitionAttempt).toHaveBeenCalledWith("db-attempt-1", "succeeded");
    expect(markRunTerminal).toHaveBeenCalledWith("db-run-1", "succeeded", null);
  });
});
