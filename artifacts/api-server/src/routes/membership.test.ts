import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import express from "express";
import { createNodeId } from "@workspace/opennode-domain";

const mocks = vi.hoisted(() => ({
  getGovernance: vi.fn(),
  getFeatureFlags: vi.fn(),
  getRunCoordinator: vi.fn(),
  acceptsNewAssignments: vi.fn(),
  nodeStore: { listRuns: vi.fn() },
  fenceOnMembershipChange: vi.fn(),
  g: {
    localNodeId: "node-local",
    clusterIdValue: "cluster-1",
    signerNodeId: "node-local",
    localSecretKey: "secret",
    scheme: { sign: vi.fn(() => "sig") },
    hsmSigner: { sign: vi.fn(() => "sig") },
    membershipService: {
      getProposal: vi.fn(),
      listProposals: vi.fn(),
      currentMembership: vi.fn(),
      commitDecision: vi.fn(),
      castVote: vi.fn(),
      requestLeave: vi.fn(),
    },
    membershipLog: {
      getState: vi.fn(),
      commitAdmission: vi.fn(),
      commitEviction: vi.fn(),
      commitLeave: vi.fn(),
      reconcile: vi.fn(),
      issueMembershipCredential: vi.fn(),
    },
    capacity: { isQuarantined: vi.fn() },
    lifecycle: {
      acceptsNewAssignments: vi.fn(),
      handleEviction: vi.fn(),
      handleVoluntaryLeave: vi.fn(),
    },
    proposalMeta: new Map<string, { reason: string; createdAt: Date; targetNodeName: string | null }>(),
    ballots: new Map<string, Map<string, "yes" | "no">>(),
    ballotRevisions: new Map<string, Map<string, number>>(),
    state: { leftLocalNode: false },
  },
}));

