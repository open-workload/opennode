export type RunCoordinatorErrorCode =
  | "INVALID_SUBMISSION"
  | "INVALID_RUN_SPEC"
  | "QUOTA_EXCEEDED"
  | "IMAGE_POLICY_VIOLATION"
  | "SECRET_REF_VIOLATION"
  | "IDEMPOTENCY_CONFLICT"
  | "RUN_NOT_FOUND"
  | "RUN_TERMINAL"
  | "RUN_NOT_RETRYABLE"
  | "RUN_CANCELLED"
  | "ATTEMPT_NOT_FOUND"
  | "STALE_FENCING_TOKEN"
  | "LEASE_CONFLICT"
  | "LEASE_EXPIRED"
  | "NO_ELIGIBLE_WORKER"
  | "NOT_CLUSTER_MEMBER"
  | "STALE_MEMBERSHIP_EPOCH"
  | "WRONG_CLUSTER"
  | "DUPLICATE_REPORT"
  | "PROVIDER_OUTAGE"
  | "PARTITION_NO_QUORUM"
  | "INVALID_TRANSITION"
  | "EXECUTION_DISABLED";

export class RunCoordinatorError extends Error {
  constructor(
    public readonly code: RunCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunCoordinatorError";
  }
}
