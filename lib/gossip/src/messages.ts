/**
 * Wire types, construction, and signing for gossip messages (presence, capacity).
 *
 *   createPresenceAnnouncement / createCapacityAdvertisement
 *        │  assert ids, ttl, version ──▶ signMessage ──▶ frozen message + public key
 *        ▼
 *   GossipMessage ──▶ validateGossipMessage(msg, expectedClusterId, now)
 *        │              schema+protocol version ──▶ category ──▶ cluster match
 *        │              ──▶ expiry ──▶ ed25519 verify ──▶ rumorId binds originId
 *        ▼
 *   signed message ──▶ ./rumorSet (digest, reconcile); ./policy gates categories
 */
import { createHash } from "node:crypto";
import {
  ClusterId,
  NodeId,
  SCHEMA_VERSION,
  assertClusterId,
  assertNodeId,
} from "@workspace/opennode-domain";
import { GossipError } from "./errors";
import { sign, verify, getPublicKey, utils } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

export const GOSSIP_PROTOCOL_VERSION = 1;
export const MAX_GOSSIP_TTL_MS = 10 * 60 * 1000;

export type GossipCategory = "presence" | "capacity";

export interface Ed25519PublicKey {
  readonly value: Uint8Array;
}

export interface Ed25519Signature {
  readonly value: Uint8Array;
}

interface GossipMessageBase {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly protocolVersion: typeof GOSSIP_PROTOCOL_VERSION;
  readonly category: GossipCategory;
  readonly rumorId: string;
  readonly originId: NodeId;
  readonly clusterId: ClusterId;
  /** Per-origin monotonic version; higher versions replace lower ones. */
  readonly version: number;
  readonly issuedAt: number;
  readonly ttlMs: number;
  readonly expiresAt: number;
  /** Ed25519 signature over the canonical message payload (excluding signature). */
  readonly signature: Ed25519Signature;
  /** Public key of the origin node (32 bytes). */
  readonly originPublicKey: Ed25519PublicKey;
}

export type PresenceState = "online" | "draining" | "leaving";

export interface PresenceAnnouncement extends GossipMessageBase {
  readonly category: "presence";
  readonly presence: {
    readonly state: PresenceState;
    readonly addressHints: readonly string[];
  };
}

export interface CapacityResources {
  readonly maxConcurrentJobs: number;
  readonly cpuMillicores: number;
  readonly memoryMb: number;
}

export type CapacityWorkloadMode =
  | "built-in-diagnostic"
  | "arbitrary-container";

export interface CapacityAdvertisement extends GossipMessageBase {
  readonly category: "capacity";
  readonly capacity: {
    readonly acceptsWork: boolean;
    readonly supportedModes: readonly CapacityWorkloadMode[];
    readonly resources: CapacityResources;
  };
}

export type GossipMessage = PresenceAnnouncement | CapacityAdvertisement;

export interface RumorDigestEntry {
  readonly rumorId: string;
  readonly originId: string;
  readonly version: number;
  readonly hash: string;
}

export interface RumorDigest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly protocolVersion: typeof GOSSIP_PROTOCOL_VERSION;
  readonly clusterId: ClusterId;
  readonly entries: readonly RumorDigestEntry[];
  /** Hash-based set fingerprint (Merkle root by default) for fast comparison. */
  readonly setHash: string;
}

export function signMessage(
  message: Omit<GossipMessage, "signature" | "originPublicKey">,
  privateKey: Uint8Array,
): { signature: Ed25519Signature; originPublicKey: Ed25519PublicKey } {
  const payload = canonicalMessagePayload(message);
  const signature = sign(payload, privateKey);
  const publicKey = getPublicKey(privateKey);
  return {
    signature: Object.freeze({ value: signature }),
    originPublicKey: Object.freeze({ value: publicKey }),
  };
}

export function verifyMessage(message: GossipMessage): boolean {
  const payload = canonicalMessagePayload(message);
  try {
    return verify(message.signature.value, payload, message.originPublicKey.value);
  } catch {
    return false;
  }
}

function canonicalMessagePayload(message: Omit<GossipMessage, "signature" | "originPublicKey"> & { presence?: PresenceAnnouncement["presence"]; capacity?: CapacityAdvertisement["capacity"] }): Uint8Array {
  const data = stableStringify({
    schemaVersion: message.schemaVersion,
    protocolVersion: message.protocolVersion,
    category: message.category,
    rumorId: message.rumorId,
    originId: message.originId.value,
    clusterId: message.clusterId.value,
    version: message.version,
    issuedAt: message.issuedAt,
    ttlMs: message.ttlMs,
    expiresAt: message.expiresAt,
    payload: message.category === "presence" ? message.presence : message.capacity,
  });
  return sha512(new TextEncoder().encode(data));
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

export function presenceRumorId(originId: NodeId): string {
  return `presence:${originId.value}`;
}

export function capacityRumorId(originId: NodeId): string {
  return `capacity:${originId.value}`;
}

export function createPresenceAnnouncement(input: {
  readonly originId: NodeId;
  readonly clusterId: ClusterId;
  readonly version: number;
  readonly issuedAt: number;
  readonly ttlMs: number;
  readonly state: PresenceState;
  readonly addressHints?: readonly string[];
  readonly privateKey: Uint8Array;
}): PresenceAnnouncement {
  validateCommon(input);
  if (
    input.state !== "online" &&
    input.state !== "draining" &&
    input.state !== "leaving"
  ) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Presence state must be online, draining, or leaving.",
    );
  }
  const hints = input.addressHints ?? [];
  for (const hint of hints) {
    validateNonEmpty(hint, "address hint");
  }
  const base = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: GOSSIP_PROTOCOL_VERSION,
    category: "presence" as const,
    rumorId: presenceRumorId(input.originId),
    originId: input.originId,
    clusterId: input.clusterId,
    version: input.version,
    issuedAt: input.issuedAt,
    ttlMs: input.ttlMs,
    expiresAt: input.issuedAt + input.ttlMs,
    presence: Object.freeze({
      state: input.state,
      addressHints: Object.freeze([...hints]),
    }),
  });
  const { signature, originPublicKey } = signMessage(base, input.privateKey);
  return Object.freeze({ ...base, signature, originPublicKey });
}

