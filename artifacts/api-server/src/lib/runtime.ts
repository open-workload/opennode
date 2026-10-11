import { randomBytes } from "node:crypto";
import { DrizzleNodeStore, NodeStoreIdentityKeystore } from "@workspace/node-store";
import {
  MembershipService,
  createClusterId,
  ensureNodeIdentity,
  assertNoNodeIdCollision,
} from "@workspace/opennode-domain";
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
import { createDeterministicSignatureScheme } from "@workspace/peernet";
import {
  DefaultRetentionPolicy,
  InMemoryAssignmentGate,
  InMemoryCapacityController,
  InMemoryCredentialRevoker,
  NodeLifecycleController,
  type DrainSummary,
  type SignedLeaveEvent,
} from "@workspace/node-lifecycle";
import {
  RunCoordinator,
  createInMemoryRunLedgerStore,
  type QuotaPolicy,
} from "@workspace/run-coordinator";
import {
  CgroupManager,
  IsolatedProcessBackend,
  RootlessBackend,
  WorkerExecutionProvider,
  WorkerRuntime,
  type WorkerEvent,
} from "@workspace/worker-runtime";
import { createSecretBroker, MemorySecretStore } from "@workspace/secret-broker";
import { FeatureFlags } from "@workspace/feature-flags";
import { logger } from "./logger";
import { createFaultInjectingBackend } from "./faultInjection";
import { resolveExecutionBackend } from "./executionBackend";

export const nodeStore = new DrizzleNodeStore();

const cgroupManager = new CgroupManager();
const selectedBackend = resolveExecutionBackend(process.env);
export const containerExecutionAvailable = selectedBackend.kind !== "isolated_process";

const workerBackend =
  selectedBackend.kind === "isolated_process"
    ? new IsolatedProcessBackend()
    : new RootlessBackend({
        kind: selectedBackend.kind,
        installPrefix: selectedBackend.installPrefix,
        rootfs: selectedBackend.rootfs,
        cgroupManager,
      });

const workerRuntime = new WorkerRuntime(createFaultInjectingBackend(workerBackend), {
  cgroupManager,
  onEvent: (event: WorkerEvent) => {
    if (event.type === "finished") {
      logger.info({ runId: event.runId, result: event.result }, "run finished");
      emitLogEntry(event.runId, {
        sequence: Date.now(),
        attempt: 1,
        stream: "system",
        message: `Run finished: ${event.result.status}`,
        timestamp: Date.now(),
      });
    }
  },
});

export const executionProvider = new WorkerExecutionProvider(workerRuntime);

const secretStore = new MemorySecretStore();
export const secretBroker = createSecretBroker(secretStore);

export const featureFlags = new FeatureFlags({ enableKillSwitch: true });

interface LogStreamEntry {
  sequence: number;
  attempt: number;
  stream: "stdout" | "stderr" | "system";
  message: string;
  timestamp: number;
}

const logStreamSubscriptions = new Map<string, Set<(entry: LogStreamEntry) => void>>();

export function subscribeToLogStream(runId: string, callback: (entry: LogStreamEntry) => void): () => void {
  const subs = logStreamSubscriptions.get(runId) ?? new Set();
  subs.add(callback);
  logStreamSubscriptions.set(runId, subs);
  return () => {
    subs.delete(callback);
    if (subs.size === 0) logStreamSubscriptions.delete(runId);
  };
}

export function emitLogEntry(runId: string, entry: LogStreamEntry): void {
  const subs = logStreamSubscriptions.get(runId);
  if (subs) {
    for (const cb of subs) {
      try { cb(entry); } catch {}
    }
  }
}

export interface ProposalMeta {
  readonly reason: string;
  readonly createdAt: Date;
  readonly targetNodeName: string | null;
}

export interface GovernanceRuntime {
  readonly clusterId: ReturnType<typeof createClusterId>;
  readonly clusterIdValue: string;
  readonly localNodeId: string;
  readonly signerNodeId: string;
  readonly localSecretKey: string;
  readonly scheme: ReturnType<typeof createDeterministicSignatureScheme>;
  readonly hsmSigner: ReturnType<typeof createHmacSigner>;
  readonly membershipService: MembershipService;
  readonly membershipLog: MembershipLog;
  readonly leases: MembershipLog["leases"];
  readonly lifecycle: NodeLifecycleController;
  readonly assignmentGate: InMemoryAssignmentGate;
  readonly credentials: InMemoryCredentialRevoker;
  readonly capacity: InMemoryCapacityController;
  readonly eventLog: EventLog;
  readonly proposalMeta: Map<string, ProposalMeta>;
  readonly ballots: Map<string, Map<string, "yes" | "no">>;
  readonly ballotRevisions: Map<string, Map<string, number>>;
  readonly publishedLeaveEvents: readonly SignedLeaveEvent[];
  readonly state: { leftLocalNode: boolean };
}

let governance: GovernanceRuntime | undefined;

export async function getGovernance(): Promise<GovernanceRuntime> {
  if (governance === undefined) {
    governance = await createGovernance();
  }
  return governance;
}

