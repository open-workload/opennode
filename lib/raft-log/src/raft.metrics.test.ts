/**
 * Consensus alert-metric producers (OPS-03).
 *
 *   RaftNode.start ──▶ election ──▶ becomeLeader/becomeFollower
 *                                     │
 *        propose ──▶ consensus.proposal_age_ms ──▶ renderMetrics()
 *        sendHeartbeats ─▶ consensus.proposal_age_ms
 *        quorum changes ──▶ consensus.quorum_available
 *
 * Real timers: the election timeout is random 150–300ms, so each case waits
 * past one timeout before asserting. Nodes are always stopped in afterEach.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createClusterEvent,
  createClusterId,
} from "@workspace/opennode-domain";
import {
  createHmacSigner,
  signEntry,
  type SignedLogEntry,
} from "@workspace/sync-engine";
import { renderMetrics } from "@workspace/observability";
import { RaftNode } from "./raft";
import { createInMemoryRaftStorage } from "./memoryStorage";
import type { RaftConfig, RaftTransport } from "./types";

const CLUSTER = createClusterId("cluster-1");
const NODE_A = "node-a";
const NODE_B = "node-b";

const nodes: RaftNode[] = [];

afterEach(async () => {
  while (nodes.length > 0) {
    await nodes.pop()!.stop();
  }
});

function createConfig(peers: readonly string[], nodeId: string): RaftConfig {
  return {
    clusterId: CLUSTER,
    nodeId,
    peers,
    dataDir: "/tmp/raft",
    electionTimeoutMin: 150,
    electionTimeoutMax: 300,
    heartbeatInterval: 50,
    snapshotThreshold: 10000,
    snapshotInterval: 30000,
  };
}

function createTransport(voteGranted: boolean): RaftTransport {
  return {
    async sendVoteRequest() {
      return { term: 0, voteGranted };
    },
    async sendAppendEntries() {
      return { term: 0, success: true, matchIndex: 0 };
    },
    async sendInstallSnapshot() {
      return { term: 0, success: true };
    },
  };
}

function createSignedEntry(): SignedLogEntry {
  const signer = createHmacSigner(NODE_A, "test-secret");
  const event = createClusterEvent({
    eventId: "event-1",
    clusterId: CLUSTER,
    sequence: 0,
    epoch: 1,
    kind: "admission",
    correlationId: "corr-1",
    payload: { type: "admission" },
  });
  return signEntry(event, null, signer);
}

async function startNode(config: RaftConfig, transport: RaftTransport): Promise<RaftNode> {
  const node = new RaftNode(config, createInMemoryRaftStorage(), transport);
  nodes.push(node);
  await node.start();
  return node;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("raft consensus metrics", () => {
  it("emits quorum_available 1 when a node wins its election", async () => {
    await startNode(createConfig([NODE_A, NODE_B], NODE_A), createTransport(true));
    await wait(500);

    expect(renderMetrics()).toContain('consensus.quorum_available{nodeId="node-a"} 1');
  });

  it("emits quorum_available 0 when an election fails", async () => {
    await startNode(createConfig([NODE_A, NODE_B], NODE_A), createTransport(false));
    await wait(500);

    expect(renderMetrics()).toContain('consensus.quorum_available{nodeId="node-a"} 0');
  });

  it("emits proposal_age_ms 0 when the leader proposes an entry", async () => {
    const node = await startNode(createConfig([NODE_A, NODE_B], NODE_A), createTransport(true));
    await wait(500);

    await node.propose(createSignedEntry());

    expect(renderMetrics()).toContain('consensus.proposal_age_ms{nodeId="node-a"} 0');
  });
});
