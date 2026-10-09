import { NodeId, createNodeId } from "@workspace/opennode-domain";
import { PeerId } from "@libp2p/interface";

export interface BootstrapPeer {
  readonly peerId: PeerId;
  readonly multiaddrs: readonly string[];
}

export interface DiscoveryHint {
  readonly nodeId: NodeId;
  readonly peerId: PeerId;
  readonly multiaddrs: readonly string[];
}

export async function discoverPeers(_bootstrapPeers: readonly BootstrapPeer[]): Promise<readonly DiscoveryHint[]> {
  return [];
}

export function createBootstrapPeer(nodeId: NodeId, peerId: PeerId, multiaddrs: readonly string[]): BootstrapPeer {
  return { peerId, multiaddrs };
}