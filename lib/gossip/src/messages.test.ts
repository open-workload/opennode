/**
 * OPS-01 hostile-input suite for gossip message boundary validation.
 *
 *   hostile GossipMessage ──▶ validateGossipMessage(msg, expectedClusterId, now)
 *        │  schema :271 ─▶ protocol :277 ─▶ category :284 ─▶ cluster :292
 *        │  ─▶ ttl/expiry :302/:308/:314 ─▶ ed25519 gate :321 ─▶ rumorId bind :329
 *        ▼
 *   each branch throws GossipError{code} → asserted below
 *
 * Fixtures are signed with a real ed25519 key so that the ONLY reason a
 * message is rejected is the validation branch under test. If a branch is
 * removed, the hostile (but validly signed) message slips through and the
 * test fails. `etc.sha512Sync` is required by @noble/ed25519 for sync sign.
 */
import { describe, it, expect } from "vitest";
import { etc, utils } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "@noble/hashes/utils";
import {
  ClusterId,
  NodeId,
  SCHEMA_VERSION,
  createClusterId,
  createNodeId,
} from "@workspace/opennode-domain";
import {
  GOSSIP_PROTOCOL_VERSION,
  createPresenceAnnouncement,
  signMessage,
  validateGossipMessage,
  verifyMessage,
  type GossipMessage,
} from "./messages";

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const NOW = 1_700_000_000_000;
const CLUSTER = createClusterId("cluster-1");
const OTHER_CLUSTER = createClusterId("cluster-2");
const ORIGIN = createNodeId("node-a");
const PRIVATE_KEY = utils.randomPrivateKey();

interface ForgeOptions {
  readonly schemaVersion?: number;
  readonly protocolVersion?: number;
  readonly category?: string;
  readonly rumorId?: string;
  readonly originId?: NodeId;
  readonly clusterId?: ClusterId;
  readonly version?: number;
  readonly issuedAt?: number;
  readonly ttlMs?: number;
  readonly expiresAt?: number;
}

/**
 * Builds a fully valid ed25519-signed presence announcement, then overlays
 * the hostile field. Because the signature covers the overlaid field, the
 * resulting message passes the signature gate and can only be rejected by the
 * specific branch under test.
 */
function forgePresence(options: ForgeOptions = {}): GossipMessage {
  const issuedAt = options.issuedAt ?? NOW;
  const ttlMs = options.ttlMs ?? 60_000;
  const originId = options.originId ?? ORIGIN;
  const base = {
    schemaVersion: options.schemaVersion ?? SCHEMA_VERSION,
    protocolVersion: options.protocolVersion ?? GOSSIP_PROTOCOL_VERSION,
    category: options.category ?? "presence",
    rumorId: options.rumorId ?? `presence:${originId.value}`,
    originId,
    clusterId: options.clusterId ?? CLUSTER,
    version: options.version ?? 1,
    issuedAt,
    ttlMs,
    expiresAt: options.expiresAt ?? issuedAt + ttlMs,
    presence: { state: "online", addressHints: [] as string[] },
  };
  const { signature, originPublicKey } = signMessage(
    base as unknown as Omit<GossipMessage, "signature" | "originPublicKey">,
    PRIVATE_KEY,
  );
  return { ...base, signature, originPublicKey } as unknown as GossipMessage;
}

function createValidAnnouncement(): GossipMessage {
  return createPresenceAnnouncement({
    originId: ORIGIN,
    clusterId: CLUSTER,
    version: 1,
    issuedAt: NOW,
    ttlMs: 60_000,
    state: "online",
    privateKey: PRIVATE_KEY,
  });
}

function tamperSignature(message: GossipMessage): GossipMessage {
  const bytes = Uint8Array.from(message.signature.value);
  bytes[0] ^= 0xff;
  return { ...message, signature: { value: bytes } };
}

