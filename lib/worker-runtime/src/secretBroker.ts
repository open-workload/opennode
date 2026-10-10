/**
 * Thin worker-side facade over @workspace/secret-broker, plus an in-memory store.
 *
 *   (secretRefId, jobId, attemptId, clusterId) ─▶ SecretId + JobScope ─▶ broker.issue
 *                                                               ├─▶ .get ─▶ value
 *                                                               └─▶ .revoke
 *   leaseToken ─▶ JSON.parse ─▶ WorkerIdentity ─────────────────────▶ broker.get
 *   resolveSecrets ─▶ Promise.all over refs ─▶ ResolvedSecret[]  (bad JSON ─▶ throw)
 *
 *   InMemorySecretStore keys on secretId:jobId:attemptId, swept by an unref'd interval
 *   ConsoleAuditSink prints every AuditEvent as a [AUDIT] JSON line
 */

import {
  SecretBroker,
  createSecretBroker,
  SecretStore,
  AuditSink,
  IssueSecretInput,
  GetSecretInput,
  RevokeSecretInput,
  SecretId,
  JobScope,
  WorkerIdentity,
  SecretValue,
  createSecretId,
  createJobScope,
  createWorkerIdentity,
} from "@workspace/secret-broker/secret-broker";
import { WorkerRuntimeError } from "./errors";
import { NodeId, ClusterId } from "@workspace/opennode-domain";
import { CorrelationIds, AuditEvent } from "@workspace/opennode-domain";

export interface SecretBrokerClientOptions {
  readonly broker: SecretBroker;
  readonly workerNodeId: NodeId;
  readonly authorizedBy: NodeId;
  readonly defaultTtlMs?: number;
}

export interface ResolvedSecret {
  readonly name: string;
  readonly value: string;
}

export class SecretBrokerClient {
  private readonly broker: SecretBroker;
  private readonly workerNodeId: NodeId;
  private readonly authorizedBy: NodeId;
  private readonly defaultTtlMs: number;

  constructor(options: SecretBrokerClientOptions) {
    this.broker = options.broker;
    this.workerNodeId = options.workerNodeId;
    this.authorizedBy = options.authorizedBy;
    this.defaultTtlMs = options.defaultTtlMs ?? 3600000;
  }

  async issueSecret(secretRefId: string, value: string, jobId: string, attemptId: string, clusterId: ClusterId, ttlMs?: number): Promise<void> {
    const secretId = createSecretId(secretRefId);
    const jobScope = createJobScope({ jobId, clusterId, attemptId });
    const input: IssueSecretInput = { secretId, jobScope, value, ttlMs: ttlMs ?? this.defaultTtlMs };
    const correlation: CorrelationIds = { requestId: `issue-${secretRefId}-${attemptId}` };
    await this.broker.issue(input, correlation);
  }

  async revokeSecret(secretRefId: string, jobId: string, attemptId: string, clusterId: ClusterId): Promise<void> {
    const secretId = createSecretId(secretRefId);
    const jobScope = createJobScope({ jobId, clusterId, attemptId });
    const input: RevokeSecretInput = { secretId, jobScope, requestedBy: this.workerNodeId };
    const correlation: CorrelationIds = { requestId: `revoke-${secretRefId}-${attemptId}` };
    await this.broker.revoke(input, correlation);
  }

  async getSecret(secretRefId: string, jobId: string, attemptId: string, clusterId: ClusterId, leaseToken: string): Promise<string> {
    const secretId = createSecretId(secretRefId);
    const jobScope = createJobScope({ jobId, clusterId, attemptId });
    const workerIdentity = this.parseLeaseToken(leaseToken);
    const input: GetSecretInput = { secretId, jobScope, workerIdentity };
    const correlation: CorrelationIds = { requestId: `get-${secretRefId}-${attemptId}` };
    const result = await this.broker.get(input, correlation);
    return result.value;
  }

  async resolveSecrets(
    secretRefs: readonly { name: string; secretRefId: string }[],
    jobId: string,
    attemptId: string,
    clusterId: ClusterId,
    leaseToken: string,
  ): Promise<ResolvedSecret[]> {
    const results = await Promise.all(
      secretRefs.map(async (ref) => {
        const value = await this.getSecret(ref.secretRefId, jobId, attemptId, clusterId, leaseToken);
        return { name: ref.name, value };
      }),
    );
    return results;
  }

  private parseLeaseToken(token: string): WorkerIdentity {
    try {
      const parsed = JSON.parse(token);
      return createWorkerIdentity({
        workerNodeId: { schemaVersion: 1, value: parsed.workerNodeId },
        authorizedBy: { schemaVersion: 1, value: parsed.authorizedBy },
        issuedAt: parsed.issuedAt,
        expiresAt: parsed.expiresAt,
      });
    } catch {
      throw new WorkerRuntimeError("Invalid lease token format", "invalid_lease_token");
    }
  }
}

export interface InMemorySecretStoreOptions {
  readonly cleanupIntervalMs?: number;
}

export class InMemorySecretStore implements SecretStore {
  private store = new Map<string, { value: SecretValue; jobScope: JobScope }>();
  private readonly cleanupInterval: ReturnType<typeof setInterval> | undefined;

  constructor(options: InMemorySecretStoreOptions = {}) {
    if (options.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(() => this.cleanupExpired(), options.cleanupIntervalMs);
      this.cleanupInterval.unref?.();
    }
  }

  async put(input: IssueSecretInput): Promise<void> {
    const now = Date.now();
    const secretValue: SecretValue = {
      schemaVersion: 1,
      secretId: input.secretId,
      value: input.value,
      createdAt: now,
      expiresAt: input.ttlMs ? now + input.ttlMs : undefined,
    };
    this.store.set(this.key(input.secretId, input.jobScope), { value: secretValue, jobScope: input.jobScope });
  }

  async get(secretId: SecretId, jobScope: JobScope): Promise<SecretValue | null> {
    const entry = this.store.get(this.key(secretId, jobScope));
    return entry?.value ?? null;
  }

  async delete(secretId: SecretId, jobScope: JobScope): Promise<void> {
    this.store.delete(this.key(secretId, jobScope));
  }

  async exists(secretId: SecretId, jobScope: JobScope): Promise<boolean> {
    return this.store.has(this.key(secretId, jobScope));
  }

  private key(secretId: SecretId, jobScope: JobScope): string {
    return `${secretId.value}:${jobScope.jobId}:${jobScope.attemptId}`;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.value.expiresAt !== undefined && entry.value.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

export class ConsoleAuditSink implements AuditSink {
  async write(event: AuditEvent): Promise<void> {
    console.log("[AUDIT]", JSON.stringify(event));
  }
}

export function createSecretBrokerForWorker(
  store: SecretStore,
  audit: AuditSink,
  options?: { defaultTtlMs?: number; maxTtlMs?: number },
): SecretBroker {
  return createSecretBroker({ store, audit, ...options });
}