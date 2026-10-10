import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";
import {
  GetDashboardSummaryResponse,
  ListActivityResponse,
  ListNodesResponse,
} from "@workspace/api-zod";

const mocks = vi.hoisted(() => ({
  nodeStore: {
    listNodes: vi.fn(),
    listActivity: vi.fn(),
    getClusterMetadata: vi.fn(),
    countPendingProposals: vi.fn(),
    countRunsByStatus: vi.fn(),
    getLocalNodeId: vi.fn(),
    listRuns: vi.fn(),
  },
  getGovernance: vi.fn(),
}));

vi.mock("../lib/runtime", () => ({
  nodeStore: mocks.nodeStore,
  getGovernance: mocks.getGovernance,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import clusterRouter from "./cluster";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const EARLIER = new Date("2026-01-01T00:00:00.000Z");

const nodeRows = [
  {
    id: "node-a",
    name: "Alpha",
    publicKey: "pk-a",
    status: "local",
    role: "validator",
    protocolVersion: "1.0.0",
    membershipEpoch: 3,
    lastSeenAt: NOW,
    address: "127.0.0.1:9000",
    canExecute: true,
    isLocal: true,
    updatedAt: NOW,
  },
  {
    id: "node-b",
    name: "Beta",
    publicKey: null,
    status: "connected",
    role: "worker",
    protocolVersion: "1.0.0",
    membershipEpoch: 3,
    lastSeenAt: null,
    address: null,
    canExecute: true,
    isLocal: false,
    updatedAt: NOW,
  },
];

const activityRows = [
  { id: "evt-1", kind: "run_submitted", message: "Run submitted", createdAt: NOW, actorNodeId: "node-a" },
  { id: "evt-2", kind: "run_finished", message: "Run succeeded", createdAt: EARLIER, actorNodeId: null },
];

const runRow = {
  id: "run-1",
  clientRequestId: "client-req-1",
  name: "Diagnostic",
  mode: "diagnostic",
  image: null,
  imageDigest: null,
  command: [],
  status: "succeeded",
  executionMode: "built_in_diagnostic",
  submittedBy: "node-a",
  submittedViaNodeId: "node-a",
  workerNodeId: "node-a",
  attemptCount: 1,
  resources: { cpuMilli: 100, memoryMiB: 64, diskMiB: 64, timeoutSeconds: 60 },
  networkPolicy: "deny_all",
  failureReason: null,
  requestFingerprint: "",
  createdAt: NOW,
  updatedAt: NOW,
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(clusterRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getGovernance.mockResolvedValue({ clusterIdValue: "gov-cluster" });
});

describe("cluster routes", () => {
  it("GET /nodes returns nodes validated by ListNodesResponse", async () => {
    mocks.nodeStore.listNodes.mockResolvedValue(nodeRows);

    const res = await fetch(`${baseUrl}/nodes`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    const parsed = ListNodesResponse.parse(body);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      id: "node-a",
      name: "Alpha",
      status: "local",
      role: "validator",
      isLocal: true,
      canExecute: true,
    });
    expect(parsed[0].lastSeenAt).toEqual(NOW);
    expect(parsed[1].lastSeenAt).toBeNull();
    expect(body[0]).not.toHaveProperty("publicKey");
    expect(body[0]).not.toHaveProperty("updatedAt");
  });

  it("GET /activity defaults limit to 20", async () => {
    mocks.nodeStore.listActivity.mockResolvedValue(activityRows);

    const res = await fetch(`${baseUrl}/activity`);
    expect(res.status).toBe(200);
    expect(mocks.nodeStore.listActivity).toHaveBeenCalledWith(20);

    const body = (await res.json()) as unknown[];
    const parsed = ListActivityResponse.parse(body);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ id: "evt-1", kind: "run_submitted", actorNodeId: "node-a" });
    expect(parsed[1].actorNodeId).toBeNull();
  });

  it("GET /activity honors an explicit in-range limit", async () => {
    mocks.nodeStore.listActivity.mockResolvedValue([]);

    const res = await fetch(`${baseUrl}/activity?limit=5`);
    expect(res.status).toBe(200);
    expect(mocks.nodeStore.listActivity).toHaveBeenCalledWith(5);
  });

  it("GET /activity rejects limits outside 1..100", async () => {
    for (const limit of ["0", "101", "-1", "not-a-number"]) {
      const res = await fetch(`${baseUrl}/activity?limit=${limit}`);
      expect(res.status).toBe(400);
    }
    expect(mocks.nodeStore.listActivity).not.toHaveBeenCalled();
  });

  it("GET /dashboard/summary composes cluster, run counts, and recent items", async () => {
    mocks.nodeStore.getClusterMetadata.mockResolvedValue(null);
    mocks.nodeStore.listNodes.mockResolvedValue(nodeRows);
    mocks.nodeStore.getLocalNodeId.mockResolvedValue("node-a");
    mocks.nodeStore.listRuns.mockResolvedValue({ items: [runRow], nextCursor: null });
    mocks.nodeStore.listActivity.mockResolvedValue(activityRows);
    mocks.nodeStore.countPendingProposals.mockResolvedValue(1);
    mocks.nodeStore.countRunsByStatus.mockResolvedValue({
      queued: 2,
      starting: 1,
      running: 3,
      succeeded: 4,
      failed: 1,
      timed_out: 2,
      infrastructure_error: 3,
      cancelled: 9,
    });

    const res = await fetch(`${baseUrl}/dashboard/summary`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = GetDashboardSummaryResponse.parse(body);

    expect(parsed.cluster).toEqual({
      clusterId: "gov-cluster",
      membershipEpoch: 0,
      memberCount: 2,
      connectedCount: 1,
      pendingProposalCount: 1,
      syncStatus: "local_only",
      consensusStatus: "local_only",
      localNodeId: "node-a",
    });
    expect(parsed.runCounts).toEqual({ queued: 2, running: 4, succeeded: 4, failed: 6 });
    expect(mocks.getGovernance).toHaveBeenCalledTimes(1);
    expect(mocks.nodeStore.listRuns).toHaveBeenCalledWith({ limit: 5 });
    expect(mocks.nodeStore.listActivity).toHaveBeenCalledWith(5);
    expect(parsed.recentRuns.map((r) => r.id)).toEqual(["run-1"]);
    expect(parsed.recentActivity.map((a) => a.id)).toEqual(["evt-1", "evt-2"]);
  });

  it("GET /dashboard/summary prefers persisted cluster metadata", async () => {
    mocks.nodeStore.getClusterMetadata.mockResolvedValue({
      singleton: true,
      clusterId: "persisted-cluster",
      membershipEpoch: 7,
      syncStatus: "synced",
      consensusStatus: "healthy",
    });
    mocks.nodeStore.listNodes.mockResolvedValue(nodeRows);
    mocks.nodeStore.getLocalNodeId.mockResolvedValue("node-a");
    mocks.nodeStore.listRuns.mockResolvedValue({ items: [], nextCursor: null });
    mocks.nodeStore.listActivity.mockResolvedValue([]);
    mocks.nodeStore.countPendingProposals.mockResolvedValue(0);
    mocks.nodeStore.countRunsByStatus.mockResolvedValue({});

    const res = await fetch(`${baseUrl}/dashboard/summary`);
    expect(res.status).toBe(200);
    const parsed = GetDashboardSummaryResponse.parse(await res.json());

    expect(parsed.cluster.clusterId).toBe("persisted-cluster");
    expect(parsed.cluster.membershipEpoch).toBe(7);
    expect(parsed.cluster.syncStatus).toBe("synced");
    expect(parsed.cluster.consensusStatus).toBe("healthy");
    expect(parsed.runCounts).toEqual({ queued: 0, running: 0, succeeded: 0, failed: 0 });
    expect(mocks.getGovernance).not.toHaveBeenCalled();
  });
});
