import {
  ClusterId,
  createClusterId,
  createNodeId,
  NodeId,
  SCHEMA_VERSION,
  createClusterEvent,
  deriveNodeIdFromSecretKey,
} from "@workspace/opennode-domain";
import {
  createInMemoryEventLogStore,
  createInMemoryCheckpointStore,
  EventLog,
  Signer,
  SignatureVerifier,
  createHmacSigner,
  createHmacVerifier,
  SignedLogEntry,
} from "@workspace/sync-engine";
import {
  createInMemoryMembershipLogStore,
  MembershipLog,
  CommittedMembershipState,
  CommittedAdmissionPayload,
  CommittedEvictionPayload,
  CommittedLeavePayload,
  MEMBERSHIP_ADMISSION_KIND,
  MEMBERSHIP_EVICTION_KIND,
  MEMBERSHIP_LEAVE_KIND,
  applyMembershipEntry,
  LeaseRegistry,
  LeaseRecord,
} from "@workspace/membership-log";
import {
  FeatureFlags,
} from "@workspace/feature-flags";
import {
  NodeLifecycleController,
  InMemoryAssignmentGate,
  InMemoryCapacityController,
  InMemoryCredentialRevoker,
  DefaultRetentionPolicy,
  LifecycleCause,
} from "@workspace/node-lifecycle";
import { createDeterministicSignatureScheme } from "@workspace/peernet";
import assert from "node:assert/strict";

const CLUSTER_ID = createClusterId("test-cluster");
const NODE_A_SECRET = "node-a-secret-key-12345678901234567890123456789012";
const NODE_B_SECRET = "node-b-secret-key-12345678901234567890123456789012";

function deriveNodeId(secret: string): NodeId {
  return createNodeId(deriveNodeIdFromSecretKey(secret));
}

const NODE_A = deriveNodeId(NODE_A_SECRET);
const NODE_B = deriveNodeId(NODE_B_SECRET);

const verifier = createHmacVerifier({
  [NODE_A.value]: NODE_A_SECRET,
  [NODE_B.value]: NODE_B_SECRET,
});

const signerA = createHmacSigner(NODE_A.value, NODE_A_SECRET);
const signerB = createHmacSigner(NODE_B.value, NODE_B_SECRET);

const sigScheme = createDeterministicSignatureScheme();

const eventLogStore = createInMemoryEventLogStore();
const checkpointStore = createInMemoryCheckpointStore();
const eventLog = new EventLog(eventLogStore, CLUSTER_ID, verifier);

const membershipLogStore = createInMemoryMembershipLogStore();
const leaseRegistry = new LeaseRegistry();

const membershipLog = new MembershipLog({
  clusterId: CLUSTER_ID,
  consensusLog: {
    isLeader: () => true,
    getLeaderId: () => NODE_A.value,
    propose: async (entry) => {
      await eventLog.appendEvent(entry.event, signerA);
      return entry;
    },
    getHeight: () => eventLog.getHeight(),
    getEntry: (seq) => eventLog.getEntry(seq),
    getRange: (from, to) => eventLog.getRange(from, to),
    start: async () => {},
    stop: async () => {},
  },
  signer: signerA,
  store: membershipLogStore,
  leaveVerifier: sigScheme,
  leases: leaseRegistry,
});

const ff = new FeatureFlags({
  enableKillSwitch: true,
});

const assignmentGate = new InMemoryAssignmentGate();
const capacityController = new InMemoryCapacityController();
const credentialRevoker = new InMemoryCredentialRevoker();
const retentionPolicy = new DefaultRetentionPolicy();

const nodeLifecycle = new NodeLifecycleController({
  gate: assignmentGate,
  drainer: {
    drain() {
      return { activeAtStart: 0, drained: 0, relinquished: 0 };
    },
  },
  credentials: credentialRevoker,
  leases: {
    invalidate(subjectId: string, _cause: LifecycleCause, _now: number) {
      return leaseRegistry.fenceOnEpochChange(1, Date.now()).filter((l: LeaseRecord) => l.workerNodeId === subjectId).length;
    },
  },
  capacity: capacityController,
  retention: retentionPolicy,
  audit: {
    record(event: { kind: string; details: Record<string, unknown> }) {
      console.log(`[AUDIT] ${event.kind}:`, event.details);
    },
  },
});