vi.mock("../lib/runtime", () => ({
  getGovernance: mocks.getGovernance,
  getFeatureFlags: mocks.getFeatureFlags,
  getRunCoordinator: mocks.getRunCoordinator,
  acceptsNewAssignments: mocks.acceptsNewAssignments,
  nodeStore: mocks.nodeStore,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import membershipRouter, { issuedMembershipCredentials } from "./membership";

let server: Server;
let baseUrl: string;

async function castVote(proposalId: string, choice: "yes" | "no"): Promise<Response> {
  return fetch(`${baseUrl}/membership/proposals/${proposalId}/votes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice }),
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(membershipRouter);
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
  mocks.getGovernance.mockResolvedValue(mocks.g);
  mocks.getFeatureFlags.mockReturnValue({
    isEvictionEnabled: () => true,
    isLeaveEnabled: () => true,
  });
  mocks.getRunCoordinator.mockResolvedValue({
    fenceOnMembershipChange: mocks.fenceOnMembershipChange,
  });
  mocks.fenceOnMembershipChange.mockResolvedValue(0);
  mocks.acceptsNewAssignments.mockReturnValue(true);
  mocks.nodeStore.listRuns.mockResolvedValue({ items: [], nextCursor: null });
  mocks.g.proposalMeta.clear();
  mocks.g.ballots.clear();
  mocks.g.ballotRevisions.clear();
  mocks.g.state.leftLocalNode = false;
  mocks.g.capacity.isQuarantined.mockReturnValue(false);
  mocks.g.lifecycle.acceptsNewAssignments.mockReturnValue(true);
  mocks.g.lifecycle.handleEviction.mockResolvedValue(undefined);
  mocks.g.lifecycle.handleVoluntaryLeave.mockResolvedValue(undefined);
  mocks.g.membershipLog.getState.mockResolvedValue({ epoch: 0, memberIds: ["node-local"] });
  mocks.g.membershipLog.commitAdmission.mockResolvedValue({});
  mocks.g.membershipLog.commitEviction.mockResolvedValue({});
  mocks.g.membershipLog.commitLeave.mockResolvedValue({});
  mocks.g.membershipLog.reconcile.mockResolvedValue(undefined);
  mocks.g.membershipLog.issueMembershipCredential.mockResolvedValue({
    clusterId: "cluster-1",
    nodeId: createNodeId("node-admit"),
    epoch: 1,
    issuedAt: 0,
    expiresAt: 0,
    signature: "sig",
    caFingerprint: "fp",
    serialNumber: "1",
  });
  mocks.g.membershipService.listProposals.mockReturnValue([]);
  mocks.g.membershipService.currentMembership.mockReturnValue({ epoch: 0, memberIds: ["node-local"] });
  mocks.g.membershipService.commitDecision.mockReturnValue({});
  mocks.g.membershipService.castVote.mockReturnValue(undefined);
  issuedMembershipCredentials.clear();
});

function passedProposal(proposalId: string, kind: "admission" | "eviction", subjectId: string) {
  return {
    proposalId,
    kind,
    subjectId,
    status: "passed",
    epoch: 1,
    denominator: 1,
    threshold: 1,
    yesVotes: 1,
    expiresAt: Date.now() + 60_000,
  };
}

describe("membership routes", () => {
  it("GET /membership/status reports the real quarantine state", async () => {
    const res = await fetch(`${baseUrl}/membership/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { quarantinedNodeId: string | null };
    expect(body.quarantinedNodeId).toBeNull();
    expect(mocks.g.capacity.isQuarantined).toHaveBeenCalledWith("node-local");

    mocks.g.capacity.isQuarantined.mockReturnValue(true);
    const quarantined = await fetch(`${baseUrl}/membership/status`);
    expect(quarantined.status).toBe(200);
    const quarantinedBody = (await quarantined.json()) as { quarantinedNodeId: string | null };
    expect(quarantinedBody.quarantinedNodeId).toBe("node-local");
  });

  it("committing an admission fences run leases and issues a stored credential", async () => {
    const proposalId = "proposal-1";
    mocks.g.proposalMeta.set(proposalId, {
      reason: "scale out",
      createdAt: new Date(),
      targetNodeName: null,
    });
    mocks.g.membershipService.getProposal.mockReturnValue(passedProposal(proposalId, "admission", "node-admit"));

    const res = await castVote(proposalId, "yes");
    expect(res.status).toBe(200);

    expect(mocks.g.membershipLog.commitAdmission).toHaveBeenCalledTimes(1);
    expect(mocks.fenceOnMembershipChange).toHaveBeenCalledTimes(1);
    expect(mocks.g.membershipLog.issueMembershipCredential).toHaveBeenCalledTimes(1);
    expect(mocks.g.membershipLog.issueMembershipCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: createNodeId("node-admit"),
        secretKey: "secret",
        ttlMs: expect.any(Number),
      }),
    );
    expect(issuedMembershipCredentials.get("node-admit")).toMatchObject({
      nodeId: createNodeId("node-admit"),
    });
  });

  it("committing an eviction fences run leases and issues no credential", async () => {
    const proposalId = "proposal-2";
    mocks.g.proposalMeta.set(proposalId, {
      reason: "unhealthy",
      createdAt: new Date(),
      targetNodeName: null,
    });
    mocks.g.membershipService.getProposal.mockReturnValue(passedProposal(proposalId, "eviction", "node-victim"));

    const res = await castVote(proposalId, "yes");
    expect(res.status).toBe(200);

    expect(mocks.g.membershipLog.commitEviction).toHaveBeenCalledTimes(1);
    expect(mocks.g.lifecycle.handleEviction).toHaveBeenCalledTimes(1);
    expect(mocks.fenceOnMembershipChange).toHaveBeenCalledTimes(1);
    expect(mocks.g.membershipLog.issueMembershipCredential).not.toHaveBeenCalled();
    expect(issuedMembershipCredentials.has("node-victim")).toBe(false);
  });

  it("committing a voluntary leave fences run leases", async () => {
    mocks.g.membershipService.requestLeave.mockReturnValue({ proposalId: "leave-proposal" });

    const res = await fetch(`${baseUrl}/membership/leave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "retiring" }),
    });
    expect(res.status).toBe(202);

    expect(mocks.g.membershipLog.commitLeave).toHaveBeenCalledTimes(1);
    expect(mocks.fenceOnMembershipChange).toHaveBeenCalledTimes(1);
    expect(mocks.g.membershipLog.issueMembershipCredential).not.toHaveBeenCalled();
  });
});