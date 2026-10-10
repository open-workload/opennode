/**
 * Wire and storage contracts for the Raft node; types only, no runtime code.
 *
 *   RaftNode ──▶ RaftTransport ──▶ VoteRequest / VoteResponse
 *            ├──▶                ──▶ AppendEntries{Request,Response}
 *            ├──▶                ──▶ InstallSnapshot{Request,Response}
 *            └──▶ RaftStorage ──▶ entries, term, votedFor, snapshot, truncate
 *   RaftConfig { peers, timeouts, heartbeat, snapshot } with RaftState =
 *   "follower" | "candidate" | "leader"; RaftLogEntry = { index, term, entry }
 */
import { ClusterId, SignedLogEntry } from "@workspace/sync-engine";

export interface RaftConfig {
  readonly clusterId: ClusterId;
  readonly nodeId: string;
  readonly peers: readonly string[];
  readonly dataDir: string;
  readonly electionTimeoutMin: number;
  readonly electionTimeoutMax: number;
  readonly heartbeatInterval: number;
  readonly snapshotThreshold: number;
  readonly snapshotInterval: number;
}

export type RaftState = "follower" | "candidate" | "leader";

export interface RaftLogEntry {
  readonly index: number;
  readonly term: number;
  readonly entry: SignedLogEntry;
}

export interface VoteRequest {
  readonly term: number;
  readonly candidateId: string;
  readonly lastLogIndex: number;
  readonly lastLogTerm: number;
}

export interface VoteResponse {
  readonly term: number;
  readonly voteGranted: boolean;
}

export interface AppendEntriesRequest {
  readonly term: number;
  readonly leaderId: string;
  readonly prevLogIndex: number;
  readonly prevLogTerm: number;
  readonly entries: readonly RaftLogEntry[];
  readonly leaderCommit: number;
}

export interface AppendEntriesResponse {
  readonly term: number;
  readonly success: boolean;
  readonly matchIndex: number;
}

export interface InstallSnapshotRequest {
  readonly term: number;
  readonly leaderId: string;
  readonly lastIncludedIndex: number;
  readonly lastIncludedTerm: number;
  readonly snapshot: Uint8Array;
}

export interface InstallSnapshotResponse {
  readonly term: number;
  readonly success: boolean;
}

export interface RaftMetrics {
  readonly state: RaftState;
  readonly term: number;
  readonly commitIndex: number;
  readonly lastApplied: number;
  readonly leaderId: string | null;
  readonly lastContact: number;
}

export interface RaftTransport {
  sendVoteRequest(target: string, request: VoteRequest): Promise<VoteResponse>;
  sendAppendEntries(target: string, request: AppendEntriesRequest): Promise<AppendEntriesResponse>;
  sendInstallSnapshot(target: string, request: InstallSnapshotRequest): Promise<InstallSnapshotResponse>;
}

export interface RaftStorage {
  getFirstIndex(): Promise<number>;
  getLastIndex(): Promise<number>;
  getTerm(index: number): Promise<number>;
  getEntry(index: number): Promise<RaftLogEntry | undefined>;
  getEntries(from: number, to: number): Promise<RaftLogEntry[]>;
  appendEntries(entries: readonly RaftLogEntry[]): Promise<void>;
  truncateSuffix(index: number): Promise<void>;
  truncateTo(height: number): Promise<void>;
  setTerm(term: number): Promise<void>;
  getCurrentTerm(): Promise<number>;
  setVotedFor(candidateId: string): Promise<void>;
  getVotedFor(): Promise<string | null>;
  saveSnapshot(index: number, term: number, data: Uint8Array): Promise<void>;
  loadSnapshot(): Promise<{ index: number; term: number; data: Uint8Array } | null>;
}