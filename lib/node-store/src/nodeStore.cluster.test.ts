import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = { results: [] as unknown[][], call: 0 };
  const chain = (rows: unknown[]) => {
    const promise = Promise.resolve(rows) as Promise<unknown[]> & Record<string, unknown>;
    const self = () => promise;
    promise.from = self;
    promise.where = self;
    promise.orderBy = self;
    promise.groupBy = self;
    promise.limit = self;
    return promise;
  };
  const db = {
    select: () => {
      const rows = state.results[state.call] ?? [];
      state.call += 1;
      return chain(rows);
    },
  };
  return { db, state };
});

vi.mock("@workspace/db", () => ({
  db: dbMock.db,
  activityEventsTable: { createdAt: "activity.createdAt" },
  auditEventsTable: { createdAt: "audit.createdAt" },
  clusterMetadataTable: {},
  clusterNodesTable: { name: "node.name", id: "node.id", status: "node.status", isLocal: "node.isLocal" },
  idempotencyKeysTable: {},
  leasesTable: {},
  localNodeIdentityTable: {},
  membershipProposalsTable: { status: "proposal.status" },
  membershipVotesTable: {},
  peerStatusTable: {},
  runLogEntriesTable: {},
  workloadRunAttemptsTable: {},
  workloadRunsTable: { status: "run.status" },
}));

import { DrizzleNodeStore } from "./nodeStore";

const store = new DrizzleNodeStore();

beforeEach(() => {
  dbMock.state.results = [];
  dbMock.state.call = 0;
});

describe("DrizzleNodeStore cluster reads", () => {
  it("listNodes returns the selected node rows", async () => {
    const rows = [{ id: "node-a" }, { id: "node-b" }];
    dbMock.state.results = [rows];
    await expect(store.listNodes()).resolves.toEqual(rows);
  });

  it("listActivity returns the selected activity rows", async () => {
    const rows = [{ id: "evt-1", kind: "run_submitted" }];
    dbMock.state.results = [rows];
    await expect(store.listActivity(7)).resolves.toEqual(rows);
  });

  it("getClusterMetadata returns null when absent and the row when present", async () => {
    dbMock.state.results = [[], [{ clusterId: "cluster-1", membershipEpoch: 4 }]];
    await expect(store.getClusterMetadata()).resolves.toBeNull();
    await expect(store.getClusterMetadata()).resolves.toEqual({ clusterId: "cluster-1", membershipEpoch: 4 });
  });

  it("countPendingProposals counts the matching rows", async () => {
    dbMock.state.results = [[{ id: "p1" }, { id: "p2" }]];
    await expect(store.countPendingProposals()).resolves.toBe(2);
  });

  it("countRunsByStatus folds grouped rows into a status map", async () => {
    dbMock.state.results = [
      [
        { status: "queued", count: 3 },
        { status: "running", count: 2 },
      ],
    ];
    await expect(store.countRunsByStatus()).resolves.toEqual({ queued: 3, running: 2 });
  });
});
