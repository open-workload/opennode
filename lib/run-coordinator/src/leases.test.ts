import { describe, expect, it } from "vitest";
import { LeaseRegistry } from "@workspace/membership-log";
import { RunCoordinatorError, type RunCoordinatorErrorCode } from "./errors";
import {
  LEASE_RENEWAL_INTERVAL_MS,
  MAX_LEASE_TTL_MS,
  compareFencingTokens,
  computeLeaseTtl,
  isCommittedLeaseUsable,
  isFreshFencingToken,
  registerInMembershipRegistry,
  validateLeaseRenewalRequest,
  validateLeaseTtlConfig,
  type CommittedLease,
  type LeaseRenewalRequest,
} from "./leases";

function committedLease(
  overrides: Partial<CommittedLease> = {},
): CommittedLease {
  return {
    leaseId: "lease-1",
    runId: "run-1",
    attempt: 1,
    workerNodeId: "node-1",
    membershipEpoch: 3,
    expiresAt: 1_000,
    fencingToken: 7,
    grantedAt: 100,
    renewedAt: 500,
    renewCount: 1,
    ...overrides,
  };
}

function renewalRequest(
  overrides: Partial<LeaseRenewalRequest> = {},
): LeaseRenewalRequest {
  return {
    leaseId: "lease-1",
    runId: "run-1",
    attempt: 1,
    workerNodeId: "node-1",
    fencingToken: 7,
    requestedAt: 900,
    ...overrides,
  };
}

function renewalErrorCodeOf(
  request: LeaseRenewalRequest,
): RunCoordinatorErrorCode | undefined {
  try {
    validateLeaseRenewalRequest(request);
    return undefined;
  } catch (err) {
    if (err instanceof RunCoordinatorError) return err.code;
    throw err;
  }
}

describe("computeLeaseTtl", () => {
  it("returns the remaining time when it is under the TTL ceiling", () => {
    expect(computeLeaseTtl(25_000, 10_000)).toBe(15_000);
  });

  it("never exceeds MAX_LEASE_TTL_MS", () => {
    expect(computeLeaseTtl(120_000, 0)).toBe(MAX_LEASE_TTL_MS);
    expect(computeLeaseTtl(60_000, 10_000)).toBe(MAX_LEASE_TTL_MS);
    for (const elapsed of [0, 5_000, 59_999, 60_000, 61_000]) {
      expect(computeLeaseTtl(60_000, elapsed)).toBeLessThanOrEqual(
        MAX_LEASE_TTL_MS,
      );
    }
  });

  it("clamps to 0 when the run timeout is exhausted", () => {
    expect(computeLeaseTtl(10_000, 10_000)).toBe(0);
    expect(computeLeaseTtl(10_000, 12_000)).toBe(0);
  });
});

describe("isCommittedLeaseUsable", () => {
  it("accepts an unexpired lease on the current epoch", () => {
    expect(isCommittedLeaseUsable(committedLease(), 3, 0)).toBe(true);
    expect(isCommittedLeaseUsable(committedLease(), 3, 999)).toBe(true);
  });

  it("rejects a lease at or past its expiry", () => {
    expect(isCommittedLeaseUsable(committedLease(), 3, 1_000)).toBe(false);
    expect(isCommittedLeaseUsable(committedLease(), 3, 1_001)).toBe(false);
  });

  it("rejects a lease bound to another membership epoch", () => {
    expect(isCommittedLeaseUsable(committedLease(), 2, 0)).toBe(false);
    expect(isCommittedLeaseUsable(committedLease(), 4, 0)).toBe(false);
  });
});

describe("compareFencingTokens", () => {
  it("orders by token, higher wins", () => {
    const lower = committedLease({ leaseId: "a", fencingToken: 5 });
    const higher = committedLease({ leaseId: "b", fencingToken: 6 });
    expect(compareFencingTokens(higher, lower)).toBeGreaterThan(0);
    expect(compareFencingTokens(lower, higher)).toBeLessThan(0);
  });

  it("breaks token ties by leaseId", () => {
    const a = committedLease({ leaseId: "lease-a", fencingToken: 7 });
    const b = committedLease({ leaseId: "lease-b", fencingToken: 7 });
    expect(compareFencingTokens(a, b)).toBeLessThan(0);
    expect(compareFencingTokens(b, a)).toBeGreaterThan(0);
    expect(compareFencingTokens(a, a)).toBe(0);
  });

  it("sorts a mixed list deterministically, highest token last", () => {
    const leases = [
      committedLease({ leaseId: "c", fencingToken: 9 }),
      committedLease({ leaseId: "a", fencingToken: 2 }),
      committedLease({ leaseId: "b", fencingToken: 9 }),
    ];
    const sorted = [...leases].sort(compareFencingTokens);
    expect(sorted.map((l) => l.leaseId)).toEqual(["a", "b", "c"]);
  });
});

describe("isFreshFencingToken", () => {
  it("matches the current token exactly and nothing else", () => {
    const current = committedLease({ fencingToken: 7 });
    expect(isFreshFencingToken(7, current)).toBe(true);
    expect(isFreshFencingToken(8, current)).toBe(false);
    expect(isFreshFencingToken(6, current)).toBe(false);
  });
});

