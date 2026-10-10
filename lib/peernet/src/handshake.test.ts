import { beforeAll, describe, expect, it } from "vitest";
import { etc, sign as ed25519Sign } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { concatBytes } from "@noble/hashes/utils";
import { peerIdFromMultihash, peerIdFromString } from "@libp2p/peer-id";
import { sha256 } from "multiformats/hashes/sha2";
import { createEd25519KeyPair } from "./signatures";
import { createHandshake, verifyHandshake, type NodeHandshake } from "./handshake";
import { PeerNetError } from "./errors";

/**
 * A handshake record must authenticate the node that claims it.
 *
 *   createHandshake ──▶ record{nodeId, peerId, pub, sig, ts}
 *                            │
 *                            ▼
 *   verifyHandshake ──▶ payload(nodeId|peerId|ts) ──▶ ed25519 verify(pub)
 *                            │
 *                   bad signature ──▶ HANDSHAKE_SIGNATURE_INVALID
 */

etc.sha512Sync = (...messages: Uint8Array[]) => sha512(concatBytes(...messages));

const PEER_ID_STRING = "QmWR4nmGZHZ3fYyyg1ggJXUmiaZJXT8dFCDKvLpVH2U8wp";

/** A deterministic peer id — the handshake format only needs a stable toString(). */
function peerId() {
  return peerIdFromMultihash(sha256.digest(new TextEncoder().encode("handshake-test-peer")));
}

let cached: Awaited<ReturnType<typeof build>>;
beforeAll(async () => {
  cached = await build();
});

async function build() {
  const { privateKey, publicKey } = createEd25519KeyPair();
  const key = {
    sign: (message: Uint8Array) => ed25519Sign(message, privateKey),
    publicKey: { raw: publicKey },
  };
  const handshake = await createHandshake({ value: "node-a" } as never, peerId(), key as never);
  return { handshake, publicKey };
}

describe("verifyHandshake (NET-04)", () => {
  it("accepts a handshake whose signature matches its public key", async () => {
    await expect(verifyHandshake(cached.handshake)).resolves.toEqual({ negotiatedProtocol: 1 });
  });

  it("rejects a tampered signature", async () => {
    const signature = new Uint8Array(cached.handshake.signature);
    signature[0] = (signature[0] ?? 0) ^ 0xff;

    await expect(
      verifyHandshake({ ...cached.handshake, signature }),
    ).rejects.toBeInstanceOf(PeerNetError);
  });

  it("rejects a record re-stamped with a different node id", async () => {
    await expect(
      verifyHandshake({ ...cached.handshake, nodeId: { value: "node-b" } as never }),
    ).rejects.toBeInstanceOf(PeerNetError);
  });

  it("rejects a record whose timestamp was moved", async () => {
    await expect(
      verifyHandshake({ ...cached.handshake, timestamp: cached.handshake.timestamp + 60_000 }),
    ).rejects.toBeInstanceOf(PeerNetError);
  });

  it("rejects a record carrying an unrelated public key", async () => {
    const other = createEd25519KeyPair();
    await expect(
      verifyHandshake({ ...cached.handshake, publicKey: other.publicKey }),
    ).rejects.toBeInstanceOf(PeerNetError);
  });

  it("still enforces the expected node id", async () => {
    await expect(
      verifyHandshake(cached.handshake, { expectedNodeId: { value: "other" } as never }),
    ).rejects.toBeInstanceOf(PeerNetError);
  });

  it("still rejects a peer outside the trusted list", async () => {
    await expect(
      verifyHandshake(cached.handshake, { trustedPeerIds: [peerIdFromString(PEER_ID_STRING)] }),
    ).rejects.toBeInstanceOf(PeerNetError);
  });
});