/**
 * Two exit paths for a departing node, each fanning out to injected deps.
 *
 *   voluntary leave ──▶ gate(self) ──▶ drain ──▶ revoke ──▶ invalidate ──▶ quarantine ──▶ publish
 *   eviction        ──▶ gate(peer) ──▶ revoke ──▶ invalidate ──▶ quarantine ──▶ retain
 *                                     │                                            │
 *                   audit.record ◀──────────────────────────────────────────────┘
 *                         │
 *                         ▼
 *                       NodeLifecycleReport
 *
 * Assignment gating is scoped per `(subject, cause)`: stopping one subject never
 * disables another, so evicting a remote peer leaves the local node accepting
 * new assignments. `resumeAssignments(subject, cause)` is the documented,
 * authorized re-enable path; `acceptsNewAssignments()` (no subject) answers for
 * the process-local node, which only stops on its own voluntary leave.
 *
 * Six separate injected steps, not one pipeline: leave drains and publishes, and
 * both paths revoke the subject's credentials and quarantine its capacity.
 */
import { metricsRegistry } from "@workspace/observability";

export type LifecycleCause = "voluntary-leave" | "eviction";

export interface AssignmentGate {
  stopNewAssignments(subject: string, cause: LifecycleCause, reason?: string): unknown;
  resumeAssignments(subject: string, cause: LifecycleCause): unknown;
  acceptsNewAssignments(subject?: string): boolean;
}

export interface DrainSummary {
  readonly activeAtStart: number;
  readonly drained: number;
  readonly relinquished: number;
}

export interface WorkDrainer {
  drain(): DrainSummary | Promise<DrainSummary>;
}

export interface CredentialRevoker {
  revoke(subjectId: string, cause: LifecycleCause): unknown;
}

export interface LeaseInvalidator {
  invalidate(
    subjectId: string,
    cause: LifecycleCause,
    now: number,
  ): number | Promise<number>;
}

export interface CapacityController {
  quarantine(subjectId: string, cause: LifecycleCause): unknown;
  release(subjectId: string): unknown;
}

export interface RetentionAction {
  readonly resource: string;
  readonly rule: string;
}

export interface RetentionPolicy {
  retainOnMembershipRemoval(
    subjectId: string,
    cause: LifecycleCause,
  ): readonly RetentionAction[];
}

export interface SignedLeaveEvent {
  readonly type: "leave";
  readonly clusterId: string;
  readonly subjectId: string;
  readonly previousEpoch: number;
  readonly newEpoch: number;
  readonly signerNodeId: string;
  readonly signature: string;
}

export interface LeaveEventPublisher {
  publishSignedLeaveEvent(event: SignedLeaveEvent): unknown;
}

export interface LifecycleAuditSink {
  record(event: {
    readonly kind: string;
    readonly details: Readonly<Record<string, unknown>>;
  }): void;
}

export interface NodeLifecycleDeps {
  readonly gate: AssignmentGate;
  readonly drainer: WorkDrainer;
  readonly credentials: CredentialRevoker;
  readonly leases: LeaseInvalidator;
  readonly capacity: CapacityController;
  readonly retention: RetentionPolicy;
  readonly leavePublisher?: LeaveEventPublisher;
  readonly audit?: LifecycleAuditSink;
  readonly now?: () => number;
}

export interface NodeLifecycleReport {
  readonly cause: LifecycleCause;
  readonly subjectId: string;
  readonly stoppedNewAssignments: boolean;
  readonly drain: DrainSummary | null;
  readonly credentialsRevoked: boolean;
  readonly leasesInvalidated: number;
  readonly capacityQuarantined: boolean;
  readonly retention: readonly RetentionAction[];
  readonly leavePublished: boolean;
}

export const DEFAULT_RETENTION_RULES: readonly RetentionAction[] = Object.freeze([
  Object.freeze({
    resource: "run history and attempt records",
    rule: "Retained for 30 days after committed membership removal for audit, then hard-deleted from local storage.",
  }),
  Object.freeze({
    resource: "workload logs and artifacts",
    rule: "Retained for 7 days after committed membership removal, after which chunks and content metadata are deleted and peer references are fenced.",
  }),
  Object.freeze({
    resource: "secrets and job-scoped credentials",
    rule: "Revoked at membership removal; no secret material is retained on the departed node.",
  }),
  Object.freeze({
    resource: "membership credentials and leases",
    rule: "Invalidated immediately at epoch advancement; stale leases and certificates are never honored after the fencing epoch.",
  }),
]);

export class DefaultRetentionPolicy implements RetentionPolicy {
  retainOnMembershipRemoval(
    subjectId: string,
    cause: LifecycleCause,
  ): readonly RetentionAction[] {
    void subjectId;
    void cause;
    return DEFAULT_RETENTION_RULES;
  }
}

export class InMemoryAssignmentGate implements AssignmentGate {
  private readonly stoppedBySubject = new Map<string, Set<LifecycleCause>>();

  stopNewAssignments(subject: string, cause: LifecycleCause): void {
    const causes = this.stoppedBySubject.get(subject) ?? new Set<LifecycleCause>();
    causes.add(cause);
    this.stoppedBySubject.set(subject, causes);
  }

  resumeAssignments(subject: string, cause: LifecycleCause): void {
    const causes = this.stoppedBySubject.get(subject);
    if (causes === undefined) return;
    causes.delete(cause);
    if (causes.size === 0) this.stoppedBySubject.delete(subject);
  }

