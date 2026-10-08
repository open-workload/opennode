import { pgEnum } from "drizzle-orm/pg-core";

export const nodeStatusEnum = pgEnum("node_status", [
  "local",
  "connected",
  "offline",
  "leaving",
  "quarantined",
]);
export const nodeRoleEnum = pgEnum("node_role", ["validator", "worker", "observer"]);
export const syncStatusEnum = pgEnum("sync_status", ["synced", "syncing", "degraded", "local_only"]);
export const consensusStatusEnum = pgEnum("consensus_status", [
  "healthy",
  "no_quorum",
  "initializing",
  "local_only",
]);

export const proposalKindEnum = pgEnum("proposal_kind", ["admission", "eviction"]);
export const proposalStatusEnum = pgEnum("proposal_status", [
  "pending",
  "approved",
  "rejected",
  "committed",
  "expired",
]);
export const voteChoiceEnum = pgEnum("vote_choice", ["yes", "no"]);

export const runModeEnum = pgEnum("run_mode", ["diagnostic", "container"]);
export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "starting",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "infrastructure_error",
  "blocked",
]);
export const runExecutionModeEnum = pgEnum("run_execution_mode", [
  "built_in_diagnostic",
  "isolated_worker",
  "unavailable",
]);
export const logStreamEnum = pgEnum("log_stream", ["stdout", "stderr", "system"]);

export const activityEventKindEnum = pgEnum("activity_event_kind", [
  "node_joined",
  "node_left",
  "proposal_created",
  "proposal_committed",
  "run_submitted",
  "run_finished",
  "sync_state_changed",
]);
