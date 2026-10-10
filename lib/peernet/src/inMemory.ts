/**
 * In-memory PeerTransport and the hub it shares. No production caller.
 *
 *   createInMemoryPair ──▶ register on hub ──▶ transport
 *   transport.publish ──▶ hub.deliver ──▶ every other registered transport
 *   transport.authenticate ──▶ verifyHandshake ──▶ PeerNetError | { protocol: 1 }
 *
 * Satisfies the transport.ts contract without any network I/O. Nothing in this
 * repo imports it, and lib/peernet has no test files of its own.
 */
import { NodeId, createNodeId, deriveNodeIdFromSecretKey } from "@workspace/opennode-domain";
import { DiscoveryHint, BootstrapPeer } from "./bootstrap";
import { PeerNetError } from "./errors";
import { NodeHandshake, verifyHandshake, HandshakeVerifyContext } from "./handshake";
import {
  MessageHandler,
  PeerMessage,
  PeerTransport,
  Subscription,
  TransportHealth,
  VersionedStream,
  Stream,
  TransportStatus,
} from "./transport";
import { PrivateKey, PeerId } from "@libp2p/interface";
import { peerIdFromString } from "@libp2p/peer-id";

interface StreamEntry {
  readonly topic: string;
  readonly version: number;
  closed: boolean;
}

/** In-memory transport for deterministic tests; pairs over a shared hub. */
export class InMemoryPeerTransport implements PeerTransport {
  private connectedTargets = new Set<string>();
  private subscriptions = new Map<string, Set<MessageHandler>>();
  private streams: StreamEntry[] = [];
  private status: TransportStatus = "disconnected";
  private lastError: string | null = null;

  public readonly config: any = {
    listenAddresses: [],
    bootstrapPeers: [],
    enableRelay: false,
    enableDHT: false,
    enableAutoNAT: false,
    maxConnections: 100,
    connectionTimeout: 30000,
    handshakeTimeout: 10000,
  };

  constructor(
    public readonly nodeId: NodeId,
    public readonly peerId: PeerId,
    public readonly privateKey: PrivateKey,
    private readonly hub: InMemoryPeerHub,
    private readonly verifyContext?: HandshakeVerifyContext,
  ) {}

  async createNode(config: any): Promise<PeerTransport> {
    throw new PeerNetError("TRANSPORT_CLOSED", "In-memory transport does not support createNode");
  }

  async start(): Promise<void> {
    this.status = "connected";
  }

  async stop(): Promise<void> {
    this.status = "closed";
    this.connectedTargets.clear();
    this.subscriptions.clear();
    for (const stream of this.streams) stream.closed = true;
    this.streams = [];
    this.hub.unlink(this.nodeId.value);
  }

  async dial(target: PeerId, multiaddrs?: any[]): Promise<void> {
    this.assertOpen();
    this.status = "connecting";
    this.hub.link(this.nodeId.value, target.toString());
    this.connectedTargets.add(target.toString());
    this.status = "connected";
  }

  async hangUp(peerId: PeerId): Promise<void> {
    this.assertOpen();
    this.connectedTargets.delete(peerId.toString());
    this.hub.unlink(this.nodeId.value);
  }

  handle(protocol: string, handler: (stream: Stream) => Promise<void>): void {
    this.assertOpen();
    this.hub.registerHandler(this.nodeId.value, protocol, handler);
  }

  unhandle(protocol: string): void {
    this.hub.unregisterHandler(this.nodeId.value, protocol);
  }

  async openStream(peerId: PeerId, protocol: string): Promise<Stream> {
    this.assertOpen();
    const handler = this.hub.getHandler(peerId.toString(), protocol);
    if (!handler) {
      throw new PeerNetError("STREAM_NOT_FOUND", `No handler for protocol ${protocol} on peer ${peerId.toString()}`);
    }
    const mockStream = this.createMockStream();
    handler(mockStream);
    return mockStream;
  }

  getPeers(): readonly PeerId[] {
    return this.hub.getPeers().filter((p) => p.toString() !== this.peerId.toString());
  }

  getConnectedPeers(): readonly PeerId[] {
    return this.hub.getPeers().filter((p) => this.connectedTargets.has(p.toString()));
  }

  getMultiaddrs(): readonly any[] {
    return [];
  }

  getMultiaddrsForPeer(peerId: PeerId): readonly any[] {
    return [];
  }

  async authenticate(handshake: NodeHandshake): Promise<{ readonly negotiatedProtocol: number }> {
    this.assertOpen();
    if (this.verifyContext === undefined) {
      throw new PeerNetError("HANDSHAKE_INVALID_SIGNATURE", "No verifier configured.");
    }
    return verifyHandshake(handshake, this.verifyContext);
  }

