import { describe, it, expect } from "vitest";
import { admissionThreshold, evictionThreshold } from "@workspace/opennode-domain";
import {
  assertAdmissionPassed,
  assertEvictionPassed,
  type CommittedAdmissionPayload,
  type CommittedEvictionPayload,
} from "./events";
import { MembershipLogError } from "./errors";

describe("admissionThreshold", () => {
  // These exact values pin the integer arithmetic: a floating-point
  // multiplication bug would produce a wrong value for at least one N in 1..20.
  it("returns the exact published threshold for every N from 1 to 20", () => {
    const actual: number[] = [];
    for (let n = 1; n <= 20; n += 1) {
      actual.push(admissionThreshold(n));
    }
    expect(actual).toEqual([1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4]);
  });

  it("applies the minimum-two floor, so admissionThreshold(2) is 2", () => {
    expect(admissionThreshold(2)).toBe(2);
  });

  it("requires 2 of 2 votes, i.e. unanimity, at N=2", () => {
    const electorateSize = 2;
    expect(admissionThreshold(electorateSize)).toBe(electorateSize);
  });

  it("returns 1 for a single-member electorate", () => {
    expect(admissionThreshold(1)).toBe(1);
  });
});

describe("evictionThreshold", () => {
  it("returns the exact published threshold for every N from 1 to 20", () => {
    const actual: number[] = [];
    for (let n = 1; n <= 20; n += 1) {
      actual.push(evictionThreshold(n));
    }
    expect(actual).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10]);
  });

  it("has no minimum-two floor, so a single vote of the two members evicts at N=2", () => {
    expect(evictionThreshold(2)).toBe(1);
  });

  it("returns 1 at N=1 even though eviction there is not expressible", () => {
    // Eviction at N=1 cannot actually happen: the single member is the target
    // and is excluded from voting, so no ballot can be cast and this threshold
    // is unreachable in practice.
    expect(evictionThreshold(1)).toBe(1);
  });
});

describe("assertAdmissionPassed", () => {
  // Defaults to a payload that PASSES: the threshold and yesVotes are derived
  // from the (possibly overridden) electorate denominator, so overriding just
  // `electorateDenominator` keeps threshold correct unless stated otherwise.
  function makeAdmission(overrides: Partial<CommittedAdmissionPayload> = {}): CommittedAdmissionPayload {
    const electorateDenominator = overrides.electorateDenominator ?? 5;
    return {
      type: "admission",
      proposalId: "proposal-1",
      subjectId: "subject-1",
      previousEpoch: 1,
      newEpoch: 2,
      electorateDenominator,
      threshold: admissionThreshold(electorateDenominator),
      yesVotes: admissionThreshold(electorateDenominator),
      ...overrides,
    };
  }

  // Pins the error `code` itself: a message-only match would not distinguish
  // ADMISSION_THRESHOLD_NOT_MET from any other MembershipLogError.
  function admissionErrorCode(payload: CommittedAdmissionPayload): string | undefined {
    try {
      assertAdmissionPassed(payload);
      return undefined;
    } catch (error) {
      if (error instanceof MembershipLogError) return error.code;
      throw error;
    }
  }

  it("throws ADMISSION_THRESHOLD_NOT_MET when threshold does not match admissionThreshold(electorateDenominator)", () => {
    expect(admissionErrorCode(makeAdmission({ threshold: admissionThreshold(5) + 1 }))).toBe(
      "ADMISSION_THRESHOLD_NOT_MET",
    );
    expect(admissionErrorCode(makeAdmission({ threshold: admissionThreshold(5) - 1 }))).toBe(
      "ADMISSION_THRESHOLD_NOT_MET",
    );
  });

  it("throws ADMISSION_THRESHOLD_NOT_MET when yesVotes is one below the correct threshold", () => {
    expect(
      admissionErrorCode(makeAdmission({ yesVotes: admissionThreshold(5) - 1 })),
    ).toBe("ADMISSION_THRESHOLD_NOT_MET");
  });

  it("does not throw when yesVotes is at or above the threshold", () => {
    expect(() => assertAdmissionPassed(makeAdmission())).not.toThrow();
    expect(() => assertAdmissionPassed(makeAdmission({ yesVotes: admissionThreshold(5) + 1 }))).not.toThrow();
  });

  it("requires 2 of 2 votes at N=2: one of two throws, two of two passes", () => {
    expect(admissionErrorCode(makeAdmission({ electorateDenominator: 2, yesVotes: 1 }))).toBe(
      "ADMISSION_THRESHOLD_NOT_MET",
    );
    expect(() => assertAdmissionPassed(makeAdmission({ electorateDenominator: 2, yesVotes: 2 }))).not.toThrow();
  });
});

describe("assertEvictionPassed", () => {
  // Defaults to a payload that PASSES: the threshold and yesVotes are derived
  // from the (possibly overridden) electorate denominator, so overriding just
  // `electorateDenominator` keeps threshold correct unless stated otherwise.
  function makeEviction(overrides: Partial<CommittedEvictionPayload> = {}): CommittedEvictionPayload {
    const electorateDenominator = overrides.electorateDenominator ?? 5;
    return {
      type: "eviction",
      proposalId: "proposal-1",
      subjectId: "subject-1",
      previousEpoch: 1,
      newEpoch: 2,
      electorateDenominator,
      threshold: evictionThreshold(electorateDenominator),
      yesVotes: evictionThreshold(electorateDenominator),
      ...overrides,
    };
  }

  // Pins the error `code` itself: a message-only match would not distinguish
  // EVICTION_THRESHOLD_NOT_MET from any other MembershipLogError.
  function evictionErrorCode(payload: CommittedEvictionPayload): string | undefined {
    try {
      assertEvictionPassed(payload);
      return undefined;
    } catch (error) {
      if (error instanceof MembershipLogError) return error.code;
      throw error;
    }
  }

  it("throws EVICTION_THRESHOLD_NOT_MET when threshold does not match evictionThreshold(electorateDenominator)", () => {
    expect(evictionErrorCode(makeEviction({ threshold: evictionThreshold(5) + 1 }))).toBe(
      "EVICTION_THRESHOLD_NOT_MET",
    );
    expect(evictionErrorCode(makeEviction({ threshold: evictionThreshold(5) - 1 }))).toBe(
      "EVICTION_THRESHOLD_NOT_MET",
    );
  });

  it("throws EVICTION_THRESHOLD_NOT_MET when yesVotes is one below the correct threshold", () => {
    expect(
      evictionErrorCode(makeEviction({ yesVotes: evictionThreshold(5) - 1 })),
    ).toBe("EVICTION_THRESHOLD_NOT_MET");
  });

  it("does not throw when yesVotes is at or above the threshold", () => {
    expect(() => assertEvictionPassed(makeEviction())).not.toThrow();
    expect(() => assertEvictionPassed(makeEviction({ yesVotes: evictionThreshold(5) + 1 }))).not.toThrow();
  });

  it("needs only 1 of 2 votes at N=2: zero of two throws, one of two passes", () => {
    expect(evictionErrorCode(makeEviction({ electorateDenominator: 2, yesVotes: 0 }))).toBe(
      "EVICTION_THRESHOLD_NOT_MET",
    );
    expect(() => assertEvictionPassed(makeEviction({ electorateDenominator: 2, yesVotes: 1 }))).not.toThrow();
  });
});
