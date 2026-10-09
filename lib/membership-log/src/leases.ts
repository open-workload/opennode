import { MembershipLogError } from "./errors";

export interface LeaseRecord {
  readonly leaseId: string;
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
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
    throw new MembershipLogError("MEMBERSHIP_LOG_INVALID", "Invalid lease record.");
  }
}

/**
 * A lease is usable only while it is bound to the current committed
 * membership epoch and unexpired. Any epoch advancement fences older leases.
 */
export function isLeaseStale(
  lease: LeaseRecord,
  currentMembershipEpoch: number,
  now: number,
): boolean {
  validateLease(lease);
  return lease.membershipEpoch !== currentMembershipEpoch || lease.expiresAt <= now;
}

/** Keeps only leases valid under the current membership epoch. */
export function partitionLeases<T extends LeaseRecord>(
  leases: readonly T[],
  currentMembershipEpoch: number,
  now: number,
): { readonly valid: readonly T[]; readonly stale: readonly T[] } {
  const valid: T[] = [];
  const stale: T[] = [];
  for (const lease of leases) {
    if (isLeaseStale(lease, currentMembershipEpoch, now)) stale.push(lease);
    else valid.push(lease);
  }
  return Object.freeze({ valid: Object.freeze(valid), stale: Object.freeze(stale) });
}

/** In-memory lease registry; callers may swap in a durable store. */
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

  list(): readonly LeaseRecord[] {
    return Object.freeze([...this.leases.values()]);
  }

  getByRunAndAttempt(runId: string, attempt: number): LeaseRecord | undefined {
    for (const lease of this.leases.values()) {
      if (lease.runId === runId && lease.attempt === attempt) {
        return lease;
      }
    }
    return undefined;
  }

  updateExpiry(leaseId: string, expiresAt: number): void {
    const lease = this.leases.get(leaseId);
    if (lease) {
      this.leases.set(leaseId, Object.freeze({ ...lease, expiresAt }));
    }
  }

  /**
   * Fencing on membership epoch change: every lease bound to an older epoch
   * (or already expired) is removed and returned for revocation.
   */
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
