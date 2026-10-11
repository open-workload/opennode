/**
 * GOV-21 error taxonomy: one total map from domain error code to exactly one
 * category and HTTP status, plus the response mapper routes share.
 *
 *   DomainError(code) ──▶ ERROR_TAXONOMY[code] ──▶ { category, httpStatus }
 *                                    │
 *            mapDomainError ─────────┴──▶ { status, code, category, error }
 *                                              │
 *                              res.status(...).json(...)  (code stays stable)
 *
 * authorization ─▶ 403 │ decision ─▶ 409 │ validation ─▶ 400 (404 for an
 * unknown resource id). The Record type makes the map compile-time total over
 * DomainErrorCode: a new domain code fails tsc until it is categorized.
 */

import { type DomainError, type DomainErrorCode } from "@workspace/opennode-domain";

export type ErrorCategory = "authorization" | "decision" | "validation";

export type TaxonomyStatus = 400 | 403 | 404 | 409;

export interface TaxonomyEntry {
  readonly category: ErrorCategory;
  readonly httpStatus: TaxonomyStatus;
}

const AUTHORIZATION: TaxonomyEntry = { category: "authorization", httpStatus: 403 };
const DECISION: TaxonomyEntry = { category: "decision", httpStatus: 409 };
const VALIDATION: TaxonomyEntry = { category: "validation", httpStatus: 400 };
const NOT_FOUND: TaxonomyEntry = { category: "validation", httpStatus: 404 };

export const ERROR_TAXONOMY: Record<DomainErrorCode, TaxonomyEntry> = {
  INVALID_IDENTIFIER: VALIDATION,
  INVALID_ELECTORATE: VALIDATION,
  INVALID_EPOCH: VALIDATION,
  INVALID_PROPOSAL: VALIDATION,
  INVALID_RESPONSE: VALIDATION,
  INVALID_WORKLOAD: VALIDATION,
  INVALID_RUN: VALIDATION,
  INVALID_SCHEMA: VALIDATION,
  INVALID_JOB: VALIDATION,
  INVALID_ATTEMPT: VALIDATION,
  INVALID_VOTE: VALIDATION,
  INVALID_EVENT: VALIDATION,
  INVALID_NODE_IDENTITY: VALIDATION,
  INVALID_IDEMPOTENCY_KEY: VALIDATION,
  INVALID_BALLOT: VALIDATION,
  INVALID_AUDIT_EVENT: VALIDATION,
  PROPOSAL_NOT_FOUND: NOT_FOUND,

  UNAUTHORIZED_VOTER: AUTHORIZATION,
  CANDIDATE_CANNOT_VOTE: AUTHORIZATION,
  TARGET_CANNOT_VOTE: AUTHORIZATION,
  NOT_A_MEMBER: AUTHORIZATION,

  DUPLICATE_VOTE: DECISION,
  DUPLICATE_RESPONSE: DECISION,
  VOLUNTARY_LEAVE_REQUIRES_NO_VOTE: DECISION,
  INVALID_RUN_TRANSITION: DECISION,
  INVALID_JOB_TRANSITION: DECISION,
  INVALID_ATTEMPT_TRANSITION: DECISION,
  IDEMPOTENCY_CONFLICT: DECISION,
  IDEMPOTENCY_EXPIRED: DECISION,
  VOTE_EXPIRED: DECISION,
  PROPOSAL_CLOSED: DECISION,
  PROPOSAL_EXPIRED: DECISION,
  STALE_EPOCH: DECISION,
  REPLAYED_BALLOT: DECISION,
  DUPLICATE_BALLOT: DECISION,
  CONFLICTING_BALLOT: DECISION,
  INVALID_DECISION: DECISION,
  ALREADY_A_MEMBER: DECISION,
  DECISION_NOT_FINAL: DECISION,
  IDENTITY_COLLISION: DECISION,
};

export interface MappedDomainError {
  readonly status: TaxonomyStatus;
  readonly code: DomainErrorCode;
  readonly category: ErrorCategory;
  readonly error: string;
}

export function mapDomainError(err: DomainError): MappedDomainError {
  const entry = ERROR_TAXONOMY[err.code];
  return {
    status: entry.httpStatus,
    code: err.code,
    category: entry.category,
    error: err.message,
  };
}
