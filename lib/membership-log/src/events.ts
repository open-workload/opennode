/**
 * Payload shapes for the three membership kinds, and the vote-threshold guard.
 *
 *   membership.admission | membership.eviction | membership.leave
 *        │                               │
 *        │                 payload: { previousEpoch, newEpoch, subjectId, ... }
 *        ▼                               ▼
 *   assertAdmissionPassed / assertEvictionPassed ──▶ threshold(denominator)
 *        │   yesVotes < threshold ──▶ ADMISSION/EVICTION_THRESHOLD_NOT_MET
 *        ▼
 *   leaveMessage() ──▶ "leave|cluster|subject|prevEpoch|newEpoch" ──▶ signed by leaver
 */
import {
  admissionThreshold,
  evictionThreshold,
} from "@workspace/opennode-domain";
import { MembershipLogError } from "./errors";

export const MEMBERSHIP_ADMISSION_KIND = "membership.admission";
export const MEMBERSHIP_EVICTION_KIND = "membership.eviction";
export const MEMBERSHIP_LEAVE_KIND = "membership.leave";

export interface CommittedAdmissionPayload {
  readonly type: "admission";
  readonly proposalId: string;
  readonly subjectId: string;
  readonly previousEpoch: number;
  readonly newEpoch: number;
  readonly electorateDenominator: number;
  readonly threshold: number;
  readonly yesVotes: number;
}

export interface CommittedEvictionPayload {
  readonly type: "eviction";
  readonly proposalId: string;
  readonly subjectId: string;
  readonly previousEpoch: number;
  readonly newEpoch: number;
  readonly electorateDenominator: number;
  readonly threshold: number;
  readonly yesVotes: number;
}

export interface CommittedLeavePayload {
  readonly type: "leave";
  readonly proposalId: string;
  readonly subjectId: string;
  readonly previousEpoch: number;
  readonly newEpoch: number;
  readonly signerNodeId: string;
  readonly signature: string;
}

export type MembershipDecisionPayload =
  | CommittedAdmissionPayload
  | CommittedEvictionPayload
  | CommittedLeavePayload;

export function leaveMessage(input: {
  readonly clusterId: string;
  readonly subjectId: string;
  readonly previousEpoch: number;
  readonly newEpoch: number;
}): string {
  return `leave|${input.clusterId}|${input.subjectId}|${input.previousEpoch}|${input.newEpoch}`;
}

export function assertAdmissionPassed(payload: CommittedAdmissionPayload): void {
  if (payload.threshold !== admissionThreshold(payload.electorateDenominator)) {
    throw new MembershipLogError("ADMISSION_THRESHOLD_NOT_MET", "Admission threshold not met.");
  }
  if (payload.yesVotes < payload.threshold) {
    throw new MembershipLogError("ADMISSION_THRESHOLD_NOT_MET", "Admission threshold not met.");
  }
}

export function assertEvictionPassed(payload: CommittedEvictionPayload): void {
  if (payload.threshold !== evictionThreshold(payload.electorateDenominator)) {
    throw new MembershipLogError("EVICTION_THRESHOLD_NOT_MET", "Eviction threshold not met.");
  }
  if (payload.yesVotes < payload.threshold) {
    throw new MembershipLogError("EVICTION_THRESHOLD_NOT_MET", "Eviction threshold not met.");
  }
}
