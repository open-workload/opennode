/**
 * Owns one committed run from submission through lease, report, and cleanup.
 *
 *   submit ──▶ run.submitted ──▶ queued
 *   acquireLease ──▶ run.lease_granted ──▶ scheduled  (fencing token = log height)
 *   observeAttempt ──▶ run.attempt_observed ──▶ running / terminal
 *   renewLease ──▶ run.lease_renewed
 *   cancel / retry ──▶ run.cancel_requested | run.retry_requested
 *   reconcile ──▶ run.attempt_fenced ──▶ lost ──▶ queued (retryable)
 *        │
 *        └──▶ metricsRegistry: duplicate_submissions, queue_age_ms, lease_ttl_ms
 *
 *   applyFromLog replays the committed event log; the log is authoritative.
 */
import { metricsRegistry } from "@workspace/observability";
import {
  ClusterId,
  ClusterEvent,
  createClusterEvent,
} from "@workspace/opennode-domain";
import {
  EventLog,
  SignedLogEntry,
  Signer,
} from "@workspace/sync-engine";
import { MembershipLog } from "@workspace/membership-log";
import type { NodeStore } from "@workspace/node-store";
import { RunCoordinatorError } from "./errors";
import {
  ValidatedRunSpec,
  QuotaPolicy,
  RunSpec,
  validateRunSpec,
  SideEffectClass,
} from "./policy";
import { deriveRunId, deriveAttemptId, computeRunPayloadHash } from "./identity";
import { selectCandidate, NodeCapability } from "./candidates";
import {
  CommittedLease,
  registerInMembershipRegistry,
  computeLeaseTtl,
  LEASE_RENEWAL_INTERVAL_MS,
  MAX_LEASE_TTL_MS,
  LeaseRenewalRequest,
  validateLeaseRenewalRequest,
  LeaseRenewalResult,
  isCommittedLeaseUsable,
  compareFencingTokens,
  isFreshFencingToken,
} from "./leases";
import {
  RUN_ATTEMPT_FENCED_KIND,
  RUN_ATTEMPT_OBSERVED_KIND,
  RUN_CANCEL_REQUESTED_KIND,
  RUN_LEASE_GRANTED_KIND,
  RUN_LEASE_RENEWED_KIND,
  RUN_RETRY_REQUESTED_KIND,
  RUN_SUBMITTED_KIND,
  AttemptFencedPayload,
  isRunKind,
  RunLeaseRenewedPayload,
} from "./events";
import { FeatureFlags, type FlagEvaluationContext } from "@workspace/feature-flags";

export type AttemptStatus =
  | "scheduled"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "infrastructure_error"
  | "lost";

export type RunStatus =
  | "queued"
  | "scheduled"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "needs_attention";

export interface TenantQuotaUsage {
  readonly tenantId: string;
  readonly projectId: string;
  readonly queuedRuns: number;
  readonly runningRuns: number;
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly diskMiB: number;
}

export interface AttemptRecord {
  readonly runId: string;
  readonly attempt: number;
  readonly attemptId: string;
  readonly leaseId: string | null;
  readonly workerNodeId: string | null;
  readonly membershipEpoch: number | null;
  readonly expiresAt: number | null;
  readonly fencingToken: number | null;
  readonly status: AttemptStatus;
  readonly reportCount: number;
  readonly lastReportedAt: number | null;
  readonly fencedReason: string | null;
  readonly renewCount: number;
  readonly renewedAt: number | null;
  readonly grantedAt: number | null;
  readonly dbAttemptId?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly clusterId: string;
  readonly actorId: string;
  readonly clientKey: string;
  readonly payloadHash: string;
  readonly spec: RunSpec;
  readonly state: RunStatus;
  readonly createdAt: number;
  readonly cancelRequestedAt: number | null;
  readonly cancelledBy: string | null;
  readonly terminalReason: string | null;
  readonly duplicateReports: number;
  readonly conflictingSubmissions: number;
  readonly dbRunId?: string;
}

export interface AttemptReport {
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly status:
    | "starting"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "timed_out"
    | "infrastructure_error";
  readonly reportedAt: number;
  readonly fencingToken: number;
  readonly note?: string;
}

export interface CoordinatedState {
  readonly clusterId: string;
  readonly appliedSequence: number;
  readonly runs: readonly RunRecord[];
  readonly attempts: readonly AttemptRecord[];
}

export interface RunLedgerStore {
  load(): Promise<CoordinatedState | undefined>;
  save(state: CoordinatedState): Promise<void>;
}

export function createInMemoryRunLedgerStore(): RunLedgerStore {
  let state: CoordinatedState | undefined;
  return {
    async load() {
      return state;
    },
    async save(next) {
      state = Object.freeze({
        ...next,
        runs: Object.freeze([...next.runs]),
        attempts: Object.freeze([...next.attempts]),
      });
    },
  };
}

export interface ReconcileInput {
  readonly now: number;
  readonly peerClaims?: readonly {
    readonly clusterId: string;
    readonly epoch: number;
    readonly memberIds: readonly string[];
    readonly height: number;
    readonly tipHash: string | null;
  }[];
}

export interface ReconcileSummary {
  readonly fencedAttemptCount: number;
  readonly fencedAttempts: readonly {
    runId: string;
    attempt: number;
    reason: string;
  }[];
  readonly conflictingAssignments: readonly {
    runId: string;
    attempt: number;
    localLeaseId: string;
    remoteLeaseId: string;
    localWorker: string;
    remoteWorker: string;
  }[];
}

export interface RunAuditSink {
  record(event: {
    readonly kind: string;
    readonly details: Readonly<Record<string, unknown>>;
  }): void;
}

const TERMINAL_ATTEMPT_STATUSES = new Set<AttemptStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "infrastructure_error",
  "lost",
]);

const ACTIVE_ATTEMPT_STATUSES = new Set<AttemptStatus>([
  "scheduled",
  "starting",
  "running",
]);

function isTerminalRunState(state: RunStatus): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "interrupted" ||
    state === "needs_attention"
  );
}

/** Reconstruct the committed lease carried by an attempt record. Returns
 *  undefined when the attempt never held a fully committed lease. */
function toCommittedLease(attempt: AttemptRecord): CommittedLease | undefined {
  if (
    attempt.leaseId === null ||
    attempt.workerNodeId === null ||
    attempt.membershipEpoch === null ||
    attempt.expiresAt === null ||
    attempt.fencingToken === null ||
    attempt.grantedAt === null
  ) {
    return undefined;
  }
  return {
    leaseId: attempt.leaseId,
    runId: attempt.runId,
    attempt: attempt.attempt,
    workerNodeId: attempt.workerNodeId,
    membershipEpoch: attempt.membershipEpoch,
    expiresAt: attempt.expiresAt,
    fencingToken: attempt.fencingToken,
    grantedAt: attempt.grantedAt,
    renewedAt: attempt.renewedAt ?? attempt.grantedAt,
    renewCount: attempt.renewCount,
  };
}