export function acceptsNewAssignments(): boolean {
  return governance === undefined ? true : governance.lifecycle.acceptsNewAssignments();
}

export function getFeatureFlags(): FeatureFlags {
  return featureFlags;
}

export const RUN_QUOTAS: QuotaPolicy = {
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

export const RUN_LEASE_TTL_MS = 30_000;

let runCoordinator: RunCoordinator | undefined;

export async function getRunCoordinator(): Promise<RunCoordinator> {
  if (runCoordinator !== undefined) return runCoordinator;
  const g = await getGovernance();
  runCoordinator = new RunCoordinator({
    clusterId: g.clusterId,
    eventLog: g.eventLog,
    signer: g.hsmSigner,
    membershipLog: g.membershipLog,
    nodeStore,
    store: createInMemoryRunLedgerStore(),
    quotas: RUN_QUOTAS,
    capabilities: [
      {
        nodeId: g.localNodeId,
        capabilities: ["diagnostic", ...(containerExecutionAvailable ? ["container"] : [])],
      },
    ],
    auditSink: {
      record(event) {
        void nodeStore
          .recordAudit({
            action: event.kind,
            detail: event.details as Record<string, unknown>,
            requestId: "run-coordinator",
          })
          .catch(() => undefined);
      },
    },
    featureFlags,
  });
  return runCoordinator;
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "starting", "running", "cancel_requested"]);

async function countActiveRuns(): Promise<number> {
  const page = await nodeStore.listRuns({ limit: 100 });
  return page.items.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).length;
}

async function createGovernance(): Promise<GovernanceRuntime> {
  const clusterId = createClusterId(process.env.OPENNODE_CLUSTER_ID ?? "local-cluster");
  const keystore = new NodeStoreIdentityKeystore();
  const identity = await ensureNodeIdentity(keystore, () => {
    const provided = process.env.OPENNODE_LOCAL_SECRET_KEY;
    return provided && provided.trim().length > 0 ? provided : randomBytes(32).toString("hex");
  });
  const stored = keystore.load();
  if (stored === undefined) {
    throw new Error("Node identity keystore was not populated during startup.");
  }
  const localNodeId = identity.nodeId.value;
  const localSecretKey = stored.secretKey;
  const signerNodeId = localNodeId;
  assertNoNodeIdCollision(await nodeStore.listNodeIdentities());
  const scheme = createDeterministicSignatureScheme();
  const hsmSigner = createHmacSigner(signerNodeId, localSecretKey);
  const eventLog = new EventLog(
    createInMemoryEventLogStore(),
    clusterId,
    createHmacVerifier({ [signerNodeId]: localSecretKey }),
  );
  const leaveVerifier = createDeterministicSignatureScheme();
  const membershipLogStore = createInMemoryMembershipLogStore();
  await membershipLogStore.save({
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
        await eventLog.appendEvent(entry.event, hsmSigner);
        return entry;
      },
      getHeight: () => eventLog.getHeight(),
      getEntry: (seq) => eventLog.getEntry(seq),
      getRange: (from, to) => eventLog.getRange(from, to),
      start: async () => {},
      stop: async () => {},
    },
    signer: hsmSigner,
    store: membershipLogStore,
    leaveVerifier,
  });
  const assignmentGate = new InMemoryAssignmentGate();
  const credentials = new InMemoryCredentialRevoker();
  const capacity = new InMemoryCapacityController();
  const drainer = {
    async drain(): Promise<DrainSummary> {
      const active = await countActiveRuns();
      return { activeAtStart: active, drained: active, relinquished: 0 };
    },
  };
  const publishedLeaveEvents: SignedLeaveEvent[] = [];
  const auditSink = {
    record(event: { readonly kind: string; readonly details: Readonly<Record<string, unknown>> }): void {
      void nodeStore
        .recordAudit({ action: event.kind, detail: event.details as Record<string, unknown>, requestId: "governance" })
        .catch(() => undefined);
    },
  };
  const lifecycle = new NodeLifecycleController({
    gate: assignmentGate,
    drainer,
    credentials,
    leases: {
      invalidate: async () => {
        const state = await membershipLog.getState();
        return membershipLog.leases.fenceOnEpochChange(state.epoch, Date.now()).length;
      },
    },
    capacity,
    retention: new DefaultRetentionPolicy(),
    leavePublisher: {
      publishSignedLeaveEvent: (event) => {
        publishedLeaveEvents.push(event);
      },
    },
    audit: auditSink,
  });
  const membershipService = new MembershipService({
    clusterId: clusterId.value,
    auditSink,
    initialMembers: [localNodeId],
    initialEpoch: 0,
  });
  return {
    clusterId,
    clusterIdValue: clusterId.value,
    localNodeId,
    signerNodeId,
    localSecretKey,
    scheme,
    hsmSigner,
    membershipService,
    membershipLog,
    leases: membershipLog.leases,
    lifecycle,
    assignmentGate,
    credentials,
    capacity,
    eventLog,
    proposalMeta: new Map(),
    ballots: new Map(),
    ballotRevisions: new Map(),
    publishedLeaveEvents,
    state: { leftLocalNode: false },
  };
}
