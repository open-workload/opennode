export const RUN_SUBMITTED_KIND = "run.submitted";
export const RUN_LEASE_GRANTED_KIND = "run.lease_granted";
export const RUN_LEASE_RENEWED_KIND = "run.lease_renewed";
export const RUN_ATTEMPT_OBSERVED_KIND = "run.attempt_observed";
export const RUN_CANCEL_REQUESTED_KIND = "run.cancel_requested";
export const RUN_RETRY_REQUESTED_KIND = "run.retry_requested";
export const RUN_ATTEMPT_FENCED_KIND = "run.attempt_fenced";

export interface RunSubmittedPayload {
  readonly type: "run.submitted";
  readonly runId: string;
  readonly clusterId: string;
  readonly actorId: string;
  readonly clientKey: string;
  readonly payloadHash: string;
  readonly spec: unknown;
  readonly createdAt: number;
}

export interface RunLeaseRenewedPayload {
  readonly type: "run.lease_renewed";
  readonly runId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
  readonly renewedAt: number;
  readonly fencingToken: number;
  readonly renewCount: number;
}

export interface RunLeaseGrantedPayload {
  readonly type: "run.lease_granted";
  readonly runId: string;
  readonly attempt: number;
  readonly leaseId: string;
  readonly workerNodeId: string;
  readonly membershipEpoch: number;
  readonly expiresAt: number;
  readonly grantedAt: number;
  readonly fencingToken: number;
}

export interface AttemptObservedPayload {
  readonly type: "run.attempt_observed";
  readonly runId: string;
  readonly attempt: number;
  readonly workerNodeId: string;
  readonly status: string;
  readonly reportedAt: number;
  readonly fencingToken: number;
  readonly duplicate: boolean;
  readonly note?: string;
}

export interface RunCancelRequestedPayload {
  readonly type: "run.cancel_requested";
  readonly runId: string;
  readonly cancelledBy: string;
  readonly requestedAt: number;
}

export interface RunRetryRequestedPayload {
  readonly type: "run.retry_requested";
  readonly runId: string;
  readonly retryBy: string;
  readonly requestedAt: number;
}

export interface AttemptFencedPayload {
  readonly type: "run.attempt_fenced";
  readonly runId: string;
  readonly attempt: number;
  readonly leaseId: string | null;
  readonly reason:
    | "lease_expired"
    | "membership_epoch_advanced"
    | "worker_lost"
    | "provider_outage"
    | "cancel_requested";
  readonly fencedAt: number;
}

export type RunEventPayload =
  | RunSubmittedPayload
  | RunLeaseGrantedPayload
  | AttemptObservedPayload
  | RunCancelRequestedPayload
  | RunRetryRequestedPayload
  | AttemptFencedPayload;

export function isRunKind(kind: string): boolean {
  return (
    kind === RUN_SUBMITTED_KIND ||
    kind === RUN_LEASE_GRANTED_KIND ||
    kind === RUN_ATTEMPT_OBSERVED_KIND ||
    kind === RUN_CANCEL_REQUESTED_KIND ||
    kind === RUN_RETRY_REQUESTED_KIND ||
    kind === RUN_ATTEMPT_FENCED_KIND
  );
}
