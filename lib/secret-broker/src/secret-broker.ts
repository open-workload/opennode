/**
 * Second broker implementation: branded types, correlation IDs, throwing
 * errors. Imported only by worker-runtime, which nothing constructs.
 *
 *   issue / revoke + CorrelationIds ──▶ assert* ──▶ store op ──▶ audit.write
 *
 *   get + CorrelationIds ──▶ assert* ──▶ capability gate ──▶ store.get ──▶ audit.write
 *                                          │  assert capability shape
 *                                          │  verify signature over issuer NodeId
 *                                          │  not expired / within identity window
 *                                          │  runId / attemptOrdinal / workerNodeId match
 *                                          └─ any fail ──▶ get_denied audit + throw
 *
 *   frozen { issue, revoke, get } ──▶ SecretBrokerError on any failure
 *
 * Denials throw here rather than returning null, unlike src/index.ts.
 */
import {
  SecretId,
  JobScope,
  WorkerIdentity,
  SecretValue,
  IssueSecretInput,
  RevokeSecretInput,
  GetSecretInput,
  LeaseBoundCapability,
  AuditEventDetails,
  assertSecretId,
  assertJobScope,
  assertWorkerIdentity,
  assertLeaseBoundCapability,
  isWorkerIdentityValid,
  leaseCapabilityMessage,
} from "./types";
import {
  SecretBrokerError,
  SecretBrokerErrorCode,
  isSecretBrokerError,
} from "./errors";
import { createAuditEvent, CorrelationIds, AuditEvent, NodeId } from "@workspace/opennode-domain";

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
  verifyCapability: (issuer: NodeId, message: string, signature: string) => boolean;
  defaultTtlMs?: number;
  maxTtlMs?: number;
}

export function createSecretBroker(config: SecretBrokerConfig): SecretBroker {
  const { store, audit, verifyCapability, defaultTtlMs = 3600000, maxTtlMs = 86400000 } = config;

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

    async function denyUnauthorized(message: string): Promise<never> {
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
      throw new SecretBrokerError("UNAUTHORIZED_WORKER", message);
    }

    const capability: LeaseBoundCapability = input.capability;
    try {
      assertLeaseBoundCapability(capability);
    } catch {
      await denyUnauthorized("Lease-bound capability is missing or malformed.");
    }

    if (!verifyCapability(input.issuerNodeId, leaseCapabilityMessage(capability), input.capabilitySignature)) {
      await denyUnauthorized("Lease-bound capability signature is invalid.");
    }
    if (capability.expiresAt <= now) {
      await denyUnauthorized("Lease-bound capability has expired.");
    }
    if (capability.expiresAt > input.workerIdentity.expiresAt) {
      await denyUnauthorized("Lease-bound capability outlives the worker identity window.");
    }
    if (capability.runId !== input.jobScope.jobId) {
      await denyUnauthorized("Lease-bound capability is bound to a different run.");
    }
    if (capability.attemptOrdinal !== input.jobScope.attemptId) {
      await denyUnauthorized("Lease-bound capability is bound to a different attempt.");
    }
    if (capability.workerNodeId.value !== input.workerIdentity.workerNodeId.value) {
      await denyUnauthorized("Lease-bound capability is bound to a different worker node.");
    }

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
  LeaseBoundCapability,
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
  createLeaseBoundCapability,
  assertSecretId,
  assertJobScope,
  assertWorkerIdentity,
  assertLeaseBoundCapability,
  isWorkerIdentityValid,
  leaseCapabilityMessage,
} from "./types";