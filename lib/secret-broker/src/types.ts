/**
 * Branded value objects for secrets, plus their runtime validators.
 *
 *   raw strings ──▶ create* ──▶ frozen SecretId / JobScope / WorkerIdentity
 *                      │          (issuedAt must precede expiresAt)
 *
 *   untrusted value ──▶ assert* ──▶ void, or throw on a malformed shape
 *   identity + now ──▶ isWorkerIdentityValid ──▶ boolean in-window
 *
 *   capability ──▶ createLeaseBoundCapability ──▶ frozen LeaseBoundCapability
 *                      │   (signed over leaseCapabilityMessage's canonical
 *                      │    pipe-joined string: "capability|runId|...")
 *   untrusted value ──▶ assertLeaseBoundCapability ──▶ void or throw
 */
import { NodeId, ClusterId } from "@workspace/opennode-domain";

export interface SecretId {
  readonly schemaVersion: 1;
  readonly value: string;
}

export interface JobScope {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly clusterId: ClusterId;
  readonly attemptId: string;
}

export interface WorkerIdentity {
  readonly schemaVersion: 1;
  readonly workerNodeId: NodeId;
  readonly authorizedBy: NodeId;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface LeaseBoundCapability {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly attemptOrdinal: string;
  readonly workerNodeId: NodeId;
  readonly membershipEpoch: number;
  readonly fencingToken: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SecretRef {
  readonly schemaVersion: 1;
  readonly secretId: SecretId;
  readonly jobScope: JobScope;
}

export interface SecretValue {
  readonly schemaVersion: 1;
  readonly secretId: SecretId;
  readonly value: string;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface IssueSecretInput {
  readonly secretId: SecretId;
  readonly jobScope: JobScope;
  readonly value: string;
  readonly ttlMs?: number;
}

export interface RevokeSecretInput {
  readonly secretId: SecretId;
  readonly jobScope: JobScope;
  readonly requestedBy: NodeId;
}

export interface GetSecretInput {
  readonly secretId: SecretId;
  readonly jobScope: JobScope;
  readonly workerIdentity: WorkerIdentity;
  readonly capability: LeaseBoundCapability;
  readonly capabilitySignature: string;
  readonly issuerNodeId: NodeId;
}

export interface AuditEventDetails {
  readonly secretId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly workerNodeId?: string;
  readonly action: "issue" | "revoke" | "get" | "get_denied";
  readonly success: boolean;
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}

export function createSecretId(value: string): SecretId {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Secret ID must not be empty.");
  }
  return Object.freeze({ schemaVersion: 1, value });
}

export function createJobScope(input: {
  readonly jobId: string;
  readonly clusterId: ClusterId;
  readonly attemptId: string;
}): JobScope {
  if (typeof input.jobId !== "string" || input.jobId.trim().length === 0) {
    throw new Error("Job ID must not be empty.");
  }
  if (typeof input.attemptId !== "string" || input.attemptId.trim().length === 0) {
    throw new Error("Attempt ID must not be empty.");
  }
  return Object.freeze({
    schemaVersion: 1,
    jobId: input.jobId,
    clusterId: input.clusterId,
    attemptId: input.attemptId,
  });
}

export function createWorkerIdentity(input: {
  readonly workerNodeId: NodeId;
  readonly authorizedBy: NodeId;
  readonly issuedAt: number;
  readonly expiresAt: number;
}): WorkerIdentity {
  if (input.issuedAt >= input.expiresAt) {
    throw new Error("Worker identity issuedAt must be before expiresAt.");
  }
  return Object.freeze({
    schemaVersion: 1,
    ...input,
  });
}

export function createSecretRef(input: {
  readonly secretId: SecretId;
  readonly jobScope: JobScope;
}): SecretRef {
  return Object.freeze({
    schemaVersion: 1,
    secretId: input.secretId,
    jobScope: input.jobScope,
  });
}

export function createLeaseBoundCapability(input: {
  readonly runId: string;
  readonly attemptOrdinal: string;
  readonly workerNodeId: NodeId;
  readonly membershipEpoch: number;
  readonly fencingToken: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}): LeaseBoundCapability {
  if (typeof input.runId !== "string" || input.runId.trim().length === 0) {
    throw new Error("Capability runId must not be empty.");
  }
  if (typeof input.attemptOrdinal !== "string" || input.attemptOrdinal.trim().length === 0) {
    throw new Error("Capability attemptOrdinal must not be empty.");
  }
  if (
    typeof input.workerNodeId !== "object" ||
    input.workerNodeId === null ||
    typeof input.workerNodeId.value !== "string" ||
    input.workerNodeId.value.trim().length === 0
  ) {
    throw new Error("Capability workerNodeId must not be empty.");
  }
  if (!Number.isSafeInteger(input.membershipEpoch)) {
    throw new Error("Capability membershipEpoch must be a safe integer.");
  }
  if (typeof input.fencingToken !== "string" || input.fencingToken.trim().length === 0) {
    throw new Error("Capability fencingToken must not be empty.");
  }
  if (input.issuedAt >= input.expiresAt) {
    throw new Error("Capability issuedAt must be before expiresAt.");
  }
  return Object.freeze({
    schemaVersion: 1,
    ...input,
  });
}

export function assertSecretId(value: SecretId): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== 1 ||
    typeof value.value !== "string" ||
    value.value.trim().length === 0
  ) {
    throw new Error("A valid SecretId is required.");
  }
}

export function assertJobScope(value: JobScope): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== 1 ||
    typeof value.jobId !== "string" ||
    value.jobId.trim().length === 0 ||
    typeof value.attemptId !== "string" ||
    value.attemptId.trim().length === 0
  ) {
    throw new Error("A valid JobScope is required.");
  }
}

export function assertWorkerIdentity(value: WorkerIdentity): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== 1 ||
    typeof value.workerNodeId !== "object" ||
    value.workerNodeId === null ||
    typeof value.authorizedBy !== "object" ||
    value.authorizedBy === null ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    throw new Error("A valid WorkerIdentity is required.");
  }
}

export function assertLeaseBoundCapability(value: LeaseBoundCapability): void {
  if (
    typeof value !== "object" ||
    value === null ||
    value.schemaVersion !== 1 ||
    typeof value.runId !== "string" ||
    value.runId.trim().length === 0 ||
    typeof value.attemptOrdinal !== "string" ||
    value.attemptOrdinal.trim().length === 0 ||
    typeof value.workerNodeId !== "object" ||
    value.workerNodeId === null ||
    typeof value.workerNodeId.value !== "string" ||
    value.workerNodeId.value.trim().length === 0 ||
    !Number.isSafeInteger(value.membershipEpoch) ||
    typeof value.fencingToken !== "string" ||
    value.fencingToken.trim().length === 0 ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.issuedAt >= value.expiresAt
  ) {
    throw new Error("A valid LeaseBoundCapability is required.");
  }
}

export function isWorkerIdentityValid(
  identity: WorkerIdentity,
  now: number,
): boolean {
  return now >= identity.issuedAt && now < identity.expiresAt;
}

export function leaseCapabilityMessage(capability: LeaseBoundCapability): string {
  return (
    `capability|${capability.runId}|${capability.attemptOrdinal}|` +
    `${capability.workerNodeId.value}|${capability.membershipEpoch}|` +
    `${capability.fencingToken}|${capability.issuedAt}|${capability.expiresAt}`
  );
}