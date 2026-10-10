/**
 * Feature-flag overrides and the global kill switch, behind the app.ts guards.
 *
 *   GET  /flags ─▶ requireRoleFor(getFeatureFlags) (viewer) ─▶ getAllFlags ─▶ { flags }
 *   POST /flags ─▶ requireRoleFor(updateFeatureFlags) (admin) ─▶ zod body ─▶
 *                  applyOverrides ─▶ getAllFlags ─▶ { flags }
 *        bad body ─▶ 400      FeatureFlagsError ─▶ 400 with its code
 *
 *   POST /flags/kill-switch/activate ─▶ requireRoleFor(activateKillSwitch) (admin)
 *        ─▶ zod { reason, activatedBy } ─▶ activateKillSwitch ─▶ audit row
 *           (actor, reason, activatedBy, timestamp, committed logHeight) ─▶ 200
 *   POST /flags/kill-switch/deactivate ─▶ requireRoleFor(deactivateKillSwitch) (admin)
 *        ─▶ optional { reason } ─▶ deactivateKillSwitch ─▶ audit row (actor, reason,
 *           timestamp, committed logHeight) ─▶ 200
 *
 *   each mutation: increment the matching counter, 409 on FeatureFlagsError, else 500.
 *   Denials happen in requireRoleFor before any flag state is read (403 FORBIDDEN).
 */

import { Router, type IRouter, type Response } from "express";
import { z } from "zod";
import { type FlagValue } from "@workspace/feature-flags";
import { metricsRegistry } from "@workspace/observability";
import { requestId, actorId } from "../middlewares/correlation";
import { requireRoleFor } from "../middlewares/requireRole";
import type { AuthenticatedRequest } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { featureFlags, getGovernance, nodeStore } from "../lib/runtime";

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

const KillSwitchDeactivateBody = z.object({
  reason: z.string().min(1).max(1000).optional(),
});

const KillSwitchResponse = z.object({
  state: z.object({
    enabled: z.boolean(),
    reason: z.string(),
    activatedAt: z.string(),
    activatedBy: z.string(),
  }),
});

function actorOf(req: AuthenticatedRequest): string {
  return req.auth?.actorId ?? "unauthenticated";
}

/**
 * OPS-12: every kill-switch transition writes an immutable audit row carrying
 * the verified actor, the reason, the timestamp, and the committed log height.
 */
async function recordKillSwitchAudit(
  action: "kill_switch.activated" | "kill_switch.deactivated",
  req: AuthenticatedRequest,
  res: Response,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const logHeight = await (await getGovernance()).eventLog.getHeight();
  await nodeStore.recordAudit({
    action,
    actorNodeId: actorOf(req),
    requestId: requestId(res),
    detail: {
      actor: actorOf(req),
      reason,
      ...extra,
      timestamp: new Date().toISOString(),
      logHeight,
    },
  });
}

router.get("/flags", requireRoleFor("getFeatureFlags"), (_req, res) => {
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

router.post("/flags", requireRoleFor("updateFeatureFlags"), async (req, res) => {
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

router.post("/flags/kill-switch/activate", requireRoleFor("activateKillSwitch"), async (req, res) => {
  const rid = requestId(res);
  const parsed = KillSwitchActivateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid kill switch activation", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const state = featureFlags.activateKillSwitch(parsed.data.reason, parsed.data.activatedBy);
    await recordKillSwitchAudit("kill_switch.activated", req as AuthenticatedRequest, res, parsed.data.reason, {
      activatedBy: parsed.data.activatedBy,
    });
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

router.post("/flags/kill-switch/deactivate", requireRoleFor("deactivateKillSwitch"), async (req, res) => {
  const rid = requestId(res);
  const parsed = KillSwitchDeactivateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid kill switch deactivation", code: parsed.error.issues[0]?.message });
    return;
  }
  try {
    const reason = parsed.data.reason ?? "kill switch deactivated";
    const state = featureFlags.deactivateKillSwitch();
    await recordKillSwitchAudit("kill_switch.deactivated", req as AuthenticatedRequest, res, reason);
    metricsRegistry.increment("feature_flag_kill_switch_deactivations_total");
    res.json(KillSwitchResponse.parse({ state }));
    logger.info({ requestId: rid, reason }, "kill switch deactivated");
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