async function runSmokeTest() {
  console.log("=== Starting Smoke Test ===\n");

  // 1. 2-PEER JOIN (bootstrap Node A, then admit Node B)
  console.log("--- 1. 2-Peer Join ---");
  let state = await membershipLog.getState();
  console.log(`Initial state: epoch=${state.epoch}, members=${state.memberIds.join(", ") || "(none)"}`);

  // Bootstrap: admit Node A as first member (single-node cluster, electorate=1)
  await membershipLog.commitAdmission({
    proposalId: "admit-node-a",
    subjectId: NODE_A.value,
    newEpoch: 1,
    electorateDenominator: 1,
    threshold: 1,
    yesVotes: 1,
    eventId: "evt-admit-0",
    correlationId: "corr-admit-0",
    now: Date.now(),
  });

  const admissionEntry = await membershipLog.commitAdmission({
    proposalId: "admit-node-b",
    subjectId: NODE_B.value,
    newEpoch: 2,
    electorateDenominator: 1,
    threshold: 1,
    yesVotes: 1,
    eventId: "evt-admit-1",
    correlationId: "corr-admit-1",
    now: Date.now(),
  });
  console.log(`Admitted ${NODE_B.value}, entry hash: ${admissionEntry.hash.slice(0, 16)}...`);

  state = await membershipLog.getState();
  console.log(`State after admission: epoch=${state.epoch}, members=${state.memberIds.join(", ")}`);
  assert(state.memberIds.includes(NODE_A.value), "Node A should be member");
  assert(state.memberIds.includes(NODE_B.value), "Node B should be member");
  console.log("✓ 2-Peer Join passed\n");

  // 2. MEMBERSHIP CHANGE (add a third node for testing, then remove)
  console.log("--- 2. Membership Change (Add/Remove) ---");
  const NODE_C_SECRET = "node-c-secret-key-12345678901234567890123456789012";
  const NODE_C = deriveNodeId(NODE_C_SECRET);

  const admissionC = await membershipLog.commitAdmission({
    proposalId: "admit-node-c",
    subjectId: NODE_C.value,
    newEpoch: 3,
    electorateDenominator: 2,
    threshold: 2,
    yesVotes: 2,
    eventId: "evt-admit-2",
    correlationId: "corr-admit-2",
    now: Date.now(),
  });
  console.log(`Admitted ${NODE_C.value}, entry hash: ${admissionC.hash.slice(0, 16)}...`);

  state = await membershipLog.getState();
  console.log(`State after adding C: epoch=${state.epoch}, members=${state.memberIds.join(", ")}`);
  assert(state.memberIds.length === 3, "Should have 3 members");
  console.log("✓ Membership add passed\n");

  // 3. RUN SUBMISSION
  console.log("--- 3. Run Submission ---");
  const runId = "run-smoke-001";
  const attempt = 1;
  const lease: LeaseRecord = {
    leaseId: `lease-${runId}-${attempt}`,
    runId,
    attempt,
    workerNodeId: NODE_B.value,
    membershipEpoch: state.epoch,
    expiresAt: Date.now() + 60000,
  };
  leaseRegistry.add(lease);
  console.log(`Submitted run ${runId}, lease bound to epoch ${state.epoch}, worker ${NODE_B.value}`);
  console.log("✓ Run Submission passed\n");

  // 4. EXECUTION (simulated via lease check)
  console.log("--- 4. Execution (Lease Validation) ---");
  const isStale = (lease: LeaseRecord, epoch: number, now: number) =>
    lease.membershipEpoch !== epoch || lease.expiresAt <= now;
  assert(!isStale(lease, state.epoch, Date.now()), "Lease should be valid");
  console.log(`Lease valid for epoch ${state.epoch}: true`);
  console.log("✓ Execution (lease check) passed\n");

  // 5. LOGS (simulated via event log append)
  console.log("--- 5. Logs ---");
  const logEvent = createClusterEvent({
    eventId: "evt-log-1",
    clusterId: CLUSTER_ID,
    sequence: await eventLog.getHeight(),
    epoch: state.epoch,
    kind: "run.log",
    correlationId: runId,
    payload: { runId, attempt, stream: "stdout", content: "Hello from worker" },
  });
  await eventLog.appendEvent(logEvent, signerA);
  console.log(`Appended log event, log height: ${await eventLog.getHeight()}`);
  console.log("✓ Logs passed\n");

  // 6. CANCELLATION
  console.log("--- 6. Cancellation ---");
  const cancelEvent = createClusterEvent({
    eventId: "evt-cancel-1",
    clusterId: CLUSTER_ID,
    sequence: await eventLog.getHeight(),
    epoch: state.epoch,
    kind: "run.cancel",
    correlationId: runId,
    payload: { runId, reason: "user requested" },
  });
  await eventLog.appendEvent(cancelEvent, signerA);
  leaseRegistry.remove(lease.leaseId);
  console.log(`Cancelled run ${runId}, lease removed`);
  console.log("✓ Cancellation passed\n");

  // 7. LEAVE (Node C leaves voluntarily)
  console.log("--- 7. Voluntary Leave ---");
  await membershipLog.commitLeave({
    proposalId: "leave-node-c",
    memberId: NODE_C.value,
    secretKey: NODE_C_SECRET,
    signerNodeId: NODE_C.value,
    scheme: sigScheme,
    eventId: "evt-leave-1",
    correlationId: "corr-leave-1",
    now: Date.now(),
  });
  state = await membershipLog.getState();
  console.log(`State after C leaves: epoch=${state.epoch}, members=${state.memberIds.join(", ")}`);
  assert(!state.memberIds.includes(NODE_C.value), "Node C should be removed");
  assert(state.memberIds.length === 2, "Should have 2 members");
  console.log("✓ Voluntary Leave passed\n");

  // 8. EVICTION (Node B evicted)
  console.log("--- 8. Eviction ---");
  const evictionEntry = await membershipLog.commitEviction({
    proposalId: "evict-node-b",
    subjectId: NODE_B.value,
    newEpoch: state.epoch + 1,
    electorateDenominator: 2,
    threshold: 1,
    yesVotes: 1,
    eventId: "evt-evict-1",
    correlationId: "corr-evict-1",
    now: Date.now(),
  });
  console.log(`Evicted ${NODE_B.value}, entry hash: ${evictionEntry.hash.slice(0, 16)}...`);

  state = await membershipLog.getState();
  console.log(`State after eviction: epoch=${state.epoch}, members=${state.memberIds.join(", ")}`);
  assert(!state.memberIds.includes(NODE_B.value), "Node B should be removed");
  assert(state.memberIds.length === 1, "Should have 1 member");

  // Test lease fencing on epoch change
  const fencedLeases = membershipLog.leases.fenceOnEpochChange(state.epoch, Date.now());
  console.log(`Fenced ${fencedLeases.length} stale leases`);

  // Test node lifecycle eviction handling
  const lifecycleReport = await nodeLifecycle.handleEviction({
    subjectId: NODE_B.value,
    epoch: state.epoch,
  });
  console.log(`Lifecycle report: stoppedAssignments=${lifecycleReport.stoppedNewAssignments}, quarantined=${lifecycleReport.capacityQuarantined}, credentialsRevoked=${lifecycleReport.credentialsRevoked}`);
  assert(lifecycleReport.capacityQuarantined, "Node should be quarantined");
  assert(lifecycleReport.credentialsRevoked, "Credentials should be revoked");
  console.log("✓ Eviction passed\n");

  // FEATURE FLAGS KILL SWITCH TEST
  console.log("--- Feature Flags Kill Switch ---");
  assert(ff.isNewExecutionAllowed() === true, "Should allow new runs initially");
  ff.activateKillSwitch("emergency", "operator-1");
  assert(ff.isNewExecutionAllowed() === false, "Kill switch should block new runs");
  console.log("Kill switch activated, new runs blocked");
  ff.deactivateKillSwitch();
  assert(ff.isNewExecutionAllowed() === true, "Should allow new runs after deactivate");
  console.log("✓ Feature Flags Kill Switch passed\n");

  // RECONCILIATION TEST
  console.log("--- Reconciliation ---");
  const reconciled = await membershipLog.reconcile(Date.now());
  console.log(`Reconciled state: epoch=${reconciled.epoch}, members=${reconciled.memberIds.join(", ")}`);
  assert(reconciled.epoch === state.epoch, "Reconciled epoch should match");
  console.log("✓ Reconciliation passed\n");

  console.log("=== ALL SMOKE TESTS PASSED ===");
}

runSmokeTest().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});