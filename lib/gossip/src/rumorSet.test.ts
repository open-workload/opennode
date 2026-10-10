/**
 * OPS-01 hostile-input suite for the RumorSet replay surface.
 *
 *   RumorSet.ingest(msg, now)
 *        │  assertAdvisory :93 ─▶ validateGossipMessage :94 ─▶ version compare :96
 *        │                                                  ─▶ duplicate :97 / stale :103
 *        ▼
 *   appends to Map → result "applied" | "duplicate" | "stale-version"
 *
 *   reconcile(remoteDigest) ─▶ validateDigest(:243) version gate (:248)
 *
 * Fresh rumors are applied; replayed/stale versions are rejected so an
 * attacker cannot roll a stored rumor back to an older signed version.
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
  type GossipMessage,
  type RumorDigest,
} from "./messages";
import { RumorSet } from "./rumorSet";

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const NOW = 1_700_000_000_000;
const CLUSTER = createClusterId("cluster-1");
const OTHER_CLUSTER = createClusterId("cluster-2");
const ORIGIN = createNodeId("node-a");
const PRIVATE_KEY = utils.randomPrivateKey();

function announcement(
  version: number,
  options: {
    readonly clusterId?: ClusterId;
    readonly originId?: NodeId;
    readonly issuedAt?: number;
    readonly ttlMs?: number;
  } = {},
): GossipMessage {
  const issuedAt = options.issuedAt ?? NOW;
  const ttlMs = options.ttlMs ?? 60_000;
  return createPresenceAnnouncement({
    originId: options.originId ?? ORIGIN,
    clusterId: options.clusterId ?? CLUSTER,
    version,
    issuedAt,
    ttlMs,
    state: "online",
    privateKey: PRIVATE_KEY,
  });
}

function tamperSignature(message: GossipMessage): GossipMessage {
  const bytes = Uint8Array.from(message.signature.value);
  bytes[0] ^= 0xff;
  return { ...message, signature: { value: bytes } };
}

describe("RumorSet replay", () => {
  it("accepts a fresh rumor", () => {
    const set = new RumorSet(CLUSTER);
    const message = announcement(1);

    expect(set.ingest(message, NOW)).toBe("applied");
    expect(set.size).toBe(1);
    expect(set.get(message.rumorId)?.version).toBe(1);
  });

  it("rejects an exact replay of the same version as duplicate", () => {
    const set = new RumorSet(CLUSTER);
    const message = announcement(1);

    expect(set.ingest(message, NOW)).toBe("applied");
    expect(set.ingest(message, NOW)).toBe("duplicate");
    expect(set.size).toBe(1);
  });

  it("rejects a replayed stale (lower) version", () => {
    const set = new RumorSet(CLUSTER);
    const fresh = announcement(2);
    const stale = announcement(1);

    expect(set.ingest(fresh, NOW)).toBe("applied");
    expect(set.ingest(stale, NOW)).toBe("stale-version");
    expect(set.get(fresh.rumorId)?.version).toBe(2);
    expect(set.size).toBe(1);
  });

  it("rejects a rumor whose signature was tampered", () => {
    const set = new RumorSet(CLUSTER);
    const tampered = tamperSignature(announcement(1));

    expect(() => set.ingest(tampered, NOW)).toThrow(
      expect.objectContaining({ code: "INVALID_GOSSIP_MESSAGE" }),
    );
    expect(set.size).toBe(0);
  });

  it("rejects a rumor from a different cluster", () => {
    const set = new RumorSet(CLUSTER);
    const foreign = announcement(1, { clusterId: OTHER_CLUSTER });

    expect(() => set.ingest(foreign, NOW)).toThrow(
      expect.objectContaining({ code: "WRONG_CLUSTER" }),
    );
    expect(set.size).toBe(0);
  });

  it("rejects a replayed digest with a downgraded protocol version", () => {
    const set = new RumorSet(CLUSTER);
    const digest = {
      schemaVersion: SCHEMA_VERSION,
      protocolVersion: GOSSIP_PROTOCOL_VERSION - 1,
      clusterId: CLUSTER,
      entries: [],
      setHash: "deadbeef",
    } as unknown as RumorDigest;

    expect(() => set.reconcile(digest)).toThrow(
      expect.objectContaining({
        code: "INVALID_DIGEST",
        message: "Unsupported digest version.",
      }),
    );
  });
});
