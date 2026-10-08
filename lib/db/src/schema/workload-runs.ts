import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { runExecutionModeEnum, runModeEnum, runStatusEnum } from "./enums";

type ResourceLimits = {
  cpuMilli: number;
  memoryMiB: number;
  diskMiB: number;
  timeoutSeconds: number;
};

export const workloadRunsTable = pgTable(
  "workload_runs",
  {
    id: text("id").primaryKey(),
    clientRequestId: text("client_request_id").notNull(),
    name: text("name").notNull(),
    mode: runModeEnum("mode").notNull(),
    image: text("image"),
    imageDigest: text("image_digest"),
    command: jsonb("command").$type<string[]>().notNull(),
    status: runStatusEnum("status").notNull(),
    executionMode: runExecutionModeEnum("execution_mode").notNull(),
    submittedBy: text("submitted_by").notNull(),
    submittedViaNodeId: text("submitted_via_node_id").notNull(),
    workerNodeId: text("worker_node_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    resources: jsonb("resources").$type<ResourceLimits>().notNull(),
    networkPolicy: text("network_policy", { enum: ["deny_all", "allowlist"] }).notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("workload_runs_client_request_unique").on(table.clientRequestId),
    index("workload_runs_status_created_idx").on(table.status, table.createdAt),
    index("workload_runs_created_idx").on(table.createdAt),
    index("workload_runs_submitted_via_created_idx").on(table.submittedViaNodeId, table.createdAt),
    index("workload_runs_worker_status_idx").on(table.workerNodeId, table.status),
  ],
);

export const insertWorkloadRunSchema = createInsertSchema(workloadRunsTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertWorkloadRun = z.infer<typeof insertWorkloadRunSchema>;
export type WorkloadRun = typeof workloadRunsTable.$inferSelect;