  acceptsNewAssignments(subject?: string): boolean {
    if (subject !== undefined) {
      return !this.stoppedBySubject.has(subject);
    }
    // Process-local query used by the run admission path. The local node stops
    // accepting new assignments only through its own voluntary leave; a remote
    // peer's eviction is scoped to that peer and never disables the local node.
    for (const causes of this.stoppedBySubject.values()) {
      if (causes.has("voluntary-leave")) return false;
    }
    return true;
  }
}

export class InMemoryCredentialRevoker implements CredentialRevoker {
  private readonly revokedSubjects = new Set<string>();

  revoke(subjectId: string): void {
    this.revokedSubjects.add(subjectId);
  }

  isRevoked(subjectId: string): boolean {
    return this.revokedSubjects.has(subjectId);
  }
}

export class InMemoryCapacityController implements CapacityController {
  private readonly quarantinedSubjects = new Set<string>();

  quarantine(subjectId: string): void {
    this.quarantinedSubjects.add(subjectId);
  }

  release(subjectId: string): void {
    this.quarantinedSubjects.delete(subjectId);
  }

  isQuarantined(subjectId: string): boolean {
    return this.quarantinedSubjects.has(subjectId);
  }
}

export class NodeLifecycleController {
  private readonly gate: AssignmentGate;
  private readonly drainer: WorkDrainer;
  private readonly credentials: CredentialRevoker;
  private readonly leases: LeaseInvalidator;
  private readonly capacity: CapacityController;
  private readonly retention: RetentionPolicy;
  private readonly leavePublisher?: LeaveEventPublisher;
  private readonly audit?: LifecycleAuditSink;
  private readonly now: () => number;

  constructor(deps: NodeLifecycleDeps) {
    this.gate = deps.gate;
    this.drainer = deps.drainer;
    this.credentials = deps.credentials;
    this.leases = deps.leases;
    this.capacity = deps.capacity;
    this.retention = deps.retention;
    this.leavePublisher = deps.leavePublisher;
    this.audit = deps.audit;
    this.now = deps.now ?? Date.now;
  }

  async handleVoluntaryLeave(input: {
    readonly subjectId: string;
    readonly clusterId: string;
    readonly previousEpoch: number;
    readonly newEpoch: number;
    readonly signerNodeId: string;
    readonly signature: string;
  }): Promise<NodeLifecycleReport> {
    this.gate.stopNewAssignments(input.subjectId, "voluntary-leave");
    const drain = await this.drainer.drain();
    this.credentials.revoke(input.subjectId, "voluntary-leave");
    const leasesInvalidated = await this.leases.invalidate(
      input.subjectId,
      "voluntary-leave",
      this.now(),
    );
    this.capacity.quarantine(input.subjectId, "voluntary-leave");
    this.leavePublisher?.publishSignedLeaveEvent({
      type: "leave",
      clusterId: input.clusterId,
      subjectId: input.subjectId,
      previousEpoch: input.previousEpoch,
      newEpoch: input.newEpoch,
      signerNodeId: input.signerNodeId,
      signature: input.signature,
    });
    this.audit?.record({
      kind: "lifecycle.voluntary_leave",
      details: {
        subjectId: input.subjectId,
        clusterId: input.clusterId,
        previousEpoch: input.previousEpoch,
        newEpoch: input.newEpoch,
        drained: drain.drained,
        relinquished: drain.relinquished,
        leasesInvalidated,
        credentialsRevoked: true,
        capacityQuarantined: true,
      },
    });
    return {
      cause: "voluntary-leave",
      subjectId: input.subjectId,
      stoppedNewAssignments: true,
      drain,
      credentialsRevoked: true,
      leasesInvalidated,
      capacityQuarantined: true,
      retention: Object.freeze([]),
      leavePublished: this.leavePublisher !== undefined,
    };
  }

  async handleEviction(input: {
    readonly subjectId: string;
    readonly epoch: number;
  }): Promise<NodeLifecycleReport> {
    this.gate.stopNewAssignments(input.subjectId, "eviction");
    this.credentials.revoke(input.subjectId, "eviction");
    metricsRegistry.increment("membership.key_revocation_pending");
    const leasesInvalidated = await this.leases.invalidate(
      input.subjectId,
      "eviction",
      this.now(),
    );
    this.capacity.quarantine(input.subjectId, "eviction");
    const retention = this.retention.retainOnMembershipRemoval(
      input.subjectId,
      "eviction",
    );
    this.audit?.record({
      kind: "lifecycle.eviction",
      details: {
        subjectId: input.subjectId,
        epoch: input.epoch,
        leasesInvalidated,
        quarantined: true,
      },
    });
    return {
      cause: "eviction",
      subjectId: input.subjectId,
      stoppedNewAssignments: true,
      drain: null,
      credentialsRevoked: true,
      leasesInvalidated,
      capacityQuarantined: true,
      retention,
      leavePublished: false,
    };
  }

  stopNewAssignments(subject: string, cause: LifecycleCause): void {
    this.gate.stopNewAssignments(subject, cause);
  }

  /**
   * Authorized re-enable path: clears a previously stopped `(subject, cause)`
   * assignment scope so the subject can accept new assignments again. Scoped
   * exactly like `stopNewAssignments`, so resuming one subject never resumes
   * another (or the local node).
   */
  resumeAssignments(subject: string, cause: LifecycleCause): void {
    this.gate.resumeAssignments(subject, cause);
  }

  acceptsNewAssignments(subject?: string): boolean {
    return this.gate.acceptsNewAssignments(subject);
  }
}
