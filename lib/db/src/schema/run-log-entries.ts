import { createInsertSchema } from "drizzle-zod";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { logStreamEnum } from "./enums";
import { workloadRunsTable } from "./workload-runs";

export const runLogEntriesTable = pgTable(
  "run_log_entries",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workloadRunsTable.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    attempt: integer("attempt").notNull(),
    stream: logStreamEnum("stream").notNull(),
    message: text("message").notNull(),
    checksum: text("checksum").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("run_log_entries_run_sequence_unique").on(table.runId, table.sequence),
    index("run_log_entries_run_created_idx").on(table.runId, table.createdAt),
    index("run_log_entries_run_attempt_idx").on(table.runId, table.attempt),
    check("run_log_entries_sequence_positive", sql`${table.sequence} > 0`),
    check("run_log_entries_attempt_positive", sql`${table.attempt} > 0`),
    check("run_log_entries_message_not_empty", sql`length(trim(${table.message})) > 0`),
    check("run_log_entries_checksum_not_empty", sql`length(trim(${table.checksum})) > 0`),
  ],
);

export const insertRunLogEntrySchema = createInsertSchema(runLogEntriesTable).omit({
  createdAt: true,
});
export type InsertRunLogEntry = z.infer<typeof insertRunLogEntrySchema>;
export type RunLogEntry = typeof runLogEntriesTable.$inferSelect;
