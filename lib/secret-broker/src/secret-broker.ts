import {
  SecretId,
  JobScope,
  WorkerIdentity,
  SecretValue,
  IssueSecretInput,
  RevokeSecretInput,
  GetSecretInput,
  AuditEventDetails,
  assertSecretId,
  assertJobScope,
  assertWorkerIdentity,
  isWorkerIdentityValid,
} from "./types";
import {
  SecretBrokerError,
  SecretBrokerErrorCode,
  isSecretBrokerError,
} from "./errors";
import { createAuditEvent, CorrelationIds, AuditEvent } from "@workspace/opennode-domain";

export interface SecretStore {
  put(input: IssueSecretInput): Promise<void>;
  get(secretId: SecretId, jobScope: JobScope): Promise<SecretValue | null>;
  delete(secretId: SecretId, jobScope: JobScope): Promise<void>;
  exists(secretId: SecretId, jobScope: JobScope): Promise<boolean>;
}

export interface AuditSink {
  write(event: AuditEvent): Promise<void>;
}

export interface SecretBroker {
  issue(input: IssueSecretInput, correlation: CorrelationIds): Promise<void>;
  revoke(input: RevokeSecretInput, correlation: CorrelationIds): Promise<void>;
  get(input: GetSecretInput, correlation: CorrelationIds): Promise<SecretValue>;
}

export interface SecretBrokerConfig {
  store: SecretStore;
  audit: AuditSink;
  defaultTtlMs?: number;
  maxTtlMs?: number;
}

export function createSecretBroker(config: SecretBrokerConfig): SecretBroker {
  const { store, audit, defaultTtlMs = 3600000, maxTtlMs = 86400000 } = config;

  async function writeAudit(details: AuditEventDetails, correlation: CorrelationIds): Promise<void> {
    const event = createAuditEvent({
      eventId: `${details.action}-${details.secretId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      kind: `secret.${details.action}`,
      correlation,
      details,
    });
    await audit.write(event);
  }

  async function issue(input: IssueSecretInput, correlation: CorrelationIds): Promise<void> {
    assertSecretId(input.secretId);
    assertJobScope(input.jobScope);

    const ttlMs = input.ttlMs ?? defaultTtlMs;
    if (ttlMs > maxTtlMs) {
      throw new SecretBrokerError("INVALID_JOB_SCOPE", `TTL exceeds maximum allowed ${maxTtlMs}ms`);
    }

    const now = Date.now();
    const secretValue: SecretValue = Object.freeze({
      schemaVersion: 1,
      secretId: input.secretId,
      value: input.value,
      createdAt: now,
      expiresAt: now + ttlMs,
    });

    await store.put({ ...input, value: secretValue.value });

    await writeAudit(
      {
        secretId: input.secretId.value,
        jobId: input.jobScope.jobId,
        attemptId: input.jobScope.attemptId,
        action: "issue",
        success: true,
      },
      correlation,
    );
  }

  async function revoke(input: RevokeSecretInput, correlation: CorrelationIds): Promise<void> {
    assertSecretId(input.secretId);
    assertJobScope(input.jobScope);

    const exists = await store.exists(input.secretId, input.jobScope);
    if (!exists) {
      await writeAudit(
        {
          secretId: input.secretId.value,
          jobId: input.jobScope.jobId,
          attemptId: input.jobScope.attemptId,
          action: "revoke",
          success: false,
          errorCode: "SECRET_NOT_FOUND",
        },
        correlation,
      );
      throw new SecretBrokerError("SECRET_NOT_FOUND", "Secret not found for the given job scope.");
    }

    await store.delete(input.secretId, input.jobScope);

    await writeAudit(
      {
        secretId: input.secretId.value,
        jobId: input.jobScope.jobId,
        attemptId: input.jobScope.attemptId,
        action: "revoke",
        success: true,
      },
      correlation,
    );
  }

  async function get(input: GetSecretInput, correlation: CorrelationIds): Promise<SecretValue> {
    assertSecretId(input.secretId);
    assertJobScope(input.jobScope);
    assertWorkerIdentity(input.workerIdentity);

    const now = Date.now();
    if (!isWorkerIdentityValid(input.workerIdentity, now)) {
      await writeAudit(
        {
          secretId: input.secretId.value,
          jobId: input.jobScope.jobId,
          attemptId: input.jobScope.attemptId,
          workerNodeId: input.workerIdentity.workerNodeId.value,
          action: "get_denied",
          success: false,
          errorCode: "UNAUTHORIZED_WORKER",
        },
        correlation,
      );
      throw new SecretBrokerError("UNAUTHORIZED_WORKER", "Worker identity is invalid or expired.");
    }

    const stored = await store.get(input.secretId, input.jobScope);
    if (!stored) {
      await writeAudit(
        {
          secretId: input.secretId.value,
          jobId: input.jobScope.jobId,
          attemptId: input.jobScope.attemptId,
          workerNodeId: input.workerIdentity.workerNodeId.value,
          action: "get",
          success: false,
          errorCode: "SECRET_NOT_FOUND",
        },
        correlation,
      );
      throw new SecretBrokerError("SECRET_NOT_FOUND", "Secret not found for the given job scope.");
    }

    if (stored.expiresAt !== undefined && stored.expiresAt <= now) {
      await writeAudit(
        {
          secretId: input.secretId.value,
          jobId: input.jobScope.jobId,
          attemptId: input.jobScope.attemptId,
          workerNodeId: input.workerIdentity.workerNodeId.value,
          action: "get",
          success: false,
          errorCode: "SECRET_EXPIRED",
        },
        correlation,
      );
      throw new SecretBrokerError("SECRET_EXPIRED", "Secret has expired.");
    }

    await writeAudit(
      {
        secretId: input.secretId.value,
        jobId: input.jobScope.jobId,
        attemptId: input.jobScope.attemptId,
        workerNodeId: input.workerIdentity.workerNodeId.value,
        action: "get",
        success: true,
      },
      correlation,
    );

    return stored;
  }

  return Object.freeze({ issue, revoke, get });
}

export { SecretBrokerError, isSecretBrokerError } from "./errors";
export type { SecretBrokerErrorCode } from "./errors";
export type {
  SecretId,
  JobScope,
  WorkerIdentity,
  SecretRef,
  SecretValue,
  IssueSecretInput,
  RevokeSecretInput,
  GetSecretInput,
  AuditEventDetails,
} from "./types";
export {
  createSecretId,
  createJobScope,
  createWorkerIdentity,
  createSecretRef,
  assertSecretId,
  assertJobScope,
  assertWorkerIdentity,
  isWorkerIdentityValid,
} from "./types";