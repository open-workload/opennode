export type MembershipLogErrorCode =
  | "MEMBERSHIP_LOG_INVALID"
  | "MEMBERSHIP_NOT_COMMITTED"
  | "MEMBERSHIP_EPOCH_REGRESSION"
  | "MEMBERSHIP_DIVERGENCE"
  | "INVALID_LEAVE_SIGNATURE"
  | "ADMISSION_THRESHOLD_NOT_MET"
  | "EVICTION_THRESHOLD_NOT_MET"
  | "SUBJECT_ALREADY_MEMBER"
  | "SUBJECT_NOT_MEMBER"
  | "LEASE_STALE"
  | "WRONG_CLUSTER"
  | "NOT_LEADER";

export class MembershipLogError extends Error {
  constructor(
    public readonly code: MembershipLogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MembershipLogError";
  }
}
