/**
 * Versioned wire shapes and the constructors that validate them.
 *
 *   raw values ──▶ createNodeId | createClusterId | createJobSpec
 *                       │  createAttempt | createLogChunk | createArtifactRef
 *                       │  createVote | createClusterEvent
 *                       ▼  validateIdValue, assertNodeId/assertClusterId, range checks
 *                   frozen { schemaVersion: 1, ... }
 *
 * Shapes only: no storage, no transport, no schema registry. assertNodeId and
 * assertClusterId are the checks other files lean on.
 */
import { DomainError } from "./errors";

export const SCHEMA_VERSION = 1;

export interface NodeId {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly value: string;
}

export interface ClusterId {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly value: string;
}

export interface JobSpec {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly jobId: string;
  readonly clusterId: ClusterId;
  readonly image: string;
  readonly createdBy: NodeId;
}

export interface Attempt {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly attemptId: string;
  readonly jobId: string;
  readonly ordinal: number;
}

export type LogStream = "stdout" | "stderr";

export interface LogChunk {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly chunkId: string;
  readonly attemptId: string;
  readonly stream: LogStream;
  readonly sequence: number;
  readonly content: string;
}

export interface ArtifactRef {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly artifactId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly uri: string;
  readonly sha256: string;
}

export type BallotChoice = "yes" | "no";

export interface Vote {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly proposalId: string;
  readonly clusterId: ClusterId;
  readonly voterId: NodeId;
  readonly epoch: number;
  readonly choice: BallotChoice;
  readonly expiry: number;
}

export interface ClusterEvent<TPayload = unknown> {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly eventId: string;
  readonly clusterId: ClusterId;
  readonly sequence: number;
  readonly epoch: number;
  readonly kind: string;
  readonly correlationId: string;
  readonly payload: TPayload;
}

export function createNodeId(value: string): NodeId {
  validateIdValue(value, "Node ID");
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, value });
}

export function createClusterId(value: string): ClusterId {
  validateIdValue(value, "Cluster ID");
  return Object.freeze({ schemaVersion: SCHEMA_VERSION, value });
}

export function createJobSpec(input: {
  readonly jobId: string;
  readonly clusterId: ClusterId;
  readonly image: string;
  readonly createdBy: NodeId;
}): JobSpec {
  validateIdValue(input.jobId, "jobId");
  validateIdValue(input.image, "image");
  assertClusterId(input.clusterId);
  assertNodeId(input.createdBy);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    jobId: input.jobId,
    clusterId: input.clusterId,
    image: input.image,
    createdBy: input.createdBy,
  });
}

export function createAttempt(input: {
  readonly attemptId: string;
  readonly jobId: string;
  readonly ordinal: number;
}): Attempt {
  validateIdValue(input.attemptId, "attemptId");
  validateIdValue(input.jobId, "jobId");
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) {
    throw new DomainError(
      "INVALID_SCHEMA",
      "Attempt ordinal must be a non-negative safe integer.",
    );
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    attemptId: input.attemptId,
    jobId: input.jobId,
    ordinal: input.ordinal,
  });
}

export function createLogChunk(input: {
  readonly chunkId: string;
  readonly attemptId: string;
  readonly stream: LogStream;
  readonly sequence: number;
  readonly content: string;
}): LogChunk {
  validateIdValue(input.chunkId, "chunkId");
  validateIdValue(input.attemptId, "attemptId");
  if (input.stream !== "stdout" && input.stream !== "stderr") {
    throw new DomainError(
      "INVALID_SCHEMA",
      "Log stream must be stdout or stderr.",
    );
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new DomainError(
      "INVALID_SCHEMA",
      "Log chunk sequence must be a non-negative safe integer.",
    );
  }
  if (typeof input.content !== "string") {
    throw new DomainError("INVALID_SCHEMA", "Log content must be a string.");
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    chunkId: input.chunkId,
    attemptId: input.attemptId,
    stream: input.stream,
    sequence: input.sequence,
    content: input.content,
  });
}

