/**
 * Branded value objects for secrets, plus their runtime validators.
 *
 *   raw strings ──▶ create* ──▶ frozen SecretId / JobScope / WorkerIdentity
 *                      │          (issuedAt must precede expiresAt)
 *
 *   untrusted value ──▶ assert* ──▶ void, or throw on a malformed shape
 *   identity + now ──▶ isWorkerIdentityValid ──▶ boolean in-window
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

export function isWorkerIdentityValid(
  identity: WorkerIdentity,
  now: number,
): boolean {
  return now >= identity.issuedAt && now < identity.expiresAt;
}