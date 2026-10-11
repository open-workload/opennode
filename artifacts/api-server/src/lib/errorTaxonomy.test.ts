import { describe, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@workspace/opennode-domain";
import { ERROR_TAXONOMY, mapDomainError } from "./errorTaxonomy";

const AUTHORIZATION_403: readonly DomainErrorCode[] = [
  "UNAUTHORIZED_VOTER",
  "CANDIDATE_CANNOT_VOTE",
  "TARGET_CANNOT_VOTE",
  "NOT_A_MEMBER",
];

const VALIDATION_400: readonly DomainErrorCode[] = [
  "INVALID_IDENTIFIER",
  "INVALID_ELECTORATE",
  "INVALID_EPOCH",
  "INVALID_PROPOSAL",
  "INVALID_RESPONSE",
  "INVALID_WORKLOAD",
  "INVALID_RUN",
  "INVALID_SCHEMA",
  "INVALID_JOB",
  "INVALID_ATTEMPT",
  "INVALID_VOTE",
  "INVALID_EVENT",
  "INVALID_NODE_IDENTITY",
  "INVALID_IDEMPOTENCY_KEY",
  "INVALID_BALLOT",
  "INVALID_AUDIT_EVENT",
];

const VALIDATION_404: readonly DomainErrorCode[] = ["PROPOSAL_NOT_FOUND"];

const DECISION_409: readonly DomainErrorCode[] = [
  "DUPLICATE_VOTE",
  "DUPLICATE_RESPONSE",
  "VOLUNTARY_LEAVE_REQUIRES_NO_VOTE",
  "INVALID_RUN_TRANSITION",
  "INVALID_JOB_TRANSITION",
  "INVALID_ATTEMPT_TRANSITION",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_EXPIRED",
  "VOTE_EXPIRED",
  "PROPOSAL_CLOSED",
  "PROPOSAL_EXPIRED",
  "STALE_EPOCH",
  "REPLAYED_BALLOT",
  "DUPLICATE_BALLOT",
  "CONFLICTING_BALLOT",
  "INVALID_DECISION",
  "ALREADY_A_MEMBER",
  "DECISION_NOT_FINAL",
  "IDENTITY_COLLISION",
];

const VALIDATION_ALL = [...VALIDATION_400, ...VALIDATION_404];
const ALL = [...AUTHORIZATION_403, ...VALIDATION_ALL, ...DECISION_409];

describe("errorTaxonomy (GOV-21)", () => {
  it("maps every domain error code to exactly one category", () => {
    expect(ALL.length).toBe(40);
    expect(new Set(ALL).size).toBe(ALL.length);
    expect(Object.keys(ERROR_TAXONOMY).sort()).toEqual([...ALL].sort());
  });

  it("assigns each code to one and only one category bucket", () => {
    for (const code of ALL) {
      const memberships = [
        AUTHORIZATION_403.includes(code),
        VALIDATION_ALL.includes(code),
        DECISION_409.includes(code),
      ].filter(Boolean);
      expect(memberships, code).toHaveLength(1);
      expect(ERROR_TAXONOMY[code], code).toBeDefined();
    }
  });

  it("maps authorization failures to 403, decision failures to 409, validation to 400/404", () => {
    for (const code of AUTHORIZATION_403) {
      expect(ERROR_TAXONOMY[code], code).toEqual({ category: "authorization", httpStatus: 403 });
    }
    for (const code of DECISION_409) {
      expect(ERROR_TAXONOMY[code], code).toEqual({ category: "decision", httpStatus: 409 });
    }
    for (const code of VALIDATION_400) {
      expect(ERROR_TAXONOMY[code], code).toEqual({ category: "validation", httpStatus: 400 });
    }
    for (const code of VALIDATION_404) {
      expect(ERROR_TAXONOMY[code], code).toEqual({ category: "validation", httpStatus: 404 });
    }
  });

  it("counts one category per bucket over the whole taxonomy", () => {
    const counts = { authorization: 0, decision: 0, validation: 0 };
    for (const entry of Object.values(ERROR_TAXONOMY)) {
      counts[entry.category] += 1;
    }
    expect(counts).toEqual({ authorization: 4, decision: 19, validation: 17 });
  });

  it("maps a DomainError to its HTTP status, stable code, and category", () => {
    expect(mapDomainError(new DomainError("UNAUTHORIZED_VOTER", "voter not eligible"))).toEqual({
      status: 403,
      code: "UNAUTHORIZED_VOTER",
      category: "authorization",
      error: "voter not eligible",
    });
    expect(mapDomainError(new DomainError("PROPOSAL_NOT_FOUND", "unknown proposal"))).toEqual({
      status: 404,
      code: "PROPOSAL_NOT_FOUND",
      category: "validation",
      error: "unknown proposal",
    });
    expect(mapDomainError(new DomainError("PROPOSAL_CLOSED", "ballot closed"))).toEqual({
      status: 409,
      code: "PROPOSAL_CLOSED",
      category: "decision",
      error: "ballot closed",
    });
  });
});
