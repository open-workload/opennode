import {
  RaftConfig,
  RaftState,
  RaftLogEntry,
  VoteRequest,
  VoteResponse,
  AppendEntriesRequest,
  AppendEntriesResponse,
  InstallSnapshotRequest,
  InstallSnapshotResponse,
  RaftMetrics,
  RaftTransport,
  RaftStorage,
} from "./types";
import { SignedLogEntry } from "@workspace/sync-engine";
import { randomUUID } from "crypto";

export class RaftNode {
  private readonly config: RaftConfig;
  private readonly storage: RaftStorage;
  private readonly transport: RaftTransport;

  private state: RaftState = "follower";
  private currentTerm = 0;
  private votedFor: string | null = null;
  private commitIndex = 0;
  private lastApplied = 0;
  private leaderId: string | null = null;
  private lastContact = Date.now();

  private electionTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private applyCallbacks: ((entries: RaftLogEntry[]) => void)[] = [];

  private nextIndex: Map<string, number> = new Map();
  private matchIndex: Map<string, number> = new Map();

  constructor(config: RaftConfig, storage: RaftStorage, transport: RaftTransport) {
    this.config = config;
    this.storage = storage;
    this.transport = transport;
  }

  async start(): Promise<void> {
    this.currentTerm = await this.storage.getCurrentTerm();
    this.votedFor = await this.storage.getVotedFor();
    this.resetElectionTimer();
  }

