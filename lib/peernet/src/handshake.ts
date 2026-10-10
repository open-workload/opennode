/**
 * Builds and checks a node handshake record.
 *
 *   keyPair ──▶ createHandshake ──▶ sign(nodeId|peerId|ts) ──▶ record
 *                                                    pub, sig ──┐
 *   record ──▶ verifyHandshake ──▶ rebuild payload ──▶ ed25519 verify(pub)
 *                                      │                      │
 *                                    node id?            bad signature?
 *                                   trusted?                   │
 *                                     │                       ▼
 *                                     └── ok ──▶ { negotiatedProtocol: 1 }
 *
 * The signature is what authenticates the node id; both existing guards can
 * otherwise be satisfied by anyone who knows the expected node id and appears
 * in the trusted list. `negotiatedProtocol` is still hardcoded, not negotiated.
 *
 * Called only from inMemory.ts, which nothing imports.
 */
import { NodeId } from "@workspace/opennode-domain";
import { PeerId, PrivateKey } from "@libp2p/interface";
import { verify as ed25519Verify } from "@noble/ed25519";
import { PeerNetError } from "./errors";

export interface NodeHandshake {
  readonly nodeId: NodeId;
  readonly peerId: PeerId;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly timestamp: number;
}

export interface HandshakeVerifyContext {
  readonly expectedNodeId?: NodeId;
  readonly trustedPeerIds?: readonly PeerId[];
}

/** The exact bytes both sides sign — one definition, so sign and verify cannot drift. */
function handshakePayload(
  nodeId: NodeId,
  peerId: PeerId,
  timestamp: number,
): Uint8Array {
  return new TextEncoder().encode(`${nodeId.value}|${peerId.toString()}|${timestamp}`);
}

export async function createHandshake(
  nodeId: NodeId,
  peerId: PeerId,
  privateKey: PrivateKey,
): Promise<NodeHandshake> {
  const timestamp = Date.now();
  const signature = await privateKey.sign(handshakePayload(nodeId, peerId, timestamp));
  return {
    nodeId,
    peerId,
    publicKey: privateKey.publicKey.raw,
    signature,
    timestamp,
  };
}

export async function verifyHandshake(
  handshake: NodeHandshake,
  context?: HandshakeVerifyContext,
): Promise<{ readonly negotiatedProtocol: number }> {
  if (context?.expectedNodeId && handshake.nodeId.value !== context.expectedNodeId.value) {
    throw new PeerNetError("HANDSHAKE_NODE_ID_MISMATCH", "Node ID mismatch in handshake");
  }
  if (context?.trustedPeerIds && !context.trustedPeerIds.some((p) => p.equals(handshake.peerId))) {
    throw new PeerNetError("HANDSHAKE_UNTRUSTED_PEER", "Peer not in trusted list");
  }
  let signatureValid: boolean;
  try {
    signatureValid = ed25519Verify(
      handshake.signature,
      handshakePayload(handshake.nodeId, handshake.peerId, handshake.timestamp),
      handshake.publicKey,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new PeerNetError(
      "HANDSHAKE_INVALID_SIGNATURE",
      "Handshake signature does not match its public key",
    );
  }
  return { negotiatedProtocol: 1 };
}