/** Distinguish an older (stale) token from a token minted for another lease. */
function describeFencingTokenMismatch(
  presented: number,
  committed: CommittedLease,
  context: string,
): string {
  const order = compareFencingTokens(
    { ...committed, fencingToken: presented },
    committed,
  );
  return order < 0
    ? `${context} carries a stale fencing token.`
    : `${context} carries a fencing token for a different lease.`;
}

export class RunCoordinator {
  private readonly clusterId: ClusterId;
  private readonly eventLog: EventLog;
  private readonly signer: Signer;
  private readonly membershipLog: MembershipLog;
  private readonly store: RunLedgerStore;
  private readonly quotas: QuotaPolicy;
  private readonly capabilities: readonly NodeCapability[];
  private readonly nodeStore?: NodeStore;
  private readonly auditSink?: RunAuditSink;
  private readonly featureFlags?: FeatureFlags;

  constructor(deps: {
    readonly clusterId: ClusterId;
    readonly eventLog: EventLog;
    readonly signer: Signer;
    readonly membershipLog: MembershipLog;
    readonly store: RunLedgerStore;
    readonly quotas: QuotaPolicy;
    readonly capabilities: readonly NodeCapability[];
    readonly nodeStore?: NodeStore;
    readonly auditSink?: RunAuditSink;
    readonly featureFlags?: FeatureFlags;
  }) {
    this.clusterId = deps.clusterId;
    this.eventLog = deps.eventLog;
    this.signer = deps.signer;
    this.membershipLog = deps.membershipLog;
    this.store = deps.store;
    this.quotas = deps.quotas;
    this.capabilities = deps.capabilities;
    if (deps.nodeStore !== undefined) this.nodeStore = deps.nodeStore;
    if (deps.auditSink !== undefined) this.auditSink = deps.auditSink;
    if (deps.featureFlags !== undefined) this.featureFlags = deps.featureFlags;
  }

  async getState(): Promise<CoordinatedState> {
    const stored = await this.store.load();
    if (stored !== undefined) return stored;
    return Object.freeze({
      clusterId: this.clusterId.value,
      appliedSequence: 0,
      runs: Object.freeze([] as RunRecord[]),
      attempts: Object.freeze([] as AttemptRecord[]),
    });
  }

  /** Validate the spec itself plus the current concurrency quota. */
  async validate(spec: RunSpec): Promise<ValidatedRunSpec> {
    const validated = validateRunSpec(spec, this.quotas);
    const state = await this.getState();
    const tenantUsage = this.computeTenantUsage(state, validated.tenantId, validated.projectId);
    if (!this.checkTenantQuota(tenantUsage, validated)) {
      throw new RunCoordinatorError("QUOTA_EXCEEDED", "Tenant quota exceeded.");
    }
    const maxConcurrent = this.getMaxConcurrentRuns({});
    if (tenantUsage.runningRuns + tenantUsage.queuedRuns >= maxConcurrent) {
      throw new RunCoordinatorError("QUOTA_EXCEEDED", "Concurrency quota reached.");
    }
    return validated;
  }

  private getFlagContext(): FlagEvaluationContext {
    return {
      clusterId: this.clusterId.value,
    };
  }

  private getMaxConcurrentRuns(context: FlagEvaluationContext): number {
    if (this.featureFlags) {
      return this.featureFlags.getMaxConcurrentRuns(context);
    }
    return this.quotas.maxConcurrentRuns;
  }

  private isNewExecutionAllowed(context: FlagEvaluationContext): boolean {
    if (this.featureFlags) {
      return this.featureFlags.isNewExecutionAllowed(context);
    }
    return true;
  }

  private computeTenantUsage(
    state: CoordinatedState,
    tenantId: string,
    projectId: string,
  ): TenantQuotaUsage {
    let queuedRuns = 0;
    let runningRuns = 0;
    let cpuMilli = 0;
    let memoryMiB = 0;
    let diskMiB = 0;

    for (const run of state.runs) {
      if (run.spec.tenantId !== tenantId || run.spec.projectId !== projectId) continue;
      if (run.state === "queued" || run.state === "scheduled") {
        queuedRuns++;
        cpuMilli += run.spec.resources.cpuMilli;
        memoryMiB += run.spec.resources.memoryMiB;
        diskMiB += run.spec.resources.diskMiB;
      } else if (run.state === "running") {
        runningRuns++;
        cpuMilli += run.spec.resources.cpuMilli;
        memoryMiB += run.spec.resources.memoryMiB;
        diskMiB += run.spec.resources.diskMiB;
      }
    }

    return { tenantId, projectId, queuedRuns, runningRuns, cpuMilli, memoryMiB, diskMiB };
  }

  private checkTenantQuota(usage: TenantQuotaUsage, spec: RunSpec): boolean {
    if (usage.queuedRuns + usage.runningRuns >= this.quotas.maxConcurrentRunsPerTenant) {
      return false;
    }
    if (usage.cpuMilli + spec.resources.cpuMilli > this.quotas.maxCpuMilliPerTenant) {
      return false;
    }
    if (usage.memoryMiB + spec.resources.memoryMiB > this.quotas.maxMemoryMiBPerTenant) {
      return false;
    }
    if (usage.diskMiB + spec.resources.diskMiB > this.quotas.maxDiskMiBPerTenant) {
      return false;
    }
    return true;
  }

