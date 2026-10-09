import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import {
  CastMembershipVoteBody,
  CreateMembershipProposalBody,
  ListMembershipProposalsQueryParams,
  RequestNodeLeaveBody,
  RequestNodeLeaveResponse,
} from "@workspace/api-zod";
import { DomainError } from "@workspace/opennode-domain";
import { DEFAULT_RETENTION_RULES } from "@workspace/node-lifecycle";
import { MembershipLogError, leaveMessage } from "@workspace/membership-log";
import { metricsRegistry } from "@workspace/observability";
import {
  acceptsNewAssignments,
  getGovernance,
  getFeatureFlags,
  nodeStore,
  type GovernanceRuntime,
} from "../lib/runtime";
import { requestId, actorId } from "../middlewares/correlation";
import { logger } from "../lib/logger";

const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const router: IRouter = Router();

type InternalProposalStatus = "open" | "passed" | "rejected" | "expired" | "invalidated" | "committed";
type ApiProposalStatus = "pending" | "approved" | "rejected" | "committed" | "expired";

function mapStatus(status: InternalProposalStatus): ApiProposalStatus {
  switch (status) {
    case "open":
      return "pending";
    case "passed":
      return "approved";
    case "rejected":
      return "rejected";
    case "expired":
      return "expired";
    case "invalidated":
      return "rejected";
    case "committed":
      return "committed";
  }
}

function proposalResponse(g: GovernanceRuntime, proposalId: string) {
  const snapshot = g.membershipService.getProposal(proposalId);
  const meta = g.proposalMeta.get(proposalId);
  if (meta === undefined) {
    throw new DomainError("PROPOSAL_NOT_FOUND", "Unknown proposal metadata.");
  }
  const ballotsForProposal = g.ballots.get(proposalId);
  let noVotes = 0;
  if (ballotsForProposal) {
    for (const choice of ballotsForProposal.values()) {
      if (choice === "no") noVotes += 1;
    }
  }
  let currentNodeVote: "yes" | "no" | null = null;
  const localBallot = ballotsForProposal?.get(g.localNodeId);
  if (localBallot) currentNodeVote = localBallot;
  return {
    id: snapshot.proposalId,
    kind: snapshot.kind as "admission" | "eviction",
    targetNodeId: snapshot.subjectId,
    targetNodeName: meta.targetNodeName,
    reason: meta.reason,
    status: mapStatus(snapshot.status),
    membershipEpoch: snapshot.epoch,
    eligibleVoterCount: snapshot.denominator,
    requiredYesVotes: snapshot.threshold,
    yesVotes: snapshot.yesVotes,
    noVotes,
    currentNodeVote,
    createdAt: meta.createdAt,
    expiresAt: new Date(snapshot.expiresAt),
  };
}

function handleProposalError(res: Response, err: unknown): void {
  if (err instanceof DomainError) {
    const notFound = err.code === "PROPOSAL_NOT_FOUND";
    const clientError =
      err.code.startsWith("INVALID_") ||
      err.code === "DUPLICATE_RESPONSE" ||
      err.code === "VOLUNTARY_LEAVE_REQUIRES_NO_VOTE";
    res.status(notFound ? 404 : clientError ? 400 : 409).json({
      error: err.message,
      code: err.code,
    });
    return;
  }
  if (err instanceof MembershipLogError) {
    res.status(409).json({ error: err.message, code: err.code });
    return;
  }
  logger.error({ err }, "request failed");
  res.status(500).json({ error: "Internal error", code: "INTERNAL" });
}

async function finalizePassed(g: GovernanceRuntime, proposalId: string, now: number, rid: string): Promise<void> {
  const snapshot = g.membershipService.getProposal(proposalId);
  if (snapshot.status !== "passed") return;
  const decided = g.membershipService.commitDecision({ proposalId, now });
  const newEpoch = g.membershipService.currentMembership().epoch;
  if (snapshot.kind === "admission") {
    await g.membershipLog.commitAdmission({
      proposalId,
      subjectId: snapshot.subjectId,
      newEpoch,
      electorateDenominator: snapshot.denominator,
      threshold: snapshot.threshold,
      yesVotes: snapshot.yesVotes,
      eventId: randomUUID(),
      correlationId: rid,
      now,
    });
  } else if (snapshot.kind === "eviction") {
    await g.membershipLog.commitEviction({
      proposalId,
      subjectId: snapshot.subjectId,
      newEpoch,
      electorateDenominator: snapshot.denominator,
      threshold: snapshot.threshold,
      yesVotes: snapshot.yesVotes,
      eventId: randomUUID(),
      correlationId: rid,
      now,
    });
    await g.lifecycle.handleEviction({ subjectId: snapshot.subjectId, epoch: newEpoch });
  }
  await g.membershipLog.reconcile(now);
  void decided;
}