describe("validateGossipMessage — malformed events", () => {
  it("accepts a well-formed signed presence announcement (positive control)", () => {
    const message = createValidAnnouncement();
    expect(verifyMessage(message)).toBe(true);
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).not.toThrow();
  });

  it("rejects a non-object message", () => {
    expect(() =>
      validateGossipMessage(null as unknown as GossipMessage, CLUSTER, NOW),
    ).toThrow(
      expect.objectContaining({
        name: "GossipError",
        code: "INVALID_GOSSIP_MESSAGE",
        message: "A gossip message is required.",
      }),
    );
  });

  it("rejects a mismatched schema version (malformed event)", () => {
    const message = forgePresence({ schemaVersion: SCHEMA_VERSION + 1 });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({
        code: "INVALID_GOSSIP_MESSAGE",
        message: "Unsupported gossip message schema version.",
      }),
    );
  });

  it("rejects a forbidden category", () => {
    const message = forgePresence({ category: "membership" });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({ code: "GOSSIP_CATEGORY_FORBIDDEN" }),
    );
  });

  it("rejects a message from a different cluster", () => {
    const message = forgePresence({ clusterId: OTHER_CLUSTER });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({ code: "WRONG_CLUSTER" }),
    );
  });

  it("rejects a rumorId that does not bind originId", () => {
    const message = forgePresence({ rumorId: "presence:node-b" });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({
        code: "INVALID_GOSSIP_MESSAGE",
        message: "RumorId originId does not match message originId.",
      }),
    );
  });

  it("rejects a non-positive TTL", () => {
    const message = forgePresence({ ttlMs: 0, expiresAt: NOW });
    expect(() => validateGossipMessage(message, CLUSTER, NOW - 1)).toThrow(
      expect.objectContaining({
        code: "INVALID_GOSSIP_MESSAGE",
        message: "Gossip message TTL must be positive.",
      }),
    );
  });

  it("rejects an expiry that does not equal issuedAt + ttlMs", () => {
    const message = forgePresence({ expiresAt: NOW + 60_000 + 1 });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({
        code: "INVALID_GOSSIP_MESSAGE",
        message: "Gossip message expiry does not match issuedAt + ttlMs.",
      }),
    );
  });

  it("rejects an expired message", () => {
    const message = forgePresence({
      issuedAt: 0,
      ttlMs: 1_000,
      expiresAt: 1_000,
    });
    expect(() => validateGossipMessage(message, CLUSTER, 2_000)).toThrow(
      expect.objectContaining({
        code: "GOSSIP_MESSAGE_EXPIRED",
        message: "Gossip message has expired.",
      }),
    );
  });
});

describe("validateGossipMessage — signature failures", () => {
  it("verifyMessage returns true for an intact signature", () => {
    expect(verifyMessage(createValidAnnouncement())).toBe(true);
  });

  it("verifyMessage returns false for a tampered signature", () => {
    expect(verifyMessage(tamperSignature(createValidAnnouncement()))).toBe(false);
  });

  it("rejects a message whose signature does not verify", () => {
    const tampered = tamperSignature(createValidAnnouncement());
    expect(() => validateGossipMessage(tampered, CLUSTER, NOW)).toThrow(
      expect.objectContaining({
        code: "INVALID_GOSSIP_MESSAGE",
        message: "Gossip message signature verification failed.",
      }),
    );
  });
});

describe("validateGossipMessage — protocol downgrade", () => {
  it("rejects a downgraded schema version", () => {
    const message = forgePresence({ schemaVersion: SCHEMA_VERSION - 1 });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({ code: "INVALID_GOSSIP_MESSAGE" }),
    );
  });

  it("rejects a downgraded protocol version", () => {
    const message = forgePresence({
      protocolVersion: GOSSIP_PROTOCOL_VERSION - 1,
    });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({
        code: "INVALID_GOSSIP_MESSAGE",
        message: "Unsupported gossip protocol version.",
      }),
    );
  });

  it("rejects an unsupported (future) protocol version", () => {
    const message = forgePresence({
      protocolVersion: GOSSIP_PROTOCOL_VERSION + 1,
    });
    expect(() => validateGossipMessage(message, CLUSTER, NOW)).toThrow(
      expect.objectContaining({ code: "INVALID_GOSSIP_MESSAGE" }),
    );
  });
});
