import { metricsRegistry } from "@workspace/observability";

/**
 * Job-scoped secret broker. This is the wired copy: api-server runtime.ts
 * instantiates it through the package's "." export.
 *
 *   issue(jobId, worker, ttl, value) ──▶ store.set ──▶ audit secret_issued
 *   get(jobId, requester) ──▶ exists? revoked? expired? worker match?
 *                               │        │        │          │
 *                               └────────┴────────┴──▶ null + denied
 *                               all pass ──▶ value + accessed
 *
 * Every denial returns null; nothing here throws. MemorySecretStore is a Map.
 */
export interface SecretBroker {
  issueSecret(
    jobScopedId: string,
    authorizedWorkerId: string,
    ttlMs: number,
    value: string
  ): Promise<void>;

  revokeSecret(jobScopedId: string): Promise<void>;

  getSecret(
    jobScopedId: string,
    requestingWorkerId: string
  ): Promise<string | null>;
}

export interface SecretAuditEvent {
  type: "secret_issued" | "secret_revoked" | "secret_accessed" | "secret_access_denied";
  jobScopedId: string;
  workerId: string;
  timestamp: number;
  ttlMs?: number;
  success: boolean;
}

export interface SecretStore {
  set(jobScopedId: string, entry: SecretEntry): Promise<void>;
  get(jobScopedId: string): Promise<SecretEntry | null>;
  delete(jobScopedId: string): Promise<void>;
}

export interface SecretEntry {
  value: string;
  authorizedWorkerId: string;
  expiresAt: number;
  revoked: boolean;
}

export function createSecretBroker(
  store: SecretStore,
  audit?: (event: SecretAuditEvent) => void
): SecretBroker {
  return {
    async issueSecret(jobScopedId, authorizedWorkerId, ttlMs, value) {
      const entry: SecretEntry = {
        value,
        authorizedWorkerId,
        expiresAt: Date.now() + ttlMs,
        revoked: false,
      };
      await store.set(jobScopedId, entry);
      audit?.({
        type: "secret_issued",
        jobScopedId,
        workerId: authorizedWorkerId,
        timestamp: Date.now(),
        ttlMs,
        success: true,
      });
    },

    async revokeSecret(jobScopedId) {
      const entry = await store.get(jobScopedId);
      if (entry) {
        entry.revoked = true;
        await store.set(jobScopedId, entry);
      }
      audit?.({
        type: "secret_revoked",
        jobScopedId,
        workerId: entry?.authorizedWorkerId ?? "unknown",
        timestamp: Date.now(),
        success: true,
      });
    },

    async getSecret(jobScopedId, requestingWorkerId) {
      const entry = await store.get(jobScopedId);
      const now = Date.now();

      if (!entry) {
        audit?.({
          type: "secret_access_denied",
          jobScopedId,
          workerId: requestingWorkerId,
          timestamp: now,
          success: false,
        });
        return null;
      }

      if (entry.expiresAt < now) {
        metricsRegistry.increment("secret_broker.expired_credentials");
      }

      if (entry.revoked || entry.expiresAt < now) {
        audit?.({
          type: "secret_access_denied",
          jobScopedId,
          workerId: requestingWorkerId,
          timestamp: now,
          success: false,
        });
        return null;
      }

      if (entry.authorizedWorkerId !== requestingWorkerId) {
        audit?.({
          type: "secret_access_denied",
          jobScopedId,
          workerId: requestingWorkerId,
          timestamp: now,
          success: false,
        });
        return null;
      }

      audit?.({
        type: "secret_accessed",
        jobScopedId,
        workerId: requestingWorkerId,
        timestamp: now,
        success: true,
      });

      return entry.value;
    },
  };
}

export class MemorySecretStore implements SecretStore {
  private store = new Map<string, SecretEntry>();

  async set(jobScopedId: string, entry: SecretEntry): Promise<void> {
    this.store.set(jobScopedId, entry);
  }

  async get(jobScopedId: string): Promise<SecretEntry | null> {
    return this.store.get(jobScopedId) ?? null;
  }

  async delete(jobScopedId: string): Promise<void> {
    this.store.delete(jobScopedId);
  }
}