import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("run_log_entries_run_sequence_unique").on(table.runId, table.sequence),
    index("run_log_entries_run_created_idx").on(table.runId, table.createdAt),
  ],
);

export const insertRunLogEntrySchema = createInsertSchema(runLogEntriesTable).omit({
  createdAt: true,
});
export type InsertRunLogEntry = z.infer<typeof insertRunLogEntrySchema>;
export type RunLogEntry = typeof runLogEntriesTable.$inferSelect;
