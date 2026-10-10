/**
 * Transport contract for the peer net: typed shapes only, no implementation here.
 *
 *   caller ──▶ PeerTransport ──▶ dial / openStream / publish / subscribe
 *                  │
 *                  └──▶ InMemoryPeerTransport (only impl; never imported)
 *
 * Declarations only. No libp2p node is constructed in this file.
 */
import { PeerId } from "@libp2p/interface";
import { PeerNetError } from "./errors";

export type TransportStatus = "disconnected" | "connecting" | "connected" | "closed";

export interface TransportHealth {
  readonly status: TransportStatus;
  readonly connectedPeers: number;
  readonly lastError: string | null;
}

export interface MessageHandler {
  (message: PeerMessage): void | Promise<void>;
}

export interface PeerMessage {
  readonly topic: string;
  readonly data: Uint8Array;
  readonly from: PeerId;
  readonly timestamp: number;
}

export interface Subscription {
  unsubscribe(): void;
}

export interface Stream {
  createSource(): AsyncGenerator<Uint8Array, void, unknown>;
  createSink(): {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
    abort(): Promise<void>;
  };
  close(): void;
  abort(): void;
  readonly closed: boolean;
}

export interface VersionedStream {
  readonly topic: string;
  readonly negotiatedVersion: number;
  readonly send: (data: Uint8Array) => Promise<void>;
  readonly close: () => Promise<void>;
}

export interface PeerTransport {
  readonly config: {
    readonly listenAddresses: readonly string[];
    readonly bootstrapPeers: readonly { peerId: PeerId; multiaddrs: readonly string[] }[];
    readonly enableRelay: boolean;
    readonly enableDHT: boolean;
    readonly enableAutoNAT: boolean;
    readonly maxConnections: number;
    readonly connectionTimeout: number;
    readonly handshakeTimeout: number;
  };
  readonly nodeId: any;
  readonly peerId: PeerId;
  readonly privateKey: any;

  createNode(config: any): Promise<PeerTransport>;
  start(): Promise<void>;
  stop(): Promise<void>;
  dial(target: PeerId, multiaddrs?: readonly string[]): Promise<void>;
  hangUp(peerId: PeerId): Promise<void>;
  handle(protocol: string, handler: (stream: Stream) => Promise<void>): void;
  unhandle(protocol: string): void;
  openStream(peerId: PeerId, protocol: string): Promise<Stream>;
  getPeers(): readonly PeerId[];
  getConnectedPeers(): readonly PeerId[];
  getMultiaddrs(): readonly string[];
  getMultiaddrsForPeer(peerId: PeerId): readonly string[];
  authenticate(handshake: any): Promise<{ readonly negotiatedProtocol: number }>;
  openStreamToPeer(peerId: PeerId, topic: string, version: number): Promise<VersionedStream>;
  publish(topic: string, message: PeerMessage): Promise<void>;
  subscribe(topic: string, handler: MessageHandler): Subscription;
  transportHealth(): TransportHealth;
  on(events: Partial<{
    onPeerConnect: (peerId: PeerId) => void;
    onPeerDisconnect: (peerId: PeerId) => void;
    onHandshakeComplete: (peerId: PeerId, negotiatedProtocol: number) => void;
    onError: (error: Error) => void;
  }>): () => void;
}