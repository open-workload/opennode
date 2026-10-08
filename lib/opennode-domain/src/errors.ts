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
  | "INVALID_RUN_TRANSITION";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