export function createArtifactRef(input: {
  readonly artifactId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly uri: string;
  readonly sha256: string;
}): ArtifactRef {
  validateIdValue(input.artifactId, "artifactId");
  validateIdValue(input.jobId, "jobId");
  validateIdValue(input.attemptId, "attemptId");
  validateIdValue(input.uri, "uri");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new DomainError(
      "INVALID_SCHEMA",
      "Artifact sha256 must be 64 lowercase hex characters.",
    );
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    artifactId: input.artifactId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    uri: input.uri,
    sha256: input.sha256,
  });
}

export function createVote(input: {
  readonly proposalId: string;
  readonly clusterId: ClusterId;
  readonly voterId: NodeId;
  readonly epoch: number;
  readonly choice: BallotChoice;
  readonly expiry: number;
}): Vote {
  validateIdValue(input.proposalId, "proposalId");
  assertClusterId(input.clusterId);
  assertNodeId(input.voterId);
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new DomainError(
      "INVALID_VOTE",
      "Vote epoch must be a non-negative safe integer.",
    );
  }
  if (input.choice !== "yes" && input.choice !== "no") {
    throw new DomainError("INVALID_VOTE", "Vote choice must be yes or no.");
  }
  if (!Number.isSafeInteger(input.expiry) || input.expiry < 0) {
    throw new DomainError(
      "INVALID_VOTE",
      "Vote expiry must be a non-negative safe integer.",
    );
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    proposalId: input.proposalId,
    clusterId: input.clusterId,
    voterId: input.voterId,
    epoch: input.epoch,
    choice: input.choice,
    expiry: input.expiry,
  });
}

export function isVoteBoundTo(
  vote: Vote,
  binding: {
    readonly proposalId: string;
    readonly clusterId: ClusterId;
    readonly epoch: number;
  },
): boolean {
  return (
    vote.proposalId === binding.proposalId &&
    vote.clusterId.value === binding.clusterId.value &&
    vote.epoch === binding.epoch
  );
}

export function isVoteExpired(vote: Vote, now: number): boolean {
  if (!Number.isSafeInteger(now)) {
    throw new DomainError("INVALID_VOTE", "now must be a safe integer.");
  }
  return vote.expiry <= now;
}

export function createClusterEvent<TPayload>(input: {
  readonly eventId: string;
  readonly clusterId: ClusterId;
  readonly sequence: number;
  readonly epoch: number;
  readonly kind: string;
  readonly correlationId: string;
  readonly payload: TPayload;
}): ClusterEvent<TPayload> {
  validateIdValue(input.eventId, "eventId");
  assertClusterId(input.clusterId);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new DomainError(
      "INVALID_EVENT",
      "Event sequence must be a non-negative safe integer.",
    );
  }
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
    throw new DomainError(
      "INVALID_EVENT",
      "Event epoch must be a non-negative safe integer.",
    );
  }
  validateIdValue(input.kind, "kind");
  validateIdValue(input.correlationId, "correlationId");
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    eventId: input.eventId,
    clusterId: input.clusterId,
    sequence: input.sequence,
    epoch: input.epoch,
    kind: input.kind,
    correlationId: input.correlationId,
    payload: input.payload,
  });
}

export function assertNodeId(value: NodeId): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.value !== "string" ||
    value.value.trim().length === 0
  ) {
    throw new DomainError("INVALID_SCHEMA", "A valid NodeId is required.");
  }
}

export function assertClusterId(value: ClusterId): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== SCHEMA_VERSION ||
    typeof value.value !== "string" ||
    value.value.trim().length === 0
  ) {
    throw new DomainError("INVALID_SCHEMA", "A valid ClusterId is required.");
  }
}

function validateIdValue(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", `${label} must not be empty.`);
  }
}