router.get("/membership/proposals", async (req, res) => {
  const parsed = ListMembershipProposalsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const g = await getGovernance();
    const snapshots = g.membershipService
      .listProposals()
      .filter((s) => s.kind !== "voluntary-leave");
    const items = snapshots
      .map((s) => proposalResponse(g, s.proposalId))
      .filter((item) => (parsed.data.status ? item.status === parsed.data.status : true));
    res.json(items);
  } catch (err) {
    handleProposalError(res, err);
    return;
  }
  void req;
});

router.post("/membership/proposals", async (req, res) => {
  const parsed = CreateMembershipProposalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid proposal", code: parsed.error.issues[0]?.message });
    return;
  }
  const rid = requestId(res);
  try {
    const g = await getGovernance();
    const featureFlags = getFeatureFlags();
    const context = { clusterId: g.clusterIdValue };
    if (parsed.data.kind === "eviction" && !featureFlags.isEvictionEnabled(context)) {
      res.status(409).json({ error: "Eviction is disabled by feature flag", code: "EVICTION_DISABLED" });
      return;
    }
    const now = Date.now();
    const proposalId = `proposal-${randomUUID()}`;
    const expiresAt = now + PROPOSAL_TTL_MS;
    if (parsed.data.kind === "admission") {
      g.membershipService.proposeAdmission({
        proposalId,
        candidateId: parsed.data.targetNodeId,
        expiresAt,
        now,
      });
    } else {
      g.membershipService.proposeEviction({
        proposalId,
        targetId: parsed.data.targetNodeId,
        expiresAt,
        now,
      });
    }
    g.proposalMeta.set(proposalId, {
      reason: parsed.data.reason,
      createdAt: new Date(now),
      targetNodeName: null,
    });
    metricsRegistry.increment("membership_proposals_created_total");
    logger.info({ requestId: rid, proposalId, kind: parsed.data.kind }, "proposal opened");
    res.status(201).json(proposalResponse(g, proposalId));
  } catch (err) {
    handleProposalError(res, err);
  }
});

router.get("/membership/proposals/:proposalId", async (req, res) => {
  try {
    const g = await getGovernance();
    const snapshot = g.membershipService.getProposal(req.params.proposalId);
    if (snapshot.kind === "voluntary-leave") {
      res.status(404).json({ error: "Proposal not found", code: "PROPOSAL_NOT_FOUND" });
      return;
    }
    res.json(proposalResponse(g, req.params.proposalId));
  } catch (err) {
    handleProposalError(res, err);
  }
});

router.post("/membership/proposals/:proposalId/votes", async (req, res) => {
  const parsed = CastMembershipVoteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid vote", code: parsed.error.issues[0]?.message });
    return;
  }
  const rid = requestId(res);
  try {
    const g = await getGovernance();
    const now = Date.now();
    const snapshot = g.membershipService.getProposal(req.params.proposalId);
    const revisionMap = g.ballotRevisions.get(req.params.proposalId) ?? new Map<string, number>();
    const revision = (revisionMap.get(g.localNodeId) ?? 0) + 1;
    const expiresAt = now + PROPOSAL_TTL_MS;
    const canonical = [
      req.params.proposalId,
      g.clusterIdValue,
      g.localNodeId,
      snapshot.epoch,
      parsed.data.choice,
      expiresAt,
      revision,
    ].join("|");
    g.membershipService.castVote(
      {
        proposalId: req.params.proposalId,
        clusterId: g.clusterIdValue,
        voterId: g.localNodeId,
        epoch: snapshot.epoch,
        choice: parsed.data.choice,
        expiresAt,
        revision,
        signature: g.hsmSigner.sign(canonical),
      },
      { now },
    );
    revisionMap.set(g.localNodeId, revision);
    g.ballotRevisions.set(req.params.proposalId, revisionMap);
    const ballotMap = g.ballots.get(req.params.proposalId) ?? new Map<string, "yes" | "no">();
    ballotMap.set(g.localNodeId, parsed.data.choice);
    g.ballots.set(req.params.proposalId, ballotMap);
    metricsRegistry.increment("membership_votes_accepted_total");
    const updated = g.membershipService.getProposal(req.params.proposalId);
    if (updated.status === "passed") {
      await finalizePassed(g, req.params.proposalId, now, rid);
    }
    logger.info({ requestId: rid, proposalId: req.params.proposalId, choice: parsed.data.choice }, "vote accepted");
    res.json(proposalResponse(g, req.params.proposalId));
    void req;
  } catch (err) {
    handleProposalError(res, err);
  }
});

