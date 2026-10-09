import { createHash } from "node:crypto";
import { ClusterId, SCHEMA_VERSION } from "@workspace/opennode-domain";
import { GossipError } from "./errors";
import {
  GossipMessage,
  GOSSIP_PROTOCOL_VERSION,
  RumorDigest,
  RumorDigestEntry,
  validateGossipMessage,
  signMessage,
  verifyMessage,
} from "./messages";
import { assertAdvisoryMessage } from "./policy";

export type RumorIngestResult =
  | "applied"
  | "duplicate"
  | "stale-version"
  | "expired";

/**
 * Hash-based comparison hook for anti-entropy. Swap in a Merkle
 * implementation (or the sync-engine hash module at the adapter layer)
 * without changing RumorSet semantics.
 */
export interface DigestHasher {
  hashRumor(message: GossipMessage): string;
  hashSet(entryHashes: readonly string[]): string;
}

export interface RumorReconciliation {
  /** Rumors we hold that the remote lacks or holds at a lower version. */
  readonly advertise: readonly GossipMessage[];
  /** Rumor IDs the remote holds that we lack or hold at a lower version. */
  readonly request: readonly string[];
}

export class Sha256DigestHasher implements DigestHasher {
  hashRumor(message: GossipMessage): string {
    return sha256Hex(
      stableStringify({
        schemaVersion: message.schemaVersion,
        protocolVersion: message.protocolVersion,
        category: message.category,
        rumorId: message.rumorId,
        originId: message.originId.value,
        clusterId: message.clusterId.value,
        version: message.version,
        issuedAt: message.issuedAt,
        ttlMs: message.ttlMs,
        payload:
          message.category === "presence" ? message.presence : message.capacity,
        signature: Array.from(message.signature.value),
        originPublicKey: Array.from(message.originPublicKey.value),
      }),
    );
  }

  hashSet(entryHashes: readonly string[]): string {
    return merkleRoot(entryHashes);
  }
}

export class RumorSet {
  private readonly rumors = new Map<string, GossipMessage>();
  private readonly hasher: DigestHasher;

  constructor(
    private readonly clusterId: ClusterId,
    options?: { readonly hasher?: DigestHasher },
  ) {
    this.hasher = options?.hasher ?? new Sha256DigestHasher();
  }

  get size(): number {
    return this.rumors.size;
  }

  /** Ingest a rumor; dedups by rumorId and keeps the highest version. */
  ingest(message: GossipMessage, now: number): RumorIngestResult {
    assertAdvisoryMessage(message);
    validateGossipMessage(message, this.clusterId, now);
    const existing = this.rumors.get(message.rumorId);
    if (existing !== undefined) {
      if (
        existing.version === message.version &&
        this.hasher.hashRumor(existing) === this.hasher.hashRumor(message)
      ) {
        return "duplicate";
      }
      if (message.version <= existing.version) {
        return "stale-version";
      }
    }
    this.rumors.set(message.rumorId, message);
    return "applied";
  }

  get(rumorId: string): GossipMessage | undefined {
    return this.rumors.get(rumorId);
  }

  list(): readonly GossipMessage[] {
    return [...this.rumors.values()];
  }

  /** Drop expired rumors; returns the removed rumor IDs. */
  expire(now: number): readonly string[] {
    const removed: string[] = [];
    for (const [rumorId, message] of this.rumors) {
      if (message.expiresAt <= now) {
        this.rumors.delete(rumorId);
        removed.push(rumorId);
      }
    }
    return removed;
  }

