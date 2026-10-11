import { describe, it, expect } from "vitest";
import {
  LeaseRegistry,
  isLeaseStale,
  partitionLeases,
  type LeaseRecord,
} from "./leases";

const EPOCH = 2;
const NOW = 100;

function makeLease(overrides: Partial<LeaseRecord> = {}): LeaseRecord {
  return {
    leaseId: "lease-1",
    runId: "run-1",
    attempt: 0,
    workerNodeId: "node-1",
    membershipEpoch: EPOCH,
    expiresAt: NOW + 50,
    ...overrides,
  };
}

describe("isLeaseStale", () => {
  it("is false on the current epoch while the lease is unexpired", () => {
    expect(isLeaseStale(makeLease({ membershipEpoch: EPOCH, expiresAt: NOW + 1 }), EPOCH, NOW)).toBe(
      false,
    );
  });

  it("is true on an epoch mismatch alone, even far from expiry", () => {
    expect(isLeaseStale(makeLease({ membershipEpoch: EPOCH - 1, expiresAt: NOW + 10_000 }), EPOCH, NOW)).toBe(
      true,
    );
    expect(isLeaseStale(makeLease({ membershipEpoch: EPOCH + 1, expiresAt: NOW + 10_000 }), EPOCH, NOW)).toBe(
      true,
    );
  });

  it("is true exactly at expiresAt (boundary is <=, not <)", () => {
    expect(isLeaseStale(makeLease({ membershipEpoch: EPOCH, expiresAt: NOW }), EPOCH, NOW)).toBe(
      true,
    );
  });

  it("is true once now passes expiresAt", () => {
    expect(isLeaseStale(makeLease({ membershipEpoch: EPOCH, expiresAt: NOW - 1 }), EPOCH, NOW)).toBe(
      true,
    );
  });
});

describe("partitionLeases", () => {
  const validA = makeLease({ leaseId: "a", expiresAt: NOW + 50 });
  const staleEpoch = makeLease({ leaseId: "b", membershipEpoch: EPOCH - 1, expiresAt: NOW + 50 });
  const staleExpired = makeLease({ leaseId: "c", expiresAt: NOW });
  const validD = makeLease({ leaseId: "d", expiresAt: NOW + 90 });
  const mixed = [validA, staleEpoch, staleExpired, validD];

  it("splits a mixed list into the valid and stale buckets", () => {
    const result = partitionLeases(mixed, EPOCH, NOW);
    expect(result.valid).toEqual([validA, validD]);
    expect(result.stale).toEqual([staleEpoch, staleExpired]);
  });

  it("preserves relative order within each partition", () => {
    const firstValid = makeLease({ leaseId: "v1", expiresAt: NOW + 10 });
    const firstStale = makeLease({ leaseId: "s1", membershipEpoch: EPOCH - 1 });
    const secondValid = makeLease({ leaseId: "v2", expiresAt: NOW + 20 });
    const secondStale = makeLease({ leaseId: "s2", expiresAt: NOW - 1 });
    const result = partitionLeases(
      [firstValid, firstStale, secondValid, secondStale],
      EPOCH,
      NOW,
    );
    expect(result.valid).toEqual([firstValid, secondValid]);
    expect(result.stale).toEqual([firstStale, secondStale]);
  });

  it("does not mutate the input array", () => {
    const leases = [...mixed];
    const before = [...leases];
    partitionLeases(leases, EPOCH, NOW);
    expect(leases).toHaveLength(before.length);
    expect(leases).toEqual(before);
    for (let i = 0; i < before.length; i += 1) {
      expect(leases[i]).toBe(before[i]);
    }
  });

  it("returns frozen partitions", () => {
    const result = partitionLeases(mixed, EPOCH, NOW);
    expect(Object.isFrozen(result.valid)).toBe(true);
    expect(Object.isFrozen(result.stale)).toBe(true);
  });
});