router.post("/membership/proposals/:proposalId/respond", async (req, res) => {
  const response = typeof req.body?.response === "string" ? req.body.response : undefined;
  if (response === undefined || response.trim().length === 0 || response.length > 1000) {
    res.status(400).json({ error: "Invalid response", code: "INVALID_RESPONSE" });
    return;
  }
  const rid = requestId(res);
  try {
    const g = await getGovernance();
    const now = Date.now();
    const epoch = g.membershipService.currentMembership().epoch;
    g.membershipService.submitEvictionResponse({
      proposalId: req.params.proposalId,
      memberId: g.localNodeId,
      epoch,
      response,
      now,
    });
    logger.info({ requestId: rid, proposalId: req.params.proposalId }, "eviction response recorded");
    res.json(proposalResponse(g, req.params.proposalId));
  } catch (err) {
    handleProposalError(res, err);
  }
});

router.post("/membership/leave", async (req, res) => {
  const parsed = RequestNodeLeaveBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid leave request", code: parsed.error.issues[0]?.message });
    return;
  }
  const rid = requestId(res);
  try {
    const g = await getGovernance();
    const featureFlags = getFeatureFlags();
    const context = { clusterId: g.clusterIdValue };
    if (!featureFlags.isLeaveEnabled(context)) {
      res.status(409).json({ error: "Voluntary leave is disabled by feature flag", code: "LEAVE_DISABLED" });
      return;
    }
    const now = Date.now();
    const active = await countActive(g);
    if (g.state.leftLocalNode) {
      res.status(202).json(
        RequestNodeLeaveResponse.parse({
          nodeId: g.localNodeId,
          status: "already_leaving",
          activeRunsToDrain: active,
        }),
      );
      return;
    }
    const previousEpoch = g.membershipService.currentMembership().epoch;
    const newEpoch = previousEpoch + 1;
    const signature = g.scheme.sign(
      new TextEncoder().encode(g.localSecretKey),
      leaveMessage({
        clusterId: g.clusterIdValue,
        subjectId: g.localNodeId,
        previousEpoch,
        newEpoch,
      }),
    );
    await g.lifecycle.handleVoluntaryLeave({
      subjectId: g.localNodeId,
      clusterId: g.clusterIdValue,
      previousEpoch,
      newEpoch,
      signerNodeId: g.signerNodeId,
      signature,
    });
    const proposal = g.membershipService.requestLeave({ memberId: g.localNodeId, now });
    g.membershipService.commitDecision({ proposalId: proposal.proposalId, now });
    await g.membershipLog.commitLeave({
      proposalId: proposal.proposalId,
      memberId: g.localNodeId,
      secretKey: g.localSecretKey,
      signerNodeId: g.signerNodeId,
      scheme: g.scheme,
      eventId: randomUUID(),
      correlationId: rid,
      now,
    });
    await g.membershipLog.reconcile(now);
    g.state.leftLocalNode = true;
    logger.info({ requestId: rid, epoch: newEpoch }, "voluntary leave committed");
    res.status(202).json(
      RequestNodeLeaveResponse.parse({
        nodeId: g.localNodeId,
        status: "leaving",
        activeRunsToDrain: active,
      }),
    );
  } catch (err) {
    handleProposalError(res, err);
  }
});

router.get("/membership/status", async (req, res) => {
  try {
    const g = await getGovernance();
    const committed = await g.membershipLog.getState();
    const counts = { pending: 0, approved: 0, rejected: 0, committed: 0, expired: 0 };
    for (const snapshot of g.membershipService.listProposals()) {
      counts[mapStatus(snapshot.status)] += 1;
    }
    res.json({
      localNodeId: g.localNodeId,
      clusterId: g.clusterIdValue,
      membershipEpoch: committed.epoch,
      memberIds: committed.memberIds,
      acceptingNewWork: g.lifecycle.acceptsNewAssignments(),
      leftLocalNode: g.state.leftLocalNode,
      quarantinedNodeId: null,
      syncStatus: "local_only",
      proposalCounts: counts,
      retentionRules: DEFAULT_RETENTION_RULES,
      acceptsNewAssignments: acceptsNewAssignments(),
    });
  } catch (err) {
    handleProposalError(res, err);
  }
});

async function countActive(g: GovernanceRuntime): Promise<number> {
  const page = await nodeStore.listRuns({ limit: 100 });
  const active = new Set(["queued", "starting", "running", "cancel_requested"]);
  return page.items.filter((run) => active.has(run.status)).length;
}

export default router;