  /**
   * Deterministic run identity: SHA-256(clusterId + actorId + clientKey + payloadHash)
   * so duplicate submissions through different peers deduplicate.
   */
  async submit(input: {
    readonly clientKey: string;
    readonly actorId: string;
    readonly spec: RunSpec;
    readonly correlationId: string;
    readonly now: number;
  }): Promise<{ readonly run: RunRecord; readonly created: boolean }> {
    const flagContext = this.getFlagContext();
    if (!this.isNewExecutionAllowed(flagContext)) {
      throw new RunCoordinatorError("EXECUTION_DISABLED", "New run submissions are disabled by feature flag or kill switch.");
    }
    const validated = validateRunSpec(input.spec, this.quotas);
    const state = await this.getState();
    const tenantUsage = this.computeTenantUsage(state, validated.tenantId, validated.projectId);
    if (!this.checkTenantQuota(tenantUsage, validated)) {
      throw new RunCoordinatorError("QUOTA_EXCEEDED", "Tenant quota exceeded.");
    }
    const maxConcurrent = this.getMaxConcurrentRuns(flagContext);
    if (tenantUsage.runningRuns + tenantUsage.queuedRuns >= maxConcurrent) {
      throw new RunCoordinatorError("QUOTA_EXCEEDED", "Concurrency quota reached.");
    }
    const payloadHash = computeRunPayloadHash(validated);
    const runId = deriveRunId({
      clusterId: this.clusterId.value,
      actorId: input.actorId,
      clientKey: input.clientKey,
      payloadHash,
    });
    const existing = state.runs.find((r) => r.runId === runId);
    if (existing !== undefined) {
      if (existing.payloadHash === payloadHash) {
        metricsRegistry.increment("run_coordinator.duplicate_submissions");
        return { run: existing, created: false };
      }
      throw new RunCoordinatorError(
        "IDEMPOTENCY_CONFLICT",
        "Same client key submitted a different run spec.",
      );
    }
    const height = await this.eventLog.getHeight();
    const membershipEpoch = (await this.membershipLog.getState()).epoch;
    const payload = {
      type: "run.submitted" as const,
      runId,
      clusterId: this.clusterId.value,
      actorId: input.actorId,
      clientKey: input.clientKey,
      payloadHash,
      spec: validated,
      createdAt: input.now,
    };
    const event = createClusterEvent({
      eventId: `evt-${runId}-submitted`,
      clusterId: this.clusterId,
      sequence: height,
      epoch: membershipEpoch,
      kind: RUN_SUBMITTED_KIND,
      correlationId: input.correlationId,
      payload,
    });
    await this.eventLog.appendEvent(event, this.signer);
    await this.applyFromLog();
    const next = await this.getState();
    const run = next.runs.find((r) => r.runId === runId);
    if (run === undefined) {
      throw new RunCoordinatorError("RUN_NOT_FOUND", "Run not committed.");
    }
    await this.mirrorNodeStore(run, "submit");
    this.auditSink?.record({
      kind: "run.submitted",
      details: {
        runId,
        clientKey: input.clientKey,
        actorId: input.actorId,
      },
    });
    return { run, created: true };
  }

  async cancel(input: {
    readonly runId: string;
    readonly cancelledBy: string;
    readonly correlationId: string;
    readonly now: number;
  }): Promise<RunRecord> {
    const state = await this.getState();
    const run = this.requireRun(state, input.runId);
    if (isTerminalRunState(run.state)) {
      throw new RunCoordinatorError("RUN_TERMINAL", "Run is terminal.");
    }
    const height = await this.eventLog.getHeight();
    const membershipEpoch = (await this.membershipLog.getState()).epoch;
    await this.eventLog.appendEvent(
      createClusterEvent({
        eventId: `evt-${input.runId}-cancel-${height}`,
        clusterId: this.clusterId,
        sequence: height,
        epoch: membershipEpoch,
        kind: RUN_CANCEL_REQUESTED_KIND,
        correlationId: input.correlationId,
        payload: {
          type: "run.cancel_requested" as const,
          runId: input.runId,
          cancelledBy: input.cancelledBy,
          requestedAt: input.now,
        },
      }),
      this.signer,
    );
    await this.applyFromLog();
    const next = await this.getState();
    const updated = next.runs.find((r) => r.runId === input.runId);
    await this.mirrorNodeStore(updated, "cancel");
    return this.requireRun(next, input.runId);
  }

  async retry(input: {
    readonly runId: string;
    readonly retryBy: string;
    readonly correlationId: string;
    readonly now: number;
  }): Promise<RunRecord> {
    const flagContext = this.getFlagContext();
    if (!this.isNewExecutionAllowed(flagContext)) {
      throw new RunCoordinatorError("EXECUTION_DISABLED", "Run retry is disabled by feature flag or kill switch.");
    }
    const state = await this.getState();
    const run = this.requireRun(state, input.runId);
    if (run.state !== "failed" && run.state !== "queued" && run.state !== "interrupted" && run.state !== "needs_attention") {
      throw new RunCoordinatorError(
        "RUN_NOT_RETRYABLE",
        "Only failed, queued, interrupted, or needs_attention runs can be retried.",
      );
    }
    if (run.state === "queued") {
      const active = state.attempts.some(
        (a) => a.runId === input.runId && ACTIVE_ATTEMPT_STATUSES.has(a.status),
      );
      if (active) {
        throw new RunCoordinatorError(
          "RUN_NOT_RETRYABLE",
          "Run already has an active attempt.",
        );
      }
    }
    const attemptsForRun = state.attempts.filter(
      (a) => a.runId === input.runId,
    ).length;
    if (attemptsForRun >= this.quotas.maxAttempts) {
      throw new RunCoordinatorError(
        "QUOTA_EXCEEDED",
        "Max attempts exhausted.",
      );
    }
    const tenantUsage = this.computeTenantUsage(state, run.spec.tenantId, run.spec.projectId);
    if (!this.checkTenantQuota(tenantUsage, run.spec)) {
      throw new RunCoordinatorError("QUOTA_EXCEEDED", "Tenant quota exceeded on retry.");
    }
    const maxConcurrent = this.getMaxConcurrentRuns(flagContext);
    if (tenantUsage.runningRuns + tenantUsage.queuedRuns >= maxConcurrent) {
      throw new RunCoordinatorError("QUOTA_EXCEEDED", "Concurrency quota reached on retry.");
    }
    if (run.spec.sideEffectClass !== "idempotent") {
      const nonTerminalAttempts = state.attempts.filter(
        (a) => a.runId === input.runId && !TERMINAL_ATTEMPT_STATUSES.has(a.status),
      );
      if (nonTerminalAttempts.length > 0) {
        throw new RunCoordinatorError(
          "RUN_NOT_RETRYABLE",
          "Non-idempotent run has non-terminal attempts; cannot retry.",
        );
      }
      const activeLeases = state.attempts.filter(
        (a) =>
          a.runId === input.runId &&
          a.expiresAt !== null &&
          a.expiresAt > input.now,
      );
      if (activeLeases.length > 0) {
        throw new RunCoordinatorError(
          "LEASE_CONFLICT",
          "Non-idempotent run has unexpired leases; cannot retry.",
        );
      }
    }
    const height = await this.eventLog.getHeight();
    const membershipEpoch = (await this.membershipLog.getState()).epoch;
    await this.eventLog.appendEvent(
      createClusterEvent({
        eventId: `evt-${input.runId}-retry-${height}`,
        clusterId: this.clusterId,
        sequence: height,
        epoch: membershipEpoch,
        kind: RUN_RETRY_REQUESTED_KIND,
        correlationId: input.correlationId,
        payload: {
          type: "run.retry_requested" as const,
          runId: input.runId,
          retryBy: input.retryBy,
          requestedAt: input.now,
        },
      }),
      this.signer,
    );
    await this.applyFromLog();
    return this.requireRun(await this.getState(), input.runId);
  }

