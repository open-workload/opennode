import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { etc, getPublicKey } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "@noble/hashes/utils";
import { createClusterId, createNodeId } from "@workspace/opennode-domain";
import {
  freezeMembership,
  verifyMembershipCertificate,
} from "@workspace/peernet/membership";
import { createEd25519Scheme } from "@workspace/peernet/signatures";
import { createHmacSigner } from "@workspace/sync-engine";
import {
  MembershipLog,
  createInMemoryMembershipLogStore,
  type MembershipLogStore,
} from "./core";

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const CLUSTER = "cluster-credential";
const NODE = "node-credential";
const NOW = 1_700_000_000_000;
const TTL_MS = 60_000;
// A 32-byte secret is an ed25519 private key seed, the CA key certificates are signed with.
const SECRET = "0123456789abcdef0123456789abcdef";

function createMembershipLog(store: MembershipLogStore): MembershipLog {
  return new MembershipLog({
    clusterId: createClusterId(CLUSTER),
    consensusLog: {
      isLeader: () => true,
      getLeaderId: () => NODE,
      propose: async (entry) => entry,
      getHeight: async () => 0,
      getEntry: async () => undefined,
      getRange: async () => [],
      start: async () => undefined,
      stop: async () => undefined,
    },
    signer: createHmacSigner(NODE, SECRET),
    store,
  });
}

describe("MembershipLog.issueMembershipCredential", () => {
  it("derives the CA public key from the secret so certificates verify against the real key", async () => {
    const store = createInMemoryMembershipLogStore();
    const membershipLog = createMembershipLog(store);
    await store.save({
      clusterId: CLUSTER,
      epoch: 1,
      memberIds: Object.freeze([NODE]),
      appliedSequence: 1,
    });
    const nodeId = createNodeId(NODE);

    const cert = await membershipLog.issueMembershipCredential({
      nodeId,
      now: NOW,
      ttlMs: TTL_MS,
      secretKey: SECRET,
      scheme: createEd25519Scheme(),
    });

    const secretBytes = new TextEncoder().encode(SECRET);
    const derivedPublicKey = getPublicKey(secretBytes);
    expect(Buffer.from(derivedPublicKey).equals(Buffer.from(secretBytes))).toBe(
      false,
    );
    expect(cert.caFingerprint).toBe(
      createHash("sha256").update(derivedPublicKey).digest("hex"),
    );

    const frozen = freezeMembership({
      clusterId: createClusterId(CLUSTER),
      epoch: 1,
      memberIds: [nodeId],
    });
    expect(() =>
      verifyMembershipCertificate(cert, frozen, derivedPublicKey, null, {
        now: NOW,
        scheme: createEd25519Scheme(),
      }),
    ).not.toThrow();
  });
});