export function createCapacityAdvertisement(input: {
  readonly originId: NodeId;
  readonly clusterId: ClusterId;
  readonly version: number;
  readonly issuedAt: number;
  readonly ttlMs: number;
  readonly acceptsWork: boolean;
  readonly supportedModes: readonly CapacityWorkloadMode[];
  readonly resources: CapacityResources;
  readonly privateKey: Uint8Array;
}): CapacityAdvertisement {
  validateCommon(input);
  for (const mode of input.supportedModes) {
    if (mode !== "built-in-diagnostic" && mode !== "arbitrary-container") {
      throw new GossipError(
        "INVALID_GOSSIP_MESSAGE",
        "Unsupported capacity workload mode.",
      );
    }
  }
  validateResource(input.resources.maxConcurrentJobs, "maxConcurrentJobs");
  validateResource(input.resources.cpuMillicores, "cpuMillicores");
  validateResource(input.resources.memoryMb, "memoryMb");
  const base = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    protocolVersion: GOSSIP_PROTOCOL_VERSION,
    category: "capacity" as const,
    rumorId: capacityRumorId(input.originId),
    originId: input.originId,
    clusterId: input.clusterId,
    version: input.version,
    issuedAt: input.issuedAt,
    ttlMs: input.ttlMs,
    expiresAt: input.issuedAt + input.ttlMs,
    capacity: Object.freeze({
      acceptsWork: input.acceptsWork,
      supportedModes: Object.freeze([...input.supportedModes]),
      resources: Object.freeze({ ...input.resources }),
    }),
  });
  const { signature, originPublicKey } = signMessage(base, input.privateKey);
  return Object.freeze({ ...base, signature, originPublicKey });
}

export function isGossipMessageExpired(
  message: GossipMessage,
  now: number,
): boolean {
  validateTimestamp(now, "now");
  return message.expiresAt <= now;
}

/** Boundary validation for any gossip message received from a peer. */
export function validateGossipMessage(
  message: GossipMessage,
  expectedClusterId: ClusterId,
  now: number,
): void {
  if (typeof message !== "object" || message === null) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "A gossip message is required.",
    );
  }
  if (message.schemaVersion !== SCHEMA_VERSION) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Unsupported gossip message schema version.",
    );
  }
  if (message.protocolVersion !== GOSSIP_PROTOCOL_VERSION) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Unsupported gossip protocol version.",
    );
  }
  const category: string = message.category;
  if (category !== "presence" && category !== "capacity") {
    throw new GossipError(
      "GOSSIP_CATEGORY_FORBIDDEN",
      `Gossip category ${category} is not an advisory category.`,
    );
  }
  assertNodeId(message.originId);
  assertClusterId(message.clusterId);
  if (message.clusterId.value !== expectedClusterId.value) {
    throw new GossipError(
      "WRONG_CLUSTER",
      "Gossip message belongs to a different cluster.",
    );
  }
  validateNonEmpty(message.rumorId, "rumorId");
  validateTimestamp(message.version, "version");
  validateTimestamp(message.issuedAt, "issuedAt");
  validateTimestamp(message.ttlMs, "ttlMs");
  if (message.ttlMs <= 0) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Gossip message TTL must be positive.",
    );
  }
  if (message.expiresAt !== message.issuedAt + message.ttlMs) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Gossip message expiry does not match issuedAt + ttlMs.",
    );
  }
  if (isGossipMessageExpired(message, now)) {
    throw new GossipError(
      "GOSSIP_MESSAGE_EXPIRED",
      "Gossip message has expired.",
    );
  }
  // Verify Ed25519 signature binds originId to rumorId
  if (!verifyMessage(message)) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Gossip message signature verification failed.",
    );
  }
  // Verify originPublicKey corresponds to originId (rumorId format: category:nodeId)
  const expectedOriginId = message.rumorId.split(":")[1];
  if (expectedOriginId !== message.originId.value) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "RumorId originId does not match message originId.",
    );
  }
}

function validateCommon(input: {
  readonly originId: NodeId;
  readonly clusterId: ClusterId;
  readonly version: number;
  readonly issuedAt: number;
  readonly ttlMs: number;
}): void {
  assertNodeId(input.originId);
  assertClusterId(input.clusterId);
  validateTimestamp(input.version, "version");
  validateTimestamp(input.issuedAt, "issuedAt");
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      "Gossip TTL must be a positive safe integer.",
    );
  }
  if (input.ttlMs > MAX_GOSSIP_TTL_MS) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      `Gossip TTL cannot exceed ${MAX_GOSSIP_TTL_MS}ms.`,
    );
  }
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      `${label} must be a non-negative safe integer.`,
    );
  }
}

function validateResource(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      `${label} must be a non-negative safe integer.`,
    );
  }
}

function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GossipError(
      "INVALID_GOSSIP_MESSAGE",
      `${label} must not be empty.`,
    );
  }
}