  async stop(): Promise<void> {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  getMetrics(): RaftMetrics {
    return {
      state: this.state,
      term: this.currentTerm,
      commitIndex: this.commitIndex,
      lastApplied: this.lastApplied,
      leaderId: this.leaderId,
      lastContact: this.lastContact,
    };
  }

  isLeader(): boolean {
    return this.state === "leader";
  }

  getLeaderId(): string | null {
    return this.leaderId;
  }

  onApply(callback: (entries: RaftLogEntry[]) => void): () => void {
    this.applyCallbacks.push(callback);
    return () => {
      const idx = this.applyCallbacks.indexOf(callback);
      if (idx >= 0) this.applyCallbacks.splice(idx, 1);
    };
  }

  async propose(entry: SignedLogEntry): Promise<RaftLogEntry> {
    if (this.state !== "leader") {
      throw new Error("Not leader");
    }

    const lastIndex = await this.storage.getLastIndex();
    const newEntry: RaftLogEntry = {
      index: lastIndex + 1,
      term: this.currentTerm,
      entry,
    };

    await this.storage.appendEntries([newEntry]);
    this.nextIndex.set(this.config.nodeId, newEntry.index + 1);
    this.matchIndex.set(this.config.nodeId, newEntry.index);

    await this.replicate();
    return newEntry;
  }

  async getCommittedEntries(): Promise<RaftLogEntry[]> {
    const entries = await this.storage.getEntries(this.lastApplied + 1, this.commitIndex + 1);
    return entries;
  }

  async applyCommitted(): Promise<void> {
    const entries = await this.getCommittedEntries();
    if (entries.length > 0) {
      for (const callback of this.applyCallbacks) {
        callback(entries);
      }
      this.lastApplied = entries[entries.length - 1].index;
    }
  }

  private resetElectionTimer(): void {
    if (this.electionTimer) clearTimeout(this.electionTimer);
    const timeout = this.randomElectionTimeout();
    this.electionTimer = setTimeout(() => this.startElection(), timeout);
  }

  private randomElectionTimeout(): number {
    return Math.floor(
      Math.random() * (this.config.electionTimeoutMax - this.config.electionTimeoutMin) +
        this.config.electionTimeoutMin
    );
  }

  private async startElection(): Promise<void> {
    this.state = "candidate";
    this.currentTerm++;
    await this.storage.setTerm(this.currentTerm);
    await this.storage.setVotedFor(this.config.nodeId);
    this.votedFor = this.config.nodeId;

    const lastIndex = await this.storage.getLastIndex();
    const lastTerm = await this.storage.getTerm(lastIndex);

    const request: VoteRequest = {
      term: this.currentTerm,
      candidateId: this.config.nodeId,
      lastLogIndex: lastIndex,
      lastLogTerm: lastTerm,
    };

    let votes = 1;
    const majority = Math.floor(this.config.peers.length / 2) + 1;

    for (const peer of this.config.peers) {
      if (peer === this.config.nodeId) continue;
      try {
        const response = await this.transport.sendVoteRequest(peer, request);
        if (response.term > this.currentTerm) {
          await this.becomeFollower(response.term);
          return;
        }
        if (response.voteGranted) {
          votes++;
          if (votes >= majority) {
            await this.becomeLeader();
            return;
          }
        }
      } catch {
        // Ignore network errors
      }
    }

    if (this.state === "candidate") {
      this.resetElectionTimer();
    }
  }

  private async becomeLeader(): Promise<void> {
    this.state = "leader";
    this.leaderId = this.config.nodeId;

    const lastIndex = await this.storage.getLastIndex();
    for (const peer of this.config.peers) {
      this.nextIndex.set(peer, lastIndex + 1);
      this.matchIndex.set(peer, 0);
    }

    this.sendHeartbeats();
    this.heartbeatTimer = setInterval(
      () => this.sendHeartbeats(),
      this.config.heartbeatInterval
    );
  }

  private async becomeFollower(term: number): Promise<void> {
    this.state = "follower";
    this.currentTerm = term;
    await this.storage.setTerm(term);
    this.votedFor = null;
    this.leaderId = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.resetElectionTimer();
  }

  private async sendHeartbeats(): Promise<void> {
    await this.replicate();
  }

  async replicate(): Promise<void> {
    for (const peer of this.config.peers) {
      if (peer === this.config.nodeId) continue;
      this.replicateToPeer(peer);
    }
  }

  private async replicateToPeer(peer: string): Promise<void> {
    const nextIdx = this.nextIndex.get(peer) ?? (await this.storage.getLastIndex()) + 1;
    const prevIndex = nextIdx - 1;
    const prevTerm = await this.storage.getTerm(prevIndex);

    const entries = await this.storage.getEntries(nextIdx, (await this.storage.getLastIndex()) + 1);

    const request: AppendEntriesRequest = {
      term: this.currentTerm,
      leaderId: this.config.nodeId,
      prevLogIndex: prevIndex,
      prevLogTerm: prevTerm,
      entries,
      leaderCommit: this.commitIndex,
    };

    try {
      const response = await this.transport.sendAppendEntries(peer, request);

      if (response.term > this.currentTerm) {
        await this.becomeFollower(response.term);
        return;
      }

      if (response.success) {
        this.nextIndex.set(peer, response.matchIndex + 1);
        this.matchIndex.set(peer, response.matchIndex);
        this.updateCommitIndex();
      } else {
        this.nextIndex.set(peer, Math.max(1, this.nextIndex.get(peer)! - 1));
      }
    } catch {
      // Ignore network errors
    }
  }

  private async updateCommitIndex(): Promise<void> {
    const indices = Array.from(this.matchIndex.values()).sort((a, b) => b - a);
    const majority = Math.floor(this.config.peers.length / 2) + 1;
    const newCommitIndex = indices[majority - 1];

    if (newCommitIndex > this.commitIndex) {
      const term = await this.storage.getTerm(newCommitIndex);
      if (term === this.currentTerm) {
        this.commitIndex = newCommitIndex;
      }
    }
  }

  async handleVoteRequest(request: VoteRequest): Promise<VoteResponse> {
    if (request.term > this.currentTerm) {
      await this.becomeFollower(request.term);
    }

    if (request.term < this.currentTerm) {
      return { term: this.currentTerm, voteGranted: false };
    }

    const lastIndex = await this.storage.getLastIndex();
    const lastTerm = await this.storage.getTerm(lastIndex);

    const logOk =
      request.lastLogTerm > lastTerm ||
      (request.lastLogTerm === lastTerm && request.lastLogIndex >= lastIndex);

    if (logOk && (this.votedFor === null || this.votedFor === request.candidateId)) {
      await this.storage.setVotedFor(request.candidateId);
      this.votedFor = request.candidateId;
      this.resetElectionTimer();
      return { term: this.currentTerm, voteGranted: true };
    }

    return { term: this.currentTerm, voteGranted: false };
  }

  async handleAppendEntries(request: AppendEntriesRequest): Promise<AppendEntriesResponse> {
    if (request.term > this.currentTerm) {
      await this.becomeFollower(request.term);
    }

    this.lastContact = Date.now();
    this.leaderId = request.leaderId;
    this.resetElectionTimer();

    if (request.term < this.currentTerm) {
      return { term: this.currentTerm, success: false, matchIndex: 0 };
    }

    const prevTerm = await this.storage.getTerm(request.prevLogIndex);
    if (request.prevLogIndex > 0 && prevTerm !== request.prevLogTerm) {
      return { term: this.currentTerm, success: false, matchIndex: 0 };
    }

    await this.storage.appendEntries(request.entries);
    this.commitIndex = Math.min(request.leaderCommit, await this.storage.getLastIndex());

    return {
      term: this.currentTerm,
      success: true,
      matchIndex: request.prevLogIndex + request.entries.length,
    };
  }

  async handleInstallSnapshot(request: InstallSnapshotRequest): Promise<InstallSnapshotResponse> {
    if (request.term > this.currentTerm) {
      await this.becomeFollower(request.term);
    }

    if (request.term < this.currentTerm) {
      return { term: this.currentTerm, success: false };
    }

    await this.storage.saveSnapshot(
      request.lastIncludedIndex,
      request.lastIncludedTerm,
      request.snapshot
    );

    return { term: this.currentTerm, success: true };
  }
}