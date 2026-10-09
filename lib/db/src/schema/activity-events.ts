import { createInsertSchema } from "drizzle-zod";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { activityEventKindEnum } from "./enums";

export const activityEventsTable = pgTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    kind: activityEventKindEnum("kind").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorNodeId: text("actor_node_id"),
  },
  (table) => [
    index("activity_events_created_idx").on(table.createdAt),
    index("activity_events_kind_created_idx").on(table.kind, table.createdAt),
    index("activity_events_actor_created_idx").on(table.actorNodeId, table.createdAt),
    check("activity_events_message_not_empty", sql`length(trim(${table.message})) > 0`),
  ],
);

export const insertActivityEventSchema = createInsertSchema(activityEventsTable).omit({
  createdAt: true,
});
export type InsertActivityEvent = z.infer<typeof insertActivityEventSchema>;
export type ActivityEvent = typeof activityEventsTable.$inferSelect;
