import { createInsertSchema } from "drizzle-zod";
import { boolean, check, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { clusterNodesTable } from "./cluster-nodes";

export const localNodeIdentityTable = pgTable(
  "local_node_identity",
  {
    singleton: boolean("singleton").primaryKey().notNull().default(true),
    nodeId: text("node_id")
      .notNull()
      .unique()
      .references(() => clusterNodesTable.id, { onDelete: "restrict" }),
  },
  (table) => [
    check("local_node_identity_node_id_not_empty", sql`length(trim(${table.nodeId})) > 0`),
  ],
);

export const insertLocalNodeIdentitySchema = createInsertSchema(localNodeIdentityTable).omit({ singleton: true });
export type InsertLocalNodeIdentity = z.infer<typeof insertLocalNodeIdentitySchema>;
export type LocalNodeIdentity = typeof localNodeIdentityTable.$inferSelect;