  /**
   * Committed lease acquisition. Candidate selection uses rendezvous hashing
   * over eligible committed members, but execution requires this committed
   * lease plus fencing token. New assignments are refused while the local
   * committed view is behind or diverged relative to a peer claim — an
   * isolated minority can never mint a conflicting exclusive assignment.
   * TTL = min(30s, remaining run duration). Quorum required.
   */
  async acquireLease(input: {
    readonly runId: string;
    readonly correlationId: string;
    readonly now: number;
    readonly peerClaim?: {
      readonly clusterId: string;
      readonly epoch: number;
      readonly memberIds: readonly string[];
      readonly height: number;
      readonly tipHash: string | null;
    };
  }): Promise<CommittedLease> {
    const flagContext = this.getFlagContext();
    if (!this.isNewExecutionAllowed(flagContext)) {
      throw new RunCoordinatorError("EXECUTION_DISABLED", "New lease acquisition is disabled by feature flag or kill switch.");
    }
    const state = await this.getState();
    const run = this.requireRun(state, input.runId);
    if (isTerminalRunState(run.state) || run.state === "cancel_requested") {
      throw new RunCoordinatorError(
        "INVALID_TRANSITION",
        `Run is not assignable (${run.state}).`,
      );
    }
    const activeAttempt = state.attempts.find(
      (a) => a.runId === input.runId && ACTIVE_ATTEMPT_STATUSES.has(a.status),
    );
    if (activeAttempt !== undefined) {
      throw new RunCoordinatorError(
        "LEASE_CONFLICT",
        "Run already holds an active lease.",
      );
    }
    const attempt =
      state.attempts.filter((a) => a.runId === input.runId).length + 1;
    if (attempt > this.quotas.maxAttempts) {
      throw new RunCoordinatorError(
        "QUOTA_EXCEEDED",
        "Max attempts exhausted.",
      );
    }
    const membership = await this.membershipLog.getState();
    if (membership.memberIds.length === 0) {
      throw new RunCoordinatorError(
        "PARTITION_NO_QUORUM",
        "No committed membership; cannot assign work.",
      );
    }
    const quorumSize = Math.floor(membership.memberIds.length / 2) + 1;
    if (membership.memberIds.length < quorumSize) {
      throw new RunCoordinatorError(
        "PARTITION_NO_QUORUM",
        "Insufficient members for quorum; cannot assign work.",
      );
    }
    if (input.peerClaim !== undefined) {
      if (input.peerClaim.clusterId !== membership.clusterId) {
        throw new RunCoordinatorError("WRONG_CLUSTER", "Claim for another cluster.");
      }
      if (input.peerClaim.epoch > membership.epoch) {
        throw new RunCoordinatorError(
          "PARTITION_NO_QUORUM",
          "Local membership view is behind; sync before assigning.",
        );
      }
      if (
        input.peerClaim.epoch === membership.epoch &&
        input.peerClaim.memberIds.length > 0 &&
        JSON.stringify([...input.peerClaim.memberIds].sort()) !==
          JSON.stringify([...membership.memberIds].sort())
      ) {
        throw new RunCoordinatorError(
          "STALE_MEMBERSHIP_EPOCH",
          "Membership claim diverges at the same epoch; sync first.",
        );
      }
      const peerQuorum = Math.floor(input.peerClaim.memberIds.length / 2) + 1;
      if (input.peerClaim.memberIds.length < peerQuorum) {
        throw new RunCoordinatorError(
          "PARTITION_NO_QUORUM",
          "Peer claim lacks quorum; refusing assignment.",
        );
      }
    }
    const workerNodeId = selectCandidate({
      runId: input.runId,
      attempt,
      members: membership.memberIds,
      capabilities: this.capabilities,
      requiredCapabilities: run.spec.requiredCapabilities,
    });
    const runTimeoutMs = run.spec.resources.timeoutSeconds * 1000;
    const elapsedMs = input.now - run.createdAt;
    const leaseTtlMs = computeLeaseTtl(runTimeoutMs, elapsedMs);
    metricsRegistry.set("run_coordinator.lease_ttl_ms", leaseTtlMs);
    // First assignment: createdAt is the queue-entry time, so the age at
    // assignment is exactly the time the run waited in the queue.
    if (attempt === 1) {
      metricsRegistry.set("run_coordinator.queue_age_ms", elapsedMs);
    }
    const leaseId = `lease-${input.runId}-${attempt}`;
    const expiresAt = input.now + leaseTtlMs;
    const height = await this.eventLog.getHeight();
    const payload = {
      type: "run.lease_granted" as const,
      runId: input.runId,
      attempt,
      leaseId,
      workerNodeId,
      membershipEpoch: membership.epoch,
      expiresAt,
      grantedAt: input.now,
      fencingToken: height,
    };
    await this.eventLog.appendEvent(
      createClusterEvent({
        eventId: `evt-${input.runId}-lease-${attempt}`,
        clusterId: this.clusterId,
        sequence: height,
        epoch: membership.epoch,
        kind: RUN_LEASE_GRANTED_KIND,
        correlationId: input.correlationId,
        payload,
      }),
      this.signer,
    );
    await this.applyFromLog();
    registerInMembershipRegistry(
      {
        leaseId,
        runId: input.runId,
        attempt,
        workerNodeId,
        membershipEpoch: membership.epoch,
        expiresAt,
        fencingToken: height,
        grantedAt: input.now,
        renewedAt: input.now,
        renewCount: 0,
      },
      this.membershipLog.leases,
    );
    this.auditSink?.record({
      kind: "run.lease_granted",
      details: { runId: input.runId, attempt, workerNodeId, leaseId },
    });
    return {
      leaseId,
      runId: input.runId,
      attempt,
      workerNodeId,
      membershipEpoch: membership.epoch,
      expiresAt,
      fencingToken: height,
      grantedAt: input.now,
      renewedAt: input.now,
      renewCount: 0,
    };
  }