  async openStreamToPeer(peerId: PeerId, topic: string, version: number): Promise<VersionedStream> {
    this.assertOpen();
    if (version < 0) {
      throw new PeerNetError("PROTOCOL_RANGE_MISMATCH", "Stream version invalid.");
    }
    const entry: StreamEntry = { topic, version, closed: false };
    this.streams.push(entry);
    return {
      topic,
      negotiatedVersion: version,
      send: async () => undefined,
      close: async () => {
        entry.closed = true;
      },
    };
  }

  async publish(topic: string, message: PeerMessage): Promise<void> {
    this.assertOpen();
    const handlers = this.subscriptions.get(topic);
    if (handlers) {
      for (const handler of handlers) handler(message);
    }
    this.hub.deliver(topic, message, this.nodeId.value);
  }

  subscribe(topic: string, handler: MessageHandler): Subscription {
    this.assertOpen();
    let set = this.subscriptions.get(topic);
    if (!set) {
      set = new Set();
      this.subscriptions.set(topic, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        set.delete(handler);
      },
    };
  }

  transportHealth(): TransportHealth {
    return {
      status: this.status,
      connectedPeers: this.connectedTargets.size,
      lastError: this.lastError,
    };
  }

  on(events: Partial<{
    onPeerConnect: (peerId: PeerId) => void;
    onPeerDisconnect: (peerId: PeerId) => void;
    onHandshakeComplete: (peerId: PeerId, negotiatedProtocol: number) => void;
    onError: (error: Error) => void;
  }>): () => void {
    return () => {};
  }

  receive(message: PeerMessage): void {
    const handlers = this.subscriptions.get(message.topic);
    if (handlers) {
      for (const handler of handlers) handler(message);
    }
  }

  private assertOpen(): void {
    if (this.status === "closed") {
      throw new PeerNetError("TRANSPORT_CLOSED", "Transport is closed.");
    }
  }

  private createMockStream(): Stream {
    const chunks: Uint8Array[] = [];
    let closed = false;
    return {
      createSource() {
        return (async function* () {
          for (const chunk of chunks) {
            yield chunk;
          }
        })();
      },
      createSink() {
        return {
          async write(chunk: Uint8Array) {
            chunks.push(chunk);
          },
          async close() {
            closed = true;
          },
          async abort() {
            closed = true;
          },
        };
      },
      close() {
        closed = true;
      },
      abort() {
        closed = true;
      },
      get closed() {
        return closed;
      },
    } as unknown as Stream;
  }
}

export class InMemoryPeerHub {
  private transports = new Map<string, InMemoryPeerTransport>();
  private handlers = new Map<string, Map<string, (stream: Stream) => Promise<void>>>();

  register(nodeId: NodeId, transport: InMemoryPeerTransport): void {
    this.transports.set(nodeId.value, transport);
  }

  getPeers(): PeerId[] {
    return Array.from(this.transports.values()).map((t) => t.peerId);
  }

  link(_from: string, _to: string): void {}

  unlink(nodeId: string): void {
    this.transports.delete(nodeId);
    this.handlers.delete(nodeId);
  }

  registerHandler(nodeId: string, protocol: string, handler: (stream: Stream) => Promise<void>): void {
    let nodeHandlers = this.handlers.get(nodeId);
    if (!nodeHandlers) {
      nodeHandlers = new Map();
      this.handlers.set(nodeId, nodeHandlers);
    }
    nodeHandlers.set(protocol, handler);
  }

  unregisterHandler(nodeId: string, protocol: string): void {
    const nodeHandlers = this.handlers.get(nodeId);
    if (nodeHandlers) {
      nodeHandlers.delete(protocol);
    }
  }

  getHandler(nodeId: string, protocol: string): ((stream: Stream) => Promise<void>) | undefined {
    const nodeHandlers = this.handlers.get(nodeId);
    return nodeHandlers?.get(protocol);
  }

  deliver(topic: string, message: PeerMessage, senderNodeId: string): void {
    for (const [nodeId, transport] of this.transports) {
      if (nodeId !== senderNodeId) transport.receive(message);
    }
  }
}

export async function createInMemoryPair(
  secretKeyA: string,
  hub: InMemoryPeerHub,
  verifyContext?: HandshakeVerifyContext,
): Promise<InMemoryPeerTransport> {
  const nodeId = createNodeId(deriveNodeIdFromSecretKey(secretKeyA));
  const peerId = await peerIdFromString(nodeId.value);
  const privateKey = {
    sign: async (data: Uint8Array) => data,
    publicKey: { raw: new Uint8Array() },
    equals: () => false,
    type: "Ed25519" as const,
  } as PrivateKey;
  const transport = new InMemoryPeerTransport(
    nodeId,
    peerId,
    privateKey,
    hub,
    verifyContext,
  );
  hub.register(nodeId, transport);
  return transport;
}