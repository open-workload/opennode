import { RunCoordinatorError } from "./errors";

export const LEASE_RENEWAL_INTERVAL_MS = 10_000;
export const MAX_LEASE_TTL_MS = 30_000;

export interface LeaseRecord {
  readonly leaseId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
}

export interface CommittedLease extends LeaseRecord {
  /** Fencing token: the committed run-coordinator log sequence of the lease
   *  grant. Monotonically increasing per commitment order; stale workers
   *  presenting an older token are rejected. */
  readonly fencingToken: number;
  readonly grantedAt: number;
  readonly renewedAt: number;
  readonly renewCount: number;
}

function validateLease(lease: LeaseRecord): void {
  if (
    typeof lease !== "object" ||
    lease === null ||
    typeof lease.leaseId !== "string" ||
    lease.leaseId.length === 0 ||
    typeof lease.runId !== "string" ||
    lease.runId.length === 0 ||
    typeof lease.workerNodeId !== "string" ||
    lease.workerNodeId.length === 0 ||
    !Number.isSafeInteger(lease.attempt) ||
    lease.attempt < 0 ||
    !Number.isSafeInteger(lease.membershipEpoch) ||
    lease.membershipEpoch < 0 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt < 0
  ) {
    throw new RunCoordinatorError("INVALID_SUBMISSION", "Invalid lease record.");
  }
}

export function isLeaseStale(
  lease: LeaseRecord,
  currentMembershipEpoch: number,
  now: number,
): boolean {
  validateLease(lease);
  return lease.membershipEpoch !== currentMembershipEpoch || lease.expiresAt <= now;
}

export class LeaseRegistry {
  private readonly leases = new Map<string, LeaseRecord>();

  add(lease: LeaseRecord): void {
    validateLease(lease);
    this.leases.set(lease.leaseId, Object.freeze({ ...lease }));
  }

  remove(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }

  get(leaseId: string): LeaseRecord | undefined {
    return this.leases.get(leaseId);
  }

  getByRunAndAttempt(runId: string, attempt: number): LeaseRecord | undefined {
    for (const lease of this.leases.values()) {
      if (lease.runId === runId && lease.attempt === attempt) {
        return lease;
      }
    }
    return undefined;
  }

  list(): readonly LeaseRecord[] {
    return Object.freeze([...this.leases.values()]);
  }

  updateExpiry(leaseId: string, expiresAt: number): void {
    const lease = this.leases.get(leaseId);
    if (lease) {
      this.leases.set(leaseId, Object.freeze({ ...lease, expiresAt }));
    }
  }

  fenceOnEpochChange(currentMembershipEpoch: number, now: number): readonly LeaseRecord[] {
    const stale: LeaseRecord[] = [];
    for (const lease of this.leases.values()) {
      if (isLeaseStale(lease, currentMembershipEpoch, now)) {
        stale.push(lease);
        this.leases.delete(lease.leaseId);
      }
    }
    return Object.freeze(stale);
  }
}

export interface LeaseRenewalRequest {
  readonly leaseId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly fencingToken: number;
  readonly requestedAt: number;
}

export interface LeaseRenewalResult {
  readonly leaseId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
  readonly fencingToken: number;
  readonly grantedAt: number;
  readonly renewedAt: number;
  readonly renewCount: number;
}

export function computeLeaseTtl(
  runTimeoutMs: number,
  elapsedMs: number,
): number {
  const remaining = runTimeoutMs - elapsedMs;
  return Math.min(MAX_LEASE_TTL_MS, Math.max(0, remaining));
}

export function validateCommittedLease(lease: CommittedLease): void {
  if (
    typeof lease !== "object" ||
    lease === null ||
    typeof lease.leaseId !== "string" ||
    lease.leaseId.length === 0 ||
    typeof lease.runId !== "string" ||
    lease.runId.length === 0 ||
    typeof lease.workerNodeId !== "string" ||
    lease.workerNodeId.length === 0 ||
    !Number.isSafeInteger(lease.attempt) ||
    lease.attempt < 1 ||
    !Number.isSafeInteger(lease.membershipEpoch) ||
    lease.membershipEpoch < 0 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt < 0 ||
    !Number.isSafeInteger(lease.fencingToken) ||
    lease.fencingToken < 0 ||
    !Number.isSafeInteger(lease.grantedAt) ||
    lease.grantedAt < 0 ||
    !Number.isSafeInteger(lease.renewedAt) ||
    lease.renewedAt < 0 ||
    !Number.isSafeInteger(lease.renewCount) ||
    lease.renewCount < 0
  ) {
    throw new RunCoordinatorError(
      "INVALID_SUBMISSION",
      "Invalid committed lease.",
    );
  }
}

/** A committed lease is usable only while bound to the current epoch,
 *  unexpired, and strictly newer than any token the caller claims. */
export function isCommittedLeaseUsable(
  lease: CommittedLease,
  currentMembershipEpoch: number,
  now: number,
): boolean {
  validateCommittedLease(lease);
  if (lease.expiresAt <= now) return false;
  if (lease.membershipEpoch !== currentMembershipEpoch) return false;
  if (isLeaseStale(lease, currentMembershipEpoch, now)) return false;
  return true;
}

/** Deterministic ordering: higher token wins; ties broken by leaseId. */
export function compareFencingTokens(
  a: CommittedLease,
  b: CommittedLease,
): number {
  if (a.fencingToken !== b.fencingToken) return a.fencingToken - b.fencingToken;
  return a.leaseId < b.leaseId ? -1 : a.leaseId > b.leaseId ? 1 : 0;
}

export function isFreshFencingToken(
  token: number,
  current: CommittedLease,
): boolean {
  return token === current.fencingToken;
}

export function validateLeaseRenewalRequest(
  request: LeaseRenewalRequest,
): void {
  if (
    typeof request !== "object" ||
    request === null ||
    typeof request.leaseId !== "string" ||
    request.leaseId.length === 0 ||
    typeof request.runId !== "string" ||
    request.runId.length === 0 ||
    typeof request.workerNodeId !== "string" ||
    request.workerNodeId.length === 0 ||
    !Number.isSafeInteger(request.attempt) ||
    request.attempt < 1 ||
    !Number.isSafeInteger(request.fencingToken) ||
    request.fencingToken < 0 ||
    !Number.isSafeInteger(request.requestedAt) ||
    request.requestedAt < 0
  ) {
    throw new RunCoordinatorError("INVALID_SUBMISSION", "Invalid lease renewal request.");
  }
}

/** Mirrors granted leases into the shared membership-log lease registry so
 *  epoch advancement fences them everywhere. */
export function registerInMembershipRegistry(
  lease: CommittedLease,
  registry: { add(record: LeaseRecord): void },
): void {
  validateCommittedLease(lease);
  const record: LeaseRecord = {
    leaseId: lease.leaseId,
    runId: lease.runId,
    attempt: lease.attempt,
    workerNodeId: lease.workerNodeId,
    membershipEpoch: lease.membershipEpoch,
    expiresAt: lease.expiresAt,
  };
  registry.add(record);
}