  /** At-least-once observation of a worker attempt report. Duplicate or
   *  late reports are counted, never re-applied. Reports carrying a stale
   *  fencing token or foreign worker ID are rejected. Fence check on every observation. */
  async observeAttempt(input: {
    readonly report: AttemptReport;
    readonly correlationId: string;
    readonly now: number;
  }): Promise<AttemptRecord> {
    const state = await this.getState();
    const attempt = state.attempts.find(
      (a) => a.runId === input.report.runId && a.attempt === input.report.attempt,
    );
    if (attempt === undefined) {
      throw new RunCoordinatorError("ATTEMPT_NOT_FOUND", "Unknown attempt.");
    }
    if (attempt.workerNodeId !== input.report.workerNodeId) {
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        "Report from a worker that does not hold the lease.",
      );
    }
    const committedLease = toCommittedLease(attempt);
    if (committedLease === undefined) {
      throw new RunCoordinatorError(
        "ATTEMPT_NOT_FOUND",
        "Attempt has no committed lease.",
      );
    }
    const membership = await this.membershipLog.getState();
    const leases = this.membershipLog.leases;
    if (leases.get(committedLease.leaseId) === undefined) {
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        "Lease has been fenced or revoked; attempt rejected.",
      );
    }
    if (!isFreshFencingToken(input.report.fencingToken, committedLease)) {
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        describeFencingTokenMismatch(
          input.report.fencingToken,
          committedLease,
          "Report",
        ),
      );
    }
    if (!isCommittedLeaseUsable(committedLease, membership.epoch, input.now)) {
      if (committedLease.expiresAt <= input.now) {
        throw new RunCoordinatorError(
          "LEASE_EXPIRED",
          "Lease has expired; attempt fenced.",
        );
      }
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        "Lease membership epoch has advanced; attempt fenced.",
      );
    }
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      return attempt;
    }
    const height = await this.eventLog.getHeight();
    const membershipEpoch = membership.epoch;
    await this.eventLog.appendEvent(
      createClusterEvent({
        eventId: `evt-${input.report.runId}-obs-${height}`,
        clusterId: this.clusterId,
        sequence: height,
        epoch: membershipEpoch,
        kind: RUN_ATTEMPT_OBSERVED_KIND,
        correlationId: input.correlationId,
        payload: {
          type: "run.attempt_observed" as const,
          runId: input.report.runId,
          attempt: input.report.attempt,
          workerNodeId: input.report.workerNodeId,
          status: input.report.status,
          reportedAt: input.report.reportedAt,
          fencingToken: input.report.fencingToken,
          duplicate: false,
          note: input.report.note,
        },
      }),
      this.signer,
    );
    await this.applyFromLog();
    const next = await this.getState();
    const updated = next.attempts.find(
      (a) => a.runId === input.report.runId && a.attempt === input.report.attempt,
    );
    if (updated === undefined) {
      throw new RunCoordinatorError("ATTEMPT_NOT_FOUND", "Attempt lost.");
    }
    await this.mirrorNodeStore(next.runs.find((r) => r.runId === input.report.runId), "observe", updated);
    return updated;
  }

  async renewLease(input: {
    readonly request: LeaseRenewalRequest;
    readonly correlationId: string;
    readonly now: number;
  }): Promise<LeaseRenewalResult> {
    validateLeaseRenewalRequest(input.request);
    const state = await this.getState();
    const attempt = state.attempts.find(
      (a) =>
        a.runId === input.request.runId &&
        a.attempt === input.request.attempt &&
        a.leaseId === input.request.leaseId,
    );
    if (attempt === undefined) {
      throw new RunCoordinatorError("ATTEMPT_NOT_FOUND", "Unknown attempt for lease renewal.");
    }
    if (attempt.workerNodeId !== input.request.workerNodeId) {
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        "Renewal from a worker that does not hold the lease.",
      );
    }
    const committedLease = toCommittedLease(attempt);
    if (committedLease === undefined) {
      throw new RunCoordinatorError(
        "ATTEMPT_NOT_FOUND",
        "Attempt has no committed lease.",
      );
    }
    const membership = await this.membershipLog.getState();
    const leases = this.membershipLog.leases;
    if (leases.get(committedLease.leaseId) === undefined) {
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        "Lease has been fenced or revoked; cannot renew.",
      );
    }
    if (!isFreshFencingToken(input.request.fencingToken, committedLease)) {
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        describeFencingTokenMismatch(
          input.request.fencingToken,
          committedLease,
          "Renewal",
        ),
      );
    }
    if (!isCommittedLeaseUsable(committedLease, membership.epoch, input.now)) {
      if (committedLease.expiresAt <= input.now) {
        throw new RunCoordinatorError(
          "LEASE_EXPIRED",
          "Lease has expired; cannot renew.",
        );
      }
      throw new RunCoordinatorError(
        "STALE_FENCING_TOKEN",
        "Lease membership epoch has advanced; cannot renew.",
      );
    }
    if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
      throw new RunCoordinatorError(
        "INVALID_TRANSITION",
        "Attempt is terminal; cannot renew lease.",
      );
    }
    const run = state.runs.find((r) => r.runId === input.request.runId);
    if (!run) {
      throw new RunCoordinatorError("RUN_NOT_FOUND", "Run not found for lease renewal.");
    }
    const runTimeoutMs = run.spec.resources.timeoutSeconds * 1000;
    const elapsedMs = input.now - run.createdAt;
    const leaseTtlMs = computeLeaseTtl(runTimeoutMs, elapsedMs);
    metricsRegistry.set("run_coordinator.lease_ttl_ms", leaseTtlMs);
    const newExpiresAt = input.now + leaseTtlMs;
    const height = await this.eventLog.getHeight();
    const payload: RunLeaseRenewedPayload = {
      type: "run.lease_renewed",
      runId: input.request.runId,
      attempt: input.request.attempt,
      leaseId: input.request.leaseId,
      workerNodeId: input.request.workerNodeId,
      membershipEpoch: membership.epoch,
      expiresAt: newExpiresAt,
      renewedAt: input.now,
      fencingToken: height,
      renewCount: attempt.renewCount + 1,
    };
    await this.eventLog.appendEvent(
      createClusterEvent({
        eventId: `evt-${input.request.runId}-renew-${attempt.attempt}-${height}`,
        clusterId: this.clusterId,
        sequence: height,
        epoch: membership.epoch,
        kind: RUN_LEASE_RENEWED_KIND,
        correlationId: input.correlationId,
        payload,
      }),
      this.signer,
    );
    await this.applyFromLog();
    this.membershipLog.leases.updateExpiry(input.request.leaseId, newExpiresAt);
    this.auditSink?.record({
      kind: "run.lease_renewed",
      details: { runId: input.request.runId, attempt: input.request.attempt, leaseId: input.request.leaseId },
    });
    return {
      leaseId: input.request.leaseId,
      runId: input.request.runId,
      attempt: input.request.attempt,
      workerNodeId: input.request.workerNodeId,
      membershipEpoch: membership.epoch,
      expiresAt: newExpiresAt,
      fencingToken: height,
      grantedAt: attempt.grantedAt ?? input.now,
      renewedAt: input.now,
      renewCount: attempt.renewCount + 1,
    };
  }

  /** Reconcile expired leases, membership epoch changes, and conflicting
   *  assignments detected via peer claims. Idempotent: already-terminal
   *  attempts are never re-fenced. Uses Raft log to detect conflicts. */
  async reconcile(input: ReconcileInput): Promise<ReconcileSummary> {
    const state = await this.getState();
    const membership = await this.membershipLog.getState();
    const fenced: { runId: string; attempt: number; reason: string }[] = [];
    const conflictingAssignments: {
      runId: string;
      attempt: number;
      localLeaseId: string;
      remoteLeaseId: string;
      localWorker: string;
      remoteWorker: string;
    }[] = [];

    for (const attempt of state.attempts) {
      if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
      let reason: AttemptFencedPayload["reason"] | null = null;
      if (attempt.expiresAt !== null && attempt.expiresAt <= input.now) {
        reason = "lease_expired";
      }
      if (
        reason === null &&
        attempt.membershipEpoch !== null &&
        attempt.membershipEpoch !== membership.epoch
      ) {
        reason = "membership_epoch_advanced";
      }
      if (reason === null && input.peerClaims !== undefined) {
        for (const claim of input.peerClaims) {
          if (claim.clusterId !== membership.clusterId) continue;
          if (claim.epoch > membership.epoch) {
            reason = "membership_epoch_advanced";
            break;
          }
          if (
            claim.epoch === membership.epoch &&
            attempt.workerNodeId !== null &&
            !claim.memberIds.includes(attempt.workerNodeId)
          ) {
            reason = "worker_lost";
            break;
          }
        }
      }
      if (reason === null) continue;
      fenced.push({ runId: attempt.runId, attempt: attempt.attempt, reason });
      const height = await this.eventLog.getHeight();
      await this.eventLog.appendEvent(
        createClusterEvent({
          eventId: `evt-${attempt.runId}-fence-${attempt.attempt}-${height}`,
          clusterId: this.clusterId,
          sequence: height,
          epoch: membership.epoch,
          kind: RUN_ATTEMPT_FENCED_KIND,
          correlationId: `reconcile-${attempt.runId}-${attempt.attempt}-${height}`,
          payload: {
            type: "run.attempt_fenced" as const,
            runId: attempt.runId,
            attempt: attempt.attempt,
            leaseId: attempt.leaseId,
            reason,
            fencedAt: input.now,
          },
        }),
        this.signer,
      );
    }

    if (input.peerClaims !== undefined) {
      const leases = this.membershipLog.leases;
      const registeredLeases = leases.list();
      for (const claim of input.peerClaims) {
        if (claim.clusterId !== membership.clusterId) continue;
        if (claim.epoch !== membership.epoch) continue;
        for (const attempt of state.attempts) {
          if (!ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
          if (attempt.workerNodeId === null) continue;
          if (!claim.memberIds.includes(attempt.workerNodeId)) {
            const remoteLease = registeredLeases.find(
              (lease) =>
                lease.runId === attempt.runId &&
                lease.attempt === attempt.attempt,
            );
            if (remoteLease && remoteLease.workerNodeId !== attempt.workerNodeId) {
              conflictingAssignments.push({
                runId: attempt.runId,
                attempt: attempt.attempt,
                localLeaseId: attempt.leaseId ?? "",
                remoteLeaseId: remoteLease.leaseId,
                localWorker: attempt.workerNodeId,
                remoteWorker: remoteLease.workerNodeId,
              });
            }
          }
        }
      }
    }

    if (fenced.length > 0) await this.applyFromLog();
    return { fencedAttemptCount: fenced.length, fencedAttempts: fenced, conflictingAssignments };
  }

  /** Rebuild committed run state from the local event log. Deterministic
   *  and replay-safe: the same log reproduces the same state. */
  async sync(): Promise<CoordinatedState> {
    return this.applyFromLog();
  }

  async fenceOnMembershipChange(): Promise<number> {
    const fenced = await this.membershipLog.fenceLeases(Date.now());
    return fenced.length;
  }

  private requireRun(state: CoordinatedState, runId: string): RunRecord {
    const run = state.runs.find((r) => r.runId === runId);
    if (run === undefined) {
      throw new RunCoordinatorError("RUN_NOT_FOUND", "Unknown run.");
    }
    return run;
  }

  private async mirrorNodeStore(
    run: RunRecord | undefined,
    phase: "submit" | "cancel" | "observe",
    attempt?: AttemptRecord,
  ): Promise<void> {
    if (this.nodeStore === undefined || run === undefined) return;
    try {
      if (phase === "submit" && run.dbRunId === undefined) {
        const resourceLimits = run.spec.resources;
        const res = await this.nodeStore.submitRun({
          clientRequestId: run.clientKey,
          name: run.spec.name,
          mode: run.spec.mode === "container" ? "container" : "diagnostic",
          image: run.spec.image,
          command: [...run.spec.command],
          resources: {
            cpuMilli: resourceLimits.cpuMilli,
            memoryMiB: resourceLimits.memoryMiB,
            diskMiB: resourceLimits.diskMiB,
            timeoutSeconds: resourceLimits.timeoutSeconds,
          },
          networkPolicy: run.spec.networkPolicy,
          submittedBy: run.actorId,
          submittedViaNodeId: run.actorId,
        });
        const stored = await this.store.load();
        if (stored) {
          await this.store.save({
            ...stored,
            runs: stored.runs.map((r) =>
              r.runId === run.runId ? { ...r, dbRunId: res.run.id } : r,
            ),
          });
        }
      } else if (phase === "cancel" && run.dbRunId !== undefined) {
        await this.nodeStore.requestCancel(run.dbRunId);
      } else if (phase === "observe" && attempt !== undefined) {
        if (attempt.dbAttemptId !== undefined) {
          await this.nodeStore.transitionAttempt(attempt.dbAttemptId, mapAttemptStatus(attempt.status));
        } else if (run.dbRunId !== undefined && attempt.workerNodeId !== null) {
          const created = await this.nodeStore.createAttempt(run.dbRunId, {
            status: mapAttemptStatus(attempt.status),
            workerNodeId: attempt.workerNodeId,
          });
          const stored = await this.store.load();
          if (stored) {
            await this.store.save({
              ...stored,
              attempts: stored.attempts.map((a) =>
                a.runId === attempt.runId && a.attempt === attempt.attempt
                  ? { ...a, dbAttemptId: created.id }
                  : a,
              ),
            });
          }
        }
      }
    } catch {
      // NodeStore mirror is a best-effort local view; the committed log is authoritative.
    }
  }

  private async applyFromLog(): Promise<CoordinatedState> {
    const stored = (await this.store.load()) ?? {
      clusterId: this.clusterId.value,
      appliedSequence: 0,
      runs: Object.freeze([] as RunRecord[]),
      attempts: Object.freeze([] as AttemptRecord[]),
    };
    const height = await this.eventLog.getHeight();
    const entries = await this.eventLog.getRange(stored.appliedSequence, height);
    let state: CoordinatedState = stored;
    for (const entry of entries) {
      state = this.applyEntry(state, entry);
    }
    await this.store.save(state);
    return state;
  }

  private applyEntry(
    state: CoordinatedState,
    entry: SignedLogEntry,
  ): CoordinatedState {
    const event = entry.event as ClusterEvent;
    if (event.clusterId.value !== this.clusterId.value) {
      throw new RunCoordinatorError("WRONG_CLUSTER", "Entry cluster mismatch.");
    }
    if (event.sequence !== state.appliedSequence) {
      throw new RunCoordinatorError(
        "INVALID_TRANSITION",
        `Entry sequence ${event.sequence} out of order (expected ${state.appliedSequence}).`,
      );
    }
    if (!isRunKind(event.kind)) {
      return Object.freeze({ ...state, appliedSequence: event.sequence + 1 });
    }
    switch (event.kind) {
      case RUN_SUBMITTED_KIND: {
        const payload = event.payload as RunSubmittedPayloadLike;
        if (payload.type !== "run.submitted") break;
        const existing = state.runs.find((r) => r.runId === payload.runId);
        if (existing !== undefined) {
          return {
            ...state,
            appliedSequence: event.sequence + 1,
            runs: state.runs.map((r) =>
              r.runId === payload.runId
                ? {
                    ...r,
                    conflictingSubmissions:
                      r.conflictingSubmissions +
                      (r.payloadHash === payload.payloadHash ? 0 : 1),
                  }
                : r,
            ),
          };
        }
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          runs: [
            ...state.runs,
            Object.freeze({
              runId: payload.runId,
              clusterId: payload.clusterId,
              actorId: payload.actorId,
              clientKey: payload.clientKey,
              payloadHash: payload.payloadHash,
              spec: payload.spec as RunSpec,
              state: "queued" as RunStatus,
              createdAt: payload.createdAt,
              cancelRequestedAt: null,
              cancelledBy: null,
              terminalReason: null,
              duplicateReports: 0,
              conflictingSubmissions: 0,
            }),
          ],
        };
      }
      case RUN_LEASE_GRANTED_KIND: {
        const payload = event.payload as RunLeaseGrantedPayloadLike;
        if (payload.type !== "run.lease_granted") break;
        const runExists = state.runs.some((r) => r.runId === payload.runId);
        if (!runExists) {
          throw new RunCoordinatorError("RUN_NOT_FOUND", "Lease for unknown run.");
        }
        const exists = state.attempts.some(
          (a) => a.runId === payload.runId && a.attempt === payload.attempt,
        );
        if (exists) {
          return { ...state, appliedSequence: event.sequence + 1 };
        }
        const attempt: AttemptRecord = Object.freeze({
          runId: payload.runId,
          attempt: payload.attempt,
          attemptId: deriveAttemptId(payload.runId, payload.attempt),
          leaseId: payload.leaseId,
          workerNodeId: payload.workerNodeId,
          membershipEpoch: payload.membershipEpoch,
          expiresAt: payload.expiresAt,
          fencingToken: payload.fencingToken,
          status: "scheduled" as AttemptStatus,
          reportCount: 0,
          lastReportedAt: null,
          fencedReason: null,
          renewCount: 0,
          renewedAt: payload.grantedAt,
          grantedAt: payload.grantedAt,
        });
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          attempts: [...state.attempts, attempt],
          runs: state.runs.map((r) =>
            r.runId === payload.runId && !isTerminalRunState(r.state)
              ? { ...r, state: "scheduled" as RunStatus }
              : r,
          ),
        };
      }
      case RUN_ATTEMPT_OBSERVED_KIND: {
        const payload = event.payload as AttemptObservedPayloadLike;
        if (payload.type !== "run.attempt_observed") break;
        const attempt = state.attempts.find(
          (a) => a.runId === payload.runId && a.attempt === payload.attempt,
        );
        if (attempt === undefined) {
          throw new RunCoordinatorError("ATTEMPT_NOT_FOUND", "Observed unknown attempt.");
        }
        if (TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) {
          return {
            ...state,
            appliedSequence: event.sequence + 1,
            runs: state.runs.map((r) =>
              r.runId === payload.runId
                ? { ...r, duplicateReports: r.duplicateReports + 1 }
                : r,
            ),
          };
        }
        const nextStatus = payload.status as AttemptStatus;
        const terminal = TERMINAL_ATTEMPT_STATUSES.has(nextStatus);
        const terminalReason =
          nextStatus === "infrastructure_error"
            ? "infrastructure_error"
            : nextStatus === "timed_out"
              ? "timed_out"
              : null;
        const updated: AttemptRecord = Object.freeze({
          ...attempt,
          status: nextStatus,
          reportCount: attempt.reportCount + 1,
          lastReportedAt: payload.reportedAt,
        });
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          attempts: state.attempts.map((a) =>
            a.runId === payload.runId && a.attempt === payload.attempt
              ? updated
              : a,
          ),
          runs: state.runs.map((r) => {
            if (r.runId !== payload.runId) return r;
            if (terminal) {
              const runState: RunStatus =
                nextStatus === "succeeded"
                  ? "succeeded"
                  : nextStatus === "cancelled"
                    ? "cancelled"
                    : nextStatus === "timed_out"
                      ? "failed"
                      : "failed";
              return {
                ...r,
                state: runState,
                terminalReason:
                  runState === "failed" ? (terminalReason ?? "failed") : null,
                cancelRequestedAt: r.cancelRequestedAt,
              };
            }
            if (nextStatus === "running") {
              return r.state === "cancel_requested"
                ? r
                : { ...r, state: "running" as RunStatus };
            }
            return r.state === "cancel_requested"
              ? r
              : r.state === "queued" || r.state === "scheduled"
                ? { ...r, state: "scheduled" as RunStatus }
                : r;
          }),
        };
      }
      case RUN_CANCEL_REQUESTED_KIND: {
        const payload = event.payload as RunCancelRequestedPayloadLike;
        if (payload.type !== "run.cancel_requested") break;
        const run = state.runs.find((r) => r.runId === payload.runId);
        if (run === undefined) break;
        if (isTerminalRunState(run.state)) break;
        let nextRun: RunRecord = {
          ...run,
          cancelRequestedAt: payload.requestedAt,
          cancelledBy: payload.cancelledBy,
          state:
            run.state === "queued" || run.state === "scheduled" || run.state === "running"
              ? "cancel_requested"
              : run.state,
        };
        let activeAttempts = state.attempts.filter(
          (a) => a.runId === payload.runId && ACTIVE_ATTEMPT_STATUSES.has(a.status),
        );
        // Cancel immediately fences attempts that never started; a running
        // attempt resolves by whichever terminal event commits first
        // (cancel-vs-complete race is decided by committed order).
        const fencedAttempts = activeAttempts.filter(
          (a) => a.status === "scheduled",
        );
        if (fencedAttempts.length > 0) {
          const fencedIds = new Set(fencedAttempts.map((a) => a.attempt));
          return {
            ...state,
            appliedSequence: event.sequence + 1,
            attempts: state.attempts.map((a) =>
              fencedIds.has(a.attempt) && a.runId === payload.runId
                ? { ...a, status: "cancelled" as AttemptStatus, fencedReason: "cancel_requested" }
                : a,
            ),
            runs: state.runs.map((r) =>
              r.runId === payload.runId && r.cancelRequestedAt === null
                ? { ...nextRun, state: "cancelled" as RunStatus, terminalReason: "cancel_requested" }
                : r.runId === payload.runId
                  ? nextRun
                  : r,
            ),
          };
        }
        const runningOrStarting = activeAttempts.filter(
          (a) => a.status === "starting" || a.status === "running",
        );
        if (runningOrStarting.length === 0) {
          return {
            ...state,
            appliedSequence: event.sequence + 1,
            runs: state.runs.map((r) =>
              r.runId === payload.runId
                ? { ...nextRun, state: "cancelled" as RunStatus, terminalReason: "cancel_requested" }
                : r,
            ),
          };
        }
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          runs: state.runs.map((r) => (r.runId === payload.runId ? nextRun : r)),
        };
      }
      case RUN_RETRY_REQUESTED_KIND: {
        const payload = event.payload as RunRetryRequestedPayloadLike;
        if (payload.type !== "run.retry_requested") break;
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          runs: state.runs.map((r) =>
            r.runId === payload.runId && !isTerminalRunState(r.state)
              ? { ...r, state: "queued" as RunStatus, terminalReason: null }
              : r,
          ),
        };
      }
      case RUN_ATTEMPT_FENCED_KIND: {
        const payload = event.payload as AttemptFencedPayload;
        if (payload.type !== "run.attempt_fenced") break;
        const attempt = state.attempts.find(
          (a) => a.runId === payload.runId && a.attempt === payload.attempt,
        );
        if (attempt === undefined || !ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) {
          return { ...state, appliedSequence: event.sequence + 1 };
        }
        const nextStatus: AttemptStatus =
          payload.reason === "cancel_requested" ? "cancelled" : "lost";
        const fencedAttempt = Object.freeze({
          ...attempt,
          status: nextStatus,
          fencedReason: payload.reason,
        });
        const run = state.runs.find((r) => r.runId === payload.runId);
        const attemptsForRun = state.attempts.filter(
          (a) => a.runId === payload.runId,
        );
        const remainingActive = attemptsForRun.filter(
          (a) =>
            ACTIVE_ATTEMPT_STATUSES.has(a.status) &&
            a.attempt !== payload.attempt,
        );
        if (!run) {
          return { ...state, appliedSequence: event.sequence + 1 };
        }
        let runState: RunStatus = run.state;
        if (isTerminalRunState(run.state)) {
          runState = run.state;
        } else if (remainingActive.length > 0) {
          runState = run.state;
        } else {
          const cancelRequested = run.cancelRequestedAt !== null;
          if (cancelRequested) {
            runState = "cancelled";
          } else {
            const exhausted =
              attemptsForRun.length >= this.quotas.maxAttempts &&
              attemptsForRun.every(
                (a) =>
                  TERMINAL_ATTEMPT_STATUSES.has(a.status) ||
                  (a.attempt === payload.attempt && ACTIVE_ATTEMPT_STATUSES.has(a.status)),
              );
            if (exhausted) {
              runState = "failed";
            } else if (run.spec.sideEffectClass !== "idempotent") {
              runState = "interrupted";
            } else {
              runState = "queued";
            }
          }
        }
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          attempts: state.attempts.map((a) =>
            a.runId === payload.runId && a.attempt === payload.attempt
              ? fencedAttempt
              : a,
          ),
          runs: state.runs.map((r) => {
            if (r.runId !== payload.runId) return r;
            if (isTerminalRunState(r.state)) return r;
            if (remainingActive.length > 0) return r;
            const cancelRequested = r.cancelRequestedAt !== null;
            if (cancelRequested) {
              return {
                ...r,
                state: "cancelled" as RunStatus,
                terminalReason: "cancel_requested",
              };
            }
            const exhausted =
              attemptsForRun.length >= this.quotas.maxAttempts &&
              attemptsForRun.every(
                (a) =>
                  TERMINAL_ATTEMPT_STATUSES.has(a.status) ||
                  (a.attempt === payload.attempt && ACTIVE_ATTEMPT_STATUSES.has(a.status)),
              );
            if (exhausted) {
              return {
                ...r,
                state: "failed" as RunStatus,
                terminalReason: "attempts_exhausted",
              };
            }
            if (r.spec.sideEffectClass !== "idempotent") {
              return { ...r, state: "interrupted" as RunStatus, terminalReason: "fenced" };
            }
            return { ...r, state: "queued" as RunStatus, terminalReason: null };
          }),
        };
      }
      case RUN_LEASE_RENEWED_KIND: {
        const payload = event.payload as RunLeaseRenewedPayload;
        if (payload.type !== "run.lease_renewed") break;
        const attempt = state.attempts.find(
          (a) => a.runId === payload.runId && a.attempt === payload.attempt && a.leaseId === payload.leaseId,
        );
        if (attempt === undefined) {
          return { ...state, appliedSequence: event.sequence + 1 };
        }
        const updated: AttemptRecord = Object.freeze({
          ...attempt,
          expiresAt: payload.expiresAt,
          renewedAt: payload.renewedAt,
          renewCount: payload.renewCount,
          fencingToken: payload.fencingToken,
        });
        return {
          ...state,
          appliedSequence: event.sequence + 1,
          attempts: state.attempts.map((a) =>
            a.runId === payload.runId && a.attempt === payload.attempt && a.leaseId === payload.leaseId
              ? updated
              : a,
          ),
        };
      }
      default:
        return { ...state, appliedSequence: event.sequence + 1 };
    }
    return { ...state, appliedSequence: event.sequence + 1 };
  }
}

