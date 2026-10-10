import { describe, expect, it } from "vitest";
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
  mode: "built-in-diagnostic",
  image: null,
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
  const coordinator = new RunCoordinator({
    clusterId,
    eventLog,
    signer,
    membershipLog,
    store: createInMemoryRunLedgerStore(),
    quotas: QUOTAS,
    capabilities: [{ nodeId: localNodeId, capabilities: ["diagnostic"] }],
  });
  return { coordinator, membershipLog };
}

async function submitAndLease(coordinator: RunCoordinator) {
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
  return { run, lease };
}

describe("RunCoordinator fencing-token lease safety", () => {
  it("rejects a renewal for an epoch-fenced lease removed from the committed registry", async () => {
    const { coordinator, membershipLog } = await createHarness();
    const { run, lease } = await submitAndLease(coordinator);

    const flushed = membershipLog.leases.fenceOnEpochChange(1, 1_000);
    expect(flushed.map((record) => record.leaseId)).toContain(lease.leaseId);

    await expect(
      coordinator.renewLease({
        request: {
          leaseId: lease.leaseId,
          runId: run.runId,
          attempt: lease.attempt,
          workerNodeId: lease.workerNodeId,
          fencingToken: lease.fencingToken,
          requestedAt: 1_000,
        },
        correlationId: "req-renew",
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
  });

  it("rejects a report presenting a stale fencing token for a committed lease", async () => {
    const { coordinator } = await createHarness();
    const { run, lease } = await submitAndLease(coordinator);

    await expect(
      coordinator.observeAttempt({
        report: {
          runId: run.runId,
          attempt: lease.attempt,
          workerNodeId: lease.workerNodeId,
          status: "running",
          reportedAt: 1_000,
          fencingToken: lease.fencingToken - 1,
        },
        correlationId: "req-stale",
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
  });

  it("renews a committed lease that is still present in the registry", async () => {
    const { coordinator } = await createHarness();
    const { run, lease } = await submitAndLease(coordinator);

    const renewed = await coordinator.renewLease({
      request: {
        leaseId: lease.leaseId,
        runId: run.runId,
        attempt: lease.attempt,
        workerNodeId: lease.workerNodeId,
        fencingToken: lease.fencingToken,
        requestedAt: 1_000,
      },
      correlationId: "req-renew",
      now: 1_000,
    });
    expect(renewed.fencingToken).toBeGreaterThan(lease.fencingToken);
  });

  it("rejects an attempt report for an epoch-fenced lease removed from the committed registry", async () => {
    const { coordinator, membershipLog } = await createHarness();
    const { run, lease } = await submitAndLease(coordinator);

    membershipLog.leases.fenceOnEpochChange(1, 1_000);

    await expect(
      coordinator.observeAttempt({
        report: {
          runId: run.runId,
          attempt: lease.attempt,
          workerNodeId: lease.workerNodeId,
          status: "running",
          reportedAt: 1_000,
          fencingToken: lease.fencingToken,
        },
        correlationId: "req-observe",
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "STALE_FENCING_TOKEN" });
  });
});
