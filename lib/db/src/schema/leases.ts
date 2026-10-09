import { createInsertSchema } from "drizzle-zod";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { workloadRunsTable } from "./workload-runs";
import { workloadRunAttemptsTable } from "./attempts";

export const leasesTable = pgTable(
  "leases",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workloadRunsTable.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => workloadRunAttemptsTable.id, { onDelete: "cascade" }),
    workerNodeId: text("worker_node_id").notNull(),
    holderNodeId: text("holder_node_id").notNull(),
    sequence: integer("sequence").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    checksum: text("checksum").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("leases_run_attempt_unique").on(table.runId, table.attemptId),
    index("leases_worker_expires_idx").on(table.workerNodeId, table.expiresAt),
    index("leases_holder_expires_idx").on(table.holderNodeId, table.expiresAt),
    check("leases_sequence_positive", sql`${table.sequence} > 0`),
    check("leases_worker_not_empty", sql`length(trim(${table.workerNodeId})) > 0`),
    check("leases_holder_not_empty", sql`length(trim(${table.holderNodeId})) > 0`),
    check("leases_attempt_id_not_empty", sql`length(trim(${table.attemptId})) > 0`),
    check("leases_checksum_not_empty", sql`length(trim(${table.checksum})) > 0`),
    check("leases_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const insertLeaseSchema = createInsertSchema(leasesTable).omit({
  createdAt: true,
});
export type InsertLease = z.infer<typeof insertLeaseSchema>;
export type Lease = typeof leasesTable.$inferSelect;