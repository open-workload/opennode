import { createInsertSchema } from "drizzle-zod";
import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { workloadRunsTable } from "./workload-runs";
import { workloadRunAttemptsTable } from "./attempts";

export const auditEventsTable = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    action: text("action").notNull(),
    actorNodeId: text("actor_node_id"),
    runId: text("run_id")
      .references(() => workloadRunsTable.id, { onDelete: "set null" }),
    attemptId: text("attempt_id")
      .references(() => workloadRunAttemptsTable.id, { onDelete: "set null" }),
    requestId: text("request_id").notNull().default(""),
    idempotencyKey: text("idempotency_key"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    checksum: text("checksum").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_created_idx").on(table.createdAt),
    index("audit_events_run_idx").on(table.runId),
    index("audit_events_attempt_idx").on(table.attemptId),
    index("audit_events_request_idx").on(table.requestId),
    index("audit_events_idempotency_idx").on(table.idempotencyKey),
    check("audit_events_action_not_empty", sql`length(trim(${table.action})) > 0`),
    check("audit_events_checksum_not_empty", sql`length(trim(${table.checksum})) > 0`),
  ],
);

export const insertAuditEventSchema = createInsertSchema(auditEventsTable).omit({
  createdAt: true,
});
export type InsertAuditEvent = z.infer<typeof insertAuditEventSchema>;
export type AuditEvent = typeof auditEventsTable.$inferSelect;
