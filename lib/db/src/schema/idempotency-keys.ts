import { createInsertSchema } from "drizzle-zod";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { workloadRunsTable } from "./workload-runs";

export const idempotencyKeysTable = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    clientRequestId: text("client_request_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => workloadRunsTable.id, { onDelete: "cascade" }),
    payloadHash: text("payload_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_actor_client_unique").on(table.actorId, table.clientRequestId),
    index("idempotency_keys_expires_idx").on(table.expiresAt),
    index("idempotency_keys_run_idx").on(table.runId),
    check("idempotency_keys_actor_not_empty", sql`length(trim(${table.actorId})) > 0`),
    check("idempotency_keys_client_not_empty", sql`length(trim(${table.clientRequestId})) > 0`),
    check("idempotency_keys_payload_hash_not_empty", sql`length(trim(${table.payloadHash})) > 0`),
    check("idempotency_keys_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const insertIdempotencyKeySchema = createInsertSchema(idempotencyKeysTable).omit({
  createdAt: true,
});
export type InsertIdempotencyKey = z.infer<typeof insertIdempotencyKeySchema>;
export type IdempotencyKey = typeof idempotencyKeysTable.$inferSelect;