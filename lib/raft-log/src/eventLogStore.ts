import {
  EventLogStore,
  SignedLogEntry,
  validateEntryChain,
} from "@workspace/sync-engine";
import { ClusterId } from "@workspace/opennode-domain";
import { SignatureVerifier } from "@workspace/sync-engine";
import { RaftNode } from "./raft";
import { createInMemoryRaftStorage, RaftStorage } from "./memoryStorage";
import { RaftConfig, RaftTransport, RaftLogEntry } from "./types";

export interface RaftEventLogStoreConfig {
  readonly clusterId: ClusterId;
  readonly nodeId: string;
  readonly peers: readonly string[];
  readonly dataDir: string;
  readonly verifier: SignatureVerifier;
  readonly transport: RaftTransport;
  readonly electionTimeoutMin?: number;
  readonly electionTimeoutMax?: number;
  readonly heartbeatInterval?: number;
  readonly snapshotThreshold?: number;
  readonly snapshotInterval?: number;
}

export class RaftEventLogStore implements EventLogStore {
  private readonly config: RaftEventLogStoreConfig;
  private readonly raft: RaftNode;
  private readonly storage: RaftStorage;
  private readonly verifier: SignatureVerifier;
  private started = false;

  constructor(config: RaftEventLogStoreConfig) {
    this.config = config;
    this.verifier = config.verifier;

    const raftConfig: RaftConfig = {
      clusterId: config.clusterId,
      nodeId: config.nodeId,
      peers: config.peers,
      dataDir: config.dataDir,
      electionTimeoutMin: config.electionTimeoutMin ?? 150,
      electionTimeoutMax: config.electionTimeoutMax ?? 300,
      heartbeatInterval: config.heartbeatInterval ?? 50,
      snapshotThreshold: config.snapshotThreshold ?? 10000,
      snapshotInterval: config.snapshotInterval ?? 30000,
    };

    this.storage = createInMemoryRaftStorage();
    this.raft = new RaftNode(raftConfig, this.storage, config.transport);

    this.raft.onApply((entries) => {
      // Entries are applied via the Raft consensus
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.raft.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.raft.stop();
  }

  isLeader(): boolean {
    return this.raft.isLeader();
  }

  getLeaderId(): string | null {
    return this.raft.getLeaderId();
  }

  async getHeight(): Promise<number> {
    return this.storage.getLastIndex();
  }

  async getEntry(sequence: number): Promise<SignedLogEntry | undefined> {
    const entry = await this.storage.getEntry(sequence);
    return entry?.entry;
  }

  async getRange(
    fromInclusive: number,
    toExclusive: number
  ): Promise<SignedLogEntry[]> {
    const entries = await this.storage.getEntries(fromInclusive, toExclusive);
    return entries.map((e: RaftLogEntry) => e.entry);
  }

  async append(entries: readonly SignedLogEntry[]): Promise<void> {
    if (!this.raft.isLeader()) {
      throw new Error("Not leader; cannot append");
    }

    const raftEntries: RaftLogEntry[] = [];
    let index = await this.storage.getLastIndex();

    for (const entry of entries) {
      index++;
      raftEntries.push({
        index,
        term: await this.storage.getCurrentTerm(),
        entry,
      });
    }

    await this.storage.appendEntries(raftEntries);
    await this.raft.replicate();
  }

  async truncateTo(height: number): Promise<void> {
    await this.storage.truncateTo(height);
  }

  async replace(entries: readonly SignedLogEntry[]): Promise<void> {
    validateEntryChain(entries, {
      clusterId: this.config.clusterId,
      verifier: this.verifier,
      fromSequence: 0,
      prevHash: null,
    });

    await this.storage.truncateTo(0);
    const raftEntries: RaftLogEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      raftEntries.push({
        index: i + 1,
        term: 1,
        entry: entries[i],
      });
    }
    await this.storage.appendEntries(raftEntries);
  }
}