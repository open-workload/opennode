import { describe, expect, it } from "vitest";
import { metricsRegistry } from "@workspace/observability";
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

function makeSpec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
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
    ...overrides,
  };
}

/** Read an unlabelled sample value out of the shared exposition. */
function metricValue(name: string): number | undefined {
  for (const line of metricsRegistry.render().split("\n")) {
    if (line.startsWith(`${name} `)) return Number(line.slice(name.length + 1));
  }
  return undefined;
}

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
  return { coordinator };
}

describe("RunCoordinator OPS-03 metric producers", () => {
  it("increments run_coordinator.duplicate_submissions on an idempotent resubmission", async () => {
    const { coordinator } = await createHarness();
    const input = {
      clientKey: "client-dup",
      actorId: "actor-1",
      spec: makeSpec(),
      correlationId: "req-submit",
      now: 1_000,
    };

    const first = await coordinator.submit(input);
    expect(first.created).toBe(true);
    const before = metricValue("run_coordinator.duplicate_submissions") ?? 0;

    const second = await coordinator.submit(input);
    expect(second.created).toBe(false);
    expect(metricValue("run_coordinator.duplicate_submissions")).toBe(before + 1);
  });

  it("records queue age and lease TTL when a queued run is assigned", async () => {
    const { coordinator } = await createHarness();
    const { run } = await coordinator.submit({
      clientKey: "client-1",
      actorId: "actor-1",
      spec: makeSpec(),
      correlationId: "req-submit",
      now: 1_000,
    });

    await coordinator.acquireLease({
      runId: run.runId,
      correlationId: "req-lease",
      now: 5_000,
    });

    expect(metricValue("run_coordinator.queue_age_ms")).toBe(4_000);
    expect(metricValue("run_coordinator.lease_ttl_ms")).toBe(30_000);
  });

  it("updates run_coordinator.lease_ttl_ms on renewal", async () => {
    const { coordinator } = await createHarness();
    const { run } = await coordinator.submit({
      clientKey: "client-1",
      actorId: "actor-1",
      spec: makeSpec({ resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 20 } }),
      correlationId: "req-submit",
      now: 1_000,
    });
    const lease = await coordinator.acquireLease({
      runId: run.runId,
      correlationId: "req-lease",
      now: 1_000,
    });
    expect(metricValue("run_coordinator.lease_ttl_ms")).toBe(20_000);

    await coordinator.renewLease({
      request: {
        leaseId: lease.leaseId,
        runId: run.runId,
        attempt: lease.attempt,
        workerNodeId: lease.workerNodeId,
        fencingToken: lease.fencingToken,
        requestedAt: 6_000,
      },
      correlationId: "req-renew",
      now: 6_000,
    });

    expect(metricValue("run_coordinator.lease_ttl_ms")).toBe(15_000);
  });
});