function mapAttemptStatus(
  status: AttemptStatus,
): "starting" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "infrastructure_error" {
  switch (status) {
    case "scheduled":
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "timed_out":
      return "timed_out";
    case "infrastructure_error":
    case "lost":
      return "infrastructure_error";
  }
}

interface RunSubmittedPayloadLike {
  readonly type: string;
  readonly runId: string;
  readonly clusterId: string;
  readonly actorId: string;
  readonly clientKey: string;
  readonly payloadHash: string;
  readonly spec: unknown;
  readonly createdAt: number;
}

interface RunLeaseGrantedPayloadLike {
  readonly type: string;
  readonly runId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
  readonly grantedAt: number;
  readonly fencingToken: number;
}

interface RunLeaseRenewedPayloadLike {
  readonly type: string;
  readonly runId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
  readonly renewedAt: number;
  readonly fencingToken: number;
  readonly renewCount: number;
}

interface AttemptObservedPayloadLike {
  readonly type: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly status: string;
  readonly reportedAt: number;
  readonly fencingToken: number;
  readonly duplicate: boolean;
  readonly note?: string;
}

interface RunCancelRequestedPayloadLike {
  readonly type: string;
  readonly runId: string;
  readonly cancelledBy: string;
  readonly requestedAt: number;
}

interface RunRetryRequestedPayloadLike {
  readonly type: string;
  readonly runId: string;
  readonly retryBy: string;
  readonly requestedAt: number;
}
