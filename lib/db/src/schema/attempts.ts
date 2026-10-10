/**
 * One retry attempt of a workload run; child of workload_runs, cascades on delete.
 *
 *   workload_run_attempts ──▶ run_id ──▶ workload_runs.id (ON DELETE CASCADE)
 *        │        │
 *        │        └──▶ unique (run_id, attempt); attempt > 0
 *        ├──▶ provider_run_id unique + non-empty; checksum non-empty
 *        ├──▶ status: run_status enum from ./enums; worker_node_id, request_id
 *        └──▶ finished_at IS NULL OR finished_at >= started_at
 *   table ──▶ createInsertSchema ──▶ InsertWorkloadRunAttempt / WorkloadRunAttempt
 */
import { createInsertSchema } from "drizzle-zod";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { runStatusEnum } from "./enums";
import { workloadRunsTable } from "./workload-runs";

export const workloadRunAttemptsTable = pgTable(
  "workload_run_attempts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workloadRunsTable.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    providerRunId: text("provider_run_id").notNull().unique(),
    status: runStatusEnum("status").notNull(),
    workerNodeId: text("worker_node_id"),
    requestId: text("request_id").notNull().default(""),
    errorReason: text("error_reason"),
    checksum: text("checksum").notNull().default(""),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("workload_run_attempts_run_attempt_unique").on(table.runId, table.attempt),
    index("workload_run_attempts_run_idx").on(table.runId),
    index("workload_run_attempts_status_idx").on(table.status),
    check("workload_run_attempts_attempt_positive", sql`${table.attempt} > 0`),
    check("workload_run_attempts_provider_run_id_not_empty", sql`length(trim(${table.providerRunId})) > 0`),
    check("workload_run_attempts_checksum_not_empty", sql`length(trim(${table.checksum})) > 0`),
    check("workload_run_attempts_finished_after_started", sql`${table.finishedAt} IS NULL OR ${table.finishedAt} >= ${table.startedAt}`),
  ],
);

export const insertWorkloadRunAttemptSchema = createInsertSchema(workloadRunAttemptsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkloadRunAttempt = z.infer<typeof insertWorkloadRunAttemptSchema>;
export type WorkloadRunAttempt = typeof workloadRunAttemptsTable.$inferSelect;
