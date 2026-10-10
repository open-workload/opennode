/**
 * The domain error vocabulary: a closed set of codes plus one Error subclass.
 *
 *   call site ──▶ new DomainError(code, message) ──▶ throw ──▶ caller catches
 *                                      │            │
 *                        code: one of  │            │  message: free text
 *                        DomainErrorCode           │
 *
 * No status code and no HTTP mapping live here: each caller shapes `code` into
 * whatever it needs. Only api-server routes/membership.ts tests instanceof today.
 */
export type DomainErrorCode =
  | "INVALID_IDENTIFIER"
  | "INVALID_ELECTORATE"
  | "INVALID_EPOCH"
  | "INVALID_PROPOSAL"
  | "UNAUTHORIZED_VOTER"
  | "CANDIDATE_CANNOT_VOTE"
  | "TARGET_CANNOT_VOTE"
  | "DUPLICATE_VOTE"
  | "DUPLICATE_RESPONSE"
  | "INVALID_RESPONSE"
  | "VOLUNTARY_LEAVE_REQUIRES_NO_VOTE"
  | "INVALID_WORKLOAD"
  | "INVALID_RUN"
  | "INVALID_RUN_TRANSITION"
  | "INVALID_SCHEMA"
  | "INVALID_JOB"
  | "INVALID_JOB_TRANSITION"
  | "INVALID_ATTEMPT"
  | "INVALID_ATTEMPT_TRANSITION"
  | "INVALID_VOTE"
  | "INVALID_EVENT"
  | "IDENTITY_COLLISION"
  | "INVALID_NODE_IDENTITY"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_EXPIRED"
  | "INVALID_AUDIT_EVENT"
  | "VOTE_EXPIRED"
  | "PROPOSAL_NOT_FOUND"
  | "PROPOSAL_CLOSED"
  | "PROPOSAL_EXPIRED"
  | "STALE_EPOCH"
  | "REPLAYED_BALLOT"
  | "DUPLICATE_BALLOT"
  | "CONFLICTING_BALLOT"
  | "INVALID_BALLOT"
  | "INVALID_DECISION"
  | "ALREADY_A_MEMBER"
  | "NOT_A_MEMBER"
  | "DECISION_NOT_FINAL";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
