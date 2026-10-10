/**
 * Builds and checks a node handshake record. Nothing here verifies a signature.
 *
 *   nodeId + peerId + privateKey ──▶ createHandshake ──▶ signed payload ──▶ record
 *                                                                          (no callers)
 *   record ──▶ verifyHandshake ──▶ expectedNodeId? ──▶ reject ──▶ trustedPeerIds?
 *                │                 reject                    reject
 *                └──▶ { negotiatedProtocol: 1 }  (hardcoded, not negotiated)
 *
 * Called only from inMemory.ts, which nothing imports.
 */
import { NodeId } from "@workspace/opennode-domain";
import { PeerId, PrivateKey } from "@libp2p/interface";
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

export async function createHandshake(
  nodeId: NodeId,
  peerId: PeerId,
  privateKey: PrivateKey,
): Promise<NodeHandshake> {
  const timestamp = Date.now();
  const payload = new TextEncoder().encode(`${nodeId.value}|${peerId.toString()}|${timestamp}`);
  const signature = await privateKey.sign(payload);
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
  return { negotiatedProtocol: 1 };
}