describe("validateLeaseRenewalRequest", () => {
  it("accepts a well-formed request", () => {
    expect(() => validateLeaseRenewalRequest(renewalRequest())).not.toThrow();
  });

  it("rejects empty identifiers", () => {
    expect(renewalErrorCodeOf(renewalRequest({ leaseId: "" }))).toBe(
      "INVALID_SUBMISSION",
    );
    expect(renewalErrorCodeOf(renewalRequest({ runId: "" }))).toBe(
      "INVALID_SUBMISSION",
    );
    expect(renewalErrorCodeOf(renewalRequest({ workerNodeId: "" }))).toBe(
      "INVALID_SUBMISSION",
    );
  });

  it("rejects an attempt below 1", () => {
    expect(renewalErrorCodeOf(renewalRequest({ attempt: 0 }))).toBe(
      "INVALID_SUBMISSION",
    );
  });

  it("rejects a non-integer fencing token or timestamp", () => {
    expect(renewalErrorCodeOf(renewalRequest({ fencingToken: 7.5 }))).toBe(
      "INVALID_SUBMISSION",
    );
    expect(renewalErrorCodeOf(renewalRequest({ requestedAt: 900.5 }))).toBe(
      "INVALID_SUBMISSION",
    );
  });
});

describe("registerInMembershipRegistry", () => {
  it("round-trips a CommittedLease into the membership-log LeaseRegistry", () => {
    const lease = committedLease();
    const registry = new LeaseRegistry();
    registerInMembershipRegistry(lease, registry);

    expect(registry.get(lease.leaseId)).toEqual({
      leaseId: lease.leaseId,
      runId: lease.runId,
      attempt: lease.attempt,
      workerNodeId: lease.workerNodeId,
      membershipEpoch: lease.membershipEpoch,
      expiresAt: lease.expiresAt,
    });
    expect(registry.getByRunAndAttempt(lease.runId, lease.attempt)).toEqual(
      registry.get(lease.leaseId),
    );
  });

  it("feeds the fenced-out leases on epoch advancement", () => {
    const lease = committedLease();
    const registry = new LeaseRegistry();
    registerInMembershipRegistry(lease, registry);

    const stale = registry.fenceOnEpochChange(lease.membershipEpoch + 1, 0);
    expect(stale.map((l) => l.leaseId)).toEqual([lease.leaseId]);
    expect(registry.get(lease.leaseId)).toBeUndefined();
  });

  it("throws INVALID_SUBMISSION on an invalid committed lease", () => {
    const registry = new LeaseRegistry();
    expect(() =>
      registerInMembershipRegistry(committedLease({ leaseId: "" }), registry),
    ).toThrow(RunCoordinatorError);
    expect(registry.list()).toHaveLength(0);
  });
});

describe("validateLeaseTtlConfig (RUN-03 startup validation)", () => {
  const BASE_CONFIG = {
    ttlMs: 60_000,
    renewalIntervalMs: 10_000,
    maxObservationGapMs: 30_000,
    maxWallClockMs: 45_000,
    safetyMarginMs: 10_000,
  };

  it("accepts a compliant config", () => {
    expect(validateLeaseTtlConfig(BASE_CONFIG)).toEqual({ ok: true });
  });

  it("accepts the repo defaults: MAX_LEASE_TTL_MS over LEASE_RENEWAL_INTERVAL_MS", () => {
    expect(
      validateLeaseTtlConfig({
        ttlMs: MAX_LEASE_TTL_MS,
        renewalIntervalMs: LEASE_RENEWAL_INTERVAL_MS,
        maxObservationGapMs: 25_000,
        maxWallClockMs: 20_000,
        safetyMarginMs: 5_000,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a TTL below 2x the renewal interval, accepts exactly 2x", () => {
    const nearMiss = validateLeaseTtlConfig({
      ttlMs: 19_999,
      renewalIntervalMs: 10_000,
      maxObservationGapMs: 15_000,
      maxWallClockMs: 15_000,
      safetyMarginMs: 5_000,
    });
    expect(nearMiss.ok).toBe(false);
    if (!nearMiss.ok) expect(nearMiss.reason).toContain("renewal interval");

    expect(
      validateLeaseTtlConfig({
        ttlMs: 20_000,
        renewalIntervalMs: 10_000,
        maxObservationGapMs: 15_000,
        maxWallClockMs: 15_000,
        safetyMarginMs: 5_000,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a TTL at or below the max observation-report gap", () => {
    const OBSERVATION_CONFIG = {
      renewalIntervalMs: 10_000,
      maxObservationGapMs: 30_000,
      maxWallClockMs: 25_000,
      safetyMarginMs: 5_000,
    };

    const atGap = validateLeaseTtlConfig({
      ...OBSERVATION_CONFIG,
      ttlMs: 30_000,
    });
    expect(atGap.ok).toBe(false);
    if (!atGap.ok) expect(atGap.reason).toContain("observation");

    const belowGap = validateLeaseTtlConfig({
      ...OBSERVATION_CONFIG,
      ttlMs: 29_999,
    });
    expect(belowGap.ok).toBe(false);
    if (!belowGap.ok) expect(belowGap.reason).toContain("observation");

    expect(
      validateLeaseTtlConfig({
        ...OBSERVATION_CONFIG,
        ttlMs: 30_001,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a TTL below max workload wall-clock plus safety margin", () => {
    const result = validateLeaseTtlConfig({
      ...BASE_CONFIG,
      ttlMs: 54_999,
      maxWallClockMs: 45_000,
      safetyMarginMs: 10_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("wall-clock");

    expect(
      validateLeaseTtlConfig({
        ...BASE_CONFIG,
        ttlMs: 55_000,
        maxWallClockMs: 45_000,
        safetyMarginMs: 10_000,
      }),
    ).toEqual({ ok: true });
  });

  it("reports the first violated rule in a stable order", () => {
    const allViolations = validateLeaseTtlConfig({
      ttlMs: 1_000,
      renewalIntervalMs: 10_000,
      maxObservationGapMs: 30_000,
      maxWallClockMs: 45_000,
      safetyMarginMs: 10_000,
    });
    expect(allViolations.ok).toBe(false);
    if (!allViolations.ok) {
      expect(allViolations.reason).toContain("renewal interval");
    }
  });
});
