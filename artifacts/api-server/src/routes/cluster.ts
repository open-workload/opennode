import { Router, type IRouter, type Response } from "express";
import {
  GetDashboardSummaryResponse,
  ListActivityQueryParams,
  ListActivityResponse,
  ListNodesResponse,
} from "@workspace/api-zod";
import { getGovernance, nodeStore } from "../lib/runtime";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function handleError(res: Response, err: unknown): void {
  logger.error({ err }, "request failed");
  res.status(500).json({ error: "Internal error", code: "INTERNAL" });
}

router.get("/nodes", async (_req, res) => {
  try {
    const nodes = await nodeStore.listNodes();
    const items = nodes.map((node) => ({
      id: node.id,
      name: node.name,
      status: node.status,
      role: node.role,
      protocolVersion: node.protocolVersion,
      membershipEpoch: node.membershipEpoch,
      lastSeenAt: node.lastSeenAt,
      address: node.address,
      canExecute: node.canExecute,
      isLocal: node.isLocal,
    }));
    res.json(ListNodesResponse.parse(items));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/activity", async (req, res) => {
  const parsed = ListActivityQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const items = await nodeStore.listActivity(parsed.data.limit);
    res.json(ListActivityResponse.parse(items));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/dashboard/summary", async (_req, res) => {
  try {
    const [metadata, nodes, statusCounts, pendingProposalCount, localNodeId, runPage, recentActivity] =
      await Promise.all([
        nodeStore.getClusterMetadata(),
        nodeStore.listNodes(),
        nodeStore.countRunsByStatus(),
        nodeStore.countPendingProposals(),
        nodeStore.getLocalNodeId(),
        nodeStore.listRuns({ limit: 5 }),
        nodeStore.listActivity(5),
      ]);

    const clusterId = metadata?.clusterId ?? (await getGovernance()).clusterIdValue;
    const connectedCount = nodes.filter((node) => node.status === "connected").length;

    res.json(
      GetDashboardSummaryResponse.parse({
        cluster: {
          clusterId,
          membershipEpoch: metadata?.membershipEpoch ?? 0,
          memberCount: nodes.length,
          connectedCount,
          pendingProposalCount,
          syncStatus: metadata?.syncStatus ?? "local_only",
          consensusStatus: metadata?.consensusStatus ?? "local_only",
          localNodeId,
        },
        runCounts: {
          queued: statusCounts["queued"] ?? 0,
          running: (statusCounts["running"] ?? 0) + (statusCounts["starting"] ?? 0),
          succeeded: statusCounts["succeeded"] ?? 0,
          failed: (statusCounts["failed"] ?? 0) + (statusCounts["timed_out"] ?? 0) + (statusCounts["infrastructure_error"] ?? 0),
        },
        recentRuns: runPage.items,
        recentActivity,
      }),
    );
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