  /** Local digest for a periodic anti-entropy exchange. */
  digest(): RumorDigest {
    const entries: RumorDigestEntry[] = [...this.rumors.values()]
      .map((message) =>
        Object.freeze({
          rumorId: message.rumorId,
          originId: message.originId.value,
          version: message.version,
          hash: this.hasher.hashRumor(message),
        }),
      )
      .sort((a, b) => a.rumorId.localeCompare(b.rumorId));
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: GOSSIP_PROTOCOL_VERSION,
      clusterId: this.clusterId,
      entries: Object.freeze(entries),
      setHash: this.hasher.hashSet(entries.map((entry) => entry.hash)),
    });
  }

  /**
   * Compare a remote digest against local state to plan one anti-entropy
   * repair round: rumors to push (advertise) and rumor IDs to pull (request).
   */
  reconcile(remote: RumorDigest): RumorReconciliation {
    validateDigest(remote, this.clusterId);
    const remoteById = new Map(
      remote.entries.map((entry) => [entry.rumorId, entry]),
    );
    const advertise: GossipMessage[] = [];
    const request: string[] = [];
    for (const [rumorId, message] of this.rumors) {
      const remoteEntry = remoteById.get(rumorId);
      if (remoteEntry === undefined || remoteEntry.version < message.version) {
        advertise.push(message);
      }
    }
    for (const entry of remote.entries) {
      const local = this.rumors.get(entry.rumorId);
      if (local === undefined || local.version < entry.version) {
        request.push(entry.rumorId);
      }
    }
    return Object.freeze({
      advertise: Object.freeze(advertise),
      request: Object.freeze(request),
    });
  }

  /** Fetch missing rumors from peers and validate signatures. */
  async fetchMissing(
    request: readonly string[],
    fetchRumor: (rumorId: string) => Promise<GossipMessage | null>,
    now: number,
  ): Promise<number> {
    let applied = 0;
    for (const rumorId of request) {
      const rumor = await fetchRumor(rumorId);
      if (rumor !== null) {
        const result = this.ingest(rumor, now);
        if (result === "applied") applied++;
      }
    }
    return applied;
  }

  /** Anti-entropy: compare Merkle root with peer, fetch missing, validate signatures. */
  async antiEntropy(
    remoteDigest: RumorDigest,
    fetchRumor: (rumorId: string) => Promise<GossipMessage | null>,
    now: number,
  ): Promise<{ fetched: number; reconciled: RumorReconciliation }> {
    validateDigest(remoteDigest, this.clusterId);
    const reconciliation = this.reconcile(remoteDigest);
    const fetched = await this.fetchMissing(reconciliation.request, fetchRumor, now);
    return { fetched, reconciled: reconciliation };
  }
}

/** Schedules periodic anti-entropy digest exchanges. */
export class AntiEntropyScheduler {
  private lastExchangeAt: number | null = null;

  constructor(private readonly intervalMs: number) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new GossipError(
        "INVALID_GOSSIP_MESSAGE",
        "Anti-entropy interval must be a positive safe integer.",
      );
    }
  }

  isDue(now: number): boolean {
    validateNow(now);
    return (
      this.lastExchangeAt === null || now - this.lastExchangeAt >= this.intervalMs
    );
  }

  markExchanged(now: number): void {
    validateNow(now);
    this.lastExchangeAt = now;
  }

  nextDueAt(): number {
    return this.lastExchangeAt === null
      ? 0
      : this.lastExchangeAt + this.intervalMs;
  }
}

function validateDigest(digest: RumorDigest, clusterId: ClusterId): void {
  if (typeof digest !== "object" || digest === null) {
    throw new GossipError("INVALID_DIGEST", "A rumor digest is required.");
  }
  if (
    digest.schemaVersion !== SCHEMA_VERSION ||
    digest.protocolVersion !== GOSSIP_PROTOCOL_VERSION
  ) {
    throw new GossipError("INVALID_DIGEST", "Unsupported digest version.");
  }
  if (digest.clusterId.value !== clusterId.value) {
    throw new GossipError(
      "WRONG_CLUSTER",
      "Rumor digest belongs to a different cluster.",
    );
  }
  if (!Array.isArray(digest.entries)) {
    throw new GossipError("INVALID_DIGEST", "Digest entries must be an array.");
  }
  for (const entry of digest.entries) {
    if (
      typeof entry.rumorId !== "string" ||
      entry.rumorId.trim().length === 0 ||
      typeof entry.originId !== "string" ||
      entry.originId.trim().length === 0 ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 0 ||
      typeof entry.hash !== "string" ||
      entry.hash.trim().length === 0
    ) {
      throw new GossipError("INVALID_DIGEST", "Malformed digest entry.");
    }
  }
  if (typeof digest.setHash !== "string" || digest.setHash.trim().length === 0) {
    throw new GossipError("INVALID_DIGEST", "Digest setHash must not be empty.");
  }
}

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "now must be a non-negative safe integer.",
    );
  }
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}

function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return sha256Hex("");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : left;
      next.push(sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0];
}