describe("LeaseRegistry", () => {
  it("returns the added lease from get with equal fields", () => {
    const registry = new LeaseRegistry();
    const lease = makeLease({
      leaseId: "lease-7",
      runId: "run-7",
      attempt: 3,
      workerNodeId: "node-7",
      membershipEpoch: 4,
      expiresAt: 5_000,
    });
    registry.add(lease);
    const fetched = registry.get("lease-7");
    expect(fetched).toEqual(lease);
  });

  it("returns undefined from get for an unknown lease id", () => {
    const registry = new LeaseRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("removes a present lease, reports true, and forgets it", () => {
    const registry = new LeaseRegistry();
    registry.add(makeLease());
    expect(registry.remove("lease-1")).toBe(true);
    expect(registry.get("lease-1")).toBeUndefined();
  });

  it("reports false when removing an absent lease", () => {
    const registry = new LeaseRegistry();
    expect(registry.remove("missing")).toBe(false);
  });

  it("finds a lease by run id and attempt", () => {
    const registry = new LeaseRegistry();
    const target = makeLease({ leaseId: "target", runId: "run-a", attempt: 2 });
    registry.add(target);
    registry.add(makeLease({ leaseId: "other", runId: "run-a", attempt: 1 }));
    expect(registry.getByRunAndAttempt("run-a", 2)).toEqual(target);
  });

  it("returns undefined from getByRunAndAttempt for a wrong attempt or run id", () => {
    const registry = new LeaseRegistry();
    registry.add(makeLease({ leaseId: "target", runId: "run-a", attempt: 2 }));
    expect(registry.getByRunAndAttempt("run-a", 7)).toBeUndefined();
    expect(registry.getByRunAndAttempt("run-b", 2)).toBeUndefined();
  });

  it("returns undefined from getByRunAndAttempt in an empty registry", () => {
    expect(new LeaseRegistry().getByRunAndAttempt("run-a", 0)).toBeUndefined();
  });

  it("lists nothing before any lease is added", () => {
    expect(new LeaseRegistry().list()).toEqual([]);
  });

  it("lists every added lease in insertion order, frozen", () => {
    const registry = new LeaseRegistry();
    const first = makeLease({ leaseId: "first" });
    const second = makeLease({ leaseId: "second" });
    registry.add(first);
    registry.add(second);
    const listed = registry.list();
    expect(listed).toEqual([first, second]);
    expect(Object.isFrozen(listed)).toBe(true);
  });

  it("extends expiry with updateExpiry so an expired lease becomes non-stale", () => {
    const registry = new LeaseRegistry();
    registry.add(makeLease({ membershipEpoch: EPOCH, expiresAt: NOW - 10 }));
    expect(isLeaseStale(makeLease({ membershipEpoch: EPOCH, expiresAt: NOW - 10 }), EPOCH, NOW)).toBe(
      true,
    );

    registry.updateExpiry("lease-1", NOW + 500);
    const renewed = registry.get("lease-1");
    expect(renewed).toBeDefined();
    if (renewed === undefined) throw new Error("expected the renewed lease to exist");
    expect(renewed.expiresAt).toBe(NOW + 500);
    expect(isLeaseStale(renewed, EPOCH, NOW)).toBe(false);
  });

  it("ignores updateExpiry for an unknown lease id without throwing", () => {
    const registry = new LeaseRegistry();
    expect(() => registry.updateExpiry("missing", NOW + 500)).not.toThrow();
    expect(registry.list()).toEqual([]);
  });

  it("fences out and returns only stale leases, keeping current-epoch leases", () => {
    const registry = new LeaseRegistry();
    const olderEpoch = makeLease({ leaseId: "older-epoch", membershipEpoch: EPOCH - 1, expiresAt: NOW + 500 });
    const expired = makeLease({ leaseId: "expired", expiresAt: NOW });
    const current = makeLease({ leaseId: "current", expiresAt: NOW + 500 });
    registry.add(olderEpoch);
    registry.add(expired);
    registry.add(current);

    const fenced = registry.fenceOnEpochChange(EPOCH, NOW);
    expect(fenced).toEqual([olderEpoch, expired]);
    expect(Object.isFrozen(fenced)).toBe(true);
    expect(registry.get("older-epoch")).toBeUndefined();
    expect(registry.get("expired")).toBeUndefined();
    expect(registry.get("current")).toEqual(current);
  });

  it("returns an empty frozen list when fencing an empty registry", () => {
    const fenced = new LeaseRegistry().fenceOnEpochChange(EPOCH, NOW);
    expect(fenced).toEqual([]);
    expect(Object.isFrozen(fenced)).toBe(true);
  });
});
