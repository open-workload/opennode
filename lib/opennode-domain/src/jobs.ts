import { DomainError } from "./errors";
import {
  createAttempt,
  createJobSpec,
  SCHEMA_VERSION,
  Attempt,
  JobSpec,
} from "./schemas";

export type JobState =
  | "queued"
  | "starting"
  | "running"
  | "cancel-requested"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out"
  | "infrastructure-error"
  | "lost";

export type AttemptState = JobState;

export interface Job {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly spec: JobSpec;
  readonly state: JobState;
}

export interface JobAttempt {
  readonly attempt: Attempt;
  readonly state: AttemptState;
}

const LEGAL_JOB_TRANSITIONS: Readonly<
  Record<JobState, readonly JobState[]>
> = {
  queued: ["starting", "cancel-requested", "cancelled", "infrastructure-error"],
  starting: [
    "running",
    "failed",
    "cancel-requested",
    "cancelled",
    "timed-out",
    "infrastructure-error",
    "lost",
  ],
  running: [
    "succeeded",
    "failed",
    "cancel-requested",
    "timed-out",
    "infrastructure-error",
    "lost",
  ],
  "cancel-requested": [
    "cancelled",
    "failed",
    "timed-out",
    "infrastructure-error",
    "lost",
  ],
  "infrastructure-error": [],
  succeeded: [],
  failed: [],
  cancelled: [],
  "timed-out": [],
  lost: [],
};

const LEGAL_ATTEMPT_TRANSITIONS: Readonly<
  Record<AttemptState, readonly AttemptState[]>
> = {
  queued: ["starting", "cancel-requested", "cancelled", "infrastructure-error"],
  starting: [
    "running",
    "failed",
    "cancel-requested",
    "cancelled",
    "timed-out",
    "infrastructure-error",
    "lost",
  ],
  running: [
    "succeeded",
    "failed",
    "cancel-requested",
    "timed-out",
    "infrastructure-error",
    "lost",
  ],
  "cancel-requested": [
    "cancelled",
    "failed",
    "timed-out",
    "infrastructure-error",
    "lost",
  ],
  "infrastructure-error": [],
  succeeded: [],
  failed: [],
  cancelled: [],
  "timed-out": [],
  lost: [],
};

export function createJob(spec: JobSpec): Job {
  createJobSpec({
    jobId: spec.jobId,
    clusterId: spec.clusterId,
    image: spec.image,
    createdBy: spec.createdBy,
  });
  return Object.freeze({
    schemaVersion: spec.schemaVersion,
    spec,
    state: "queued" as const,
  });
}

export function transitionJob(job: Job, nextState: JobState): Job {
  if (typeof job !== "object" || job === null || !isJobState(job.state)) {
    throw new DomainError("INVALID_JOB", "Job contains an unknown state.");
  }
  if (!isJobState(nextState)) {
    throw new DomainError("INVALID_JOB", "Unknown job state.");
  }
  if (!LEGAL_JOB_TRANSITIONS[job.state].includes(nextState)) {
    throw new DomainError(
      "INVALID_JOB_TRANSITION",
      `Job cannot transition from ${job.state} to ${nextState}.`,
    );
  }
  return Object.freeze({ ...job, state: nextState });
}

export function createJobAttempt(attempt: Attempt): JobAttempt {
  createAttempt({
    attemptId: attempt.attemptId,
    jobId: attempt.jobId,
    ordinal: attempt.ordinal,
  });
  return Object.freeze({ attempt, state: "queued" as const });
}

export function transitionAttempt(
  attempt: JobAttempt,
  nextState: AttemptState,
): JobAttempt {
  if (typeof attempt !== "object" || attempt === null || !isAttemptState(attempt.state)) {
    throw new DomainError(
      "INVALID_ATTEMPT",
      "Attempt contains an unknown state.",
    );
  }
  if (!isAttemptState(nextState)) {
    throw new DomainError("INVALID_ATTEMPT", "Unknown attempt state.");
  }
  if (!LEGAL_ATTEMPT_TRANSITIONS[attempt.state].includes(nextState)) {
    throw new DomainError(
      "INVALID_ATTEMPT_TRANSITION",
      `Attempt cannot transition from ${attempt.state} to ${nextState}.`,
    );
  }
  return Object.freeze({ ...attempt, state: nextState });
}

export function isTerminalJobState(state: JobState): boolean {
  return (
    state === "succeeded" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "timed-out" ||
    state === "infrastructure-error" ||
    state === "lost"
  );
}

function isJobState(value: string): value is JobState {
  return Object.prototype.hasOwnProperty.call(LEGAL_JOB_TRANSITIONS, value);
}

function isAttemptState(value: string): value is AttemptState {
  return Object.prototype.hasOwnProperty.call(
    LEGAL_ATTEMPT_TRANSITIONS,
    value,
  );
}
