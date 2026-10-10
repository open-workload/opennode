import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { type FlagValue } from "@workspace/feature-flags";
import { metricsRegistry } from "@workspace/observability";
import { requestId, actorId } from "../middlewares/correlation";
import { logger } from "../lib/logger";
import { featureFlags } from "../lib/runtime";

const router: IRouter = Router();

const flagValueSchema = z.union([z.boolean(), z.number(), z.string(), z.record(z.unknown())]);

const FeatureFlagsBody = z.object({
  flags: z.record(z.string(), flagValueSchema).optional(),
});

const FeatureFlagsResponse = z.object({
  flags: z.record(z.string(), flagValueSchema),
});

const KillSwitchActivateBody = z.object({
  reason: z.string().min(1).max(1000),
  activatedBy: z.string().min(1).max(128),
});

const KillSwitchResponse = z.object({
  state: z.object({
    enabled: z.boolean(),
    reason: z.string(),
    activatedAt: z.string(),
    activatedBy: z.string(),
  }),
});

router.get("/flags", (_req, res) => {
  const rid = requestId(res);
  try {
    const context = { clusterId: process.env.OPENNODE_CLUSTER_ID ?? "local-cluster" };
    const flags = featureFlags.getAllFlags(context);
    res.json(FeatureFlagsResponse.parse({ flags }));
    logger.debug({ requestId: rid }, "flags retrieved");
  } catch (err) {
    logger.error({ err, requestId: rid }, "failed to retrieve flags");
    res.status(500).json({ error: "Internal error", code: "INTERNAL" });
  }
});

router.post("/flags", async (req, res) => {
  const rid = requestId(res);
  const parsed = FeatureFlagsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid flag overrides", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    featureFlags.applyOverrides((parsed.data.flags ?? {}) as Record<string, FlagValue>);
    const context = { clusterId: process.env.OPENNODE_CLUSTER_ID ?? "local-cluster" };
    const flags = featureFlags.getAllFlags(context);
    res.json(FeatureFlagsResponse.parse({ flags }));
    logger.info({ requestId: rid, overrides: Object.keys(parsed.data.flags ?? {}) }, "flags updated");
  } catch (err) {
    if (err instanceof Error && err.name === "FeatureFlagsError") {
      res.status(400).json({ error: err.message, code: (err as any).code });
      return;
    }
    logger.error({ err, requestId: rid }, "failed to update flags");
    res.status(500).json({ error: "Internal error", code: "INTERNAL" });
  }
});

router.post("/flags/kill-switch/activate", async (req, res) => {
  const rid = requestId(res);
  const parsed = KillSwitchActivateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid kill switch activation", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const state = featureFlags.activateKillSwitch(parsed.data.reason, parsed.data.activatedBy);
    metricsRegistry.increment("feature_flag_kill_switch_activations_total");
    res.json(KillSwitchResponse.parse({ state }));
    logger.warn({ requestId: rid, reason: parsed.data.reason, activatedBy: parsed.data.activatedBy }, "kill switch activated");
  } catch (err) {
    if (err instanceof Error && err.name === "FeatureFlagsError") {
      res.status(409).json({ error: err.message, code: (err as any).code });
      return;
    }
    logger.error({ err, requestId: rid }, "failed to activate kill switch");
    res.status(500).json({ error: "Internal error", code: "INTERNAL" });
  }
});

router.post("/flags/kill-switch/deactivate", async (_req, res) => {
  const rid = requestId(res);
  try {
    const state = featureFlags.deactivateKillSwitch();
    metricsRegistry.increment("feature_flag_kill_switch_deactivations_total");
    res.json(KillSwitchResponse.parse({ state }));
    logger.info({ requestId: rid }, "kill switch deactivated");
  } catch (err) {
    if (err instanceof Error && err.name === "FeatureFlagsError") {
      res.status(409).json({ error: err.message, code: (err as any).code });
      return;
    }
    logger.error({ err, requestId: rid }, "failed to deactivate kill switch");
    res.status(500).json({ error: "Internal error", code: "INTERNAL" });
  }
});

export default router;