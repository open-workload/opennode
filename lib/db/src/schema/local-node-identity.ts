import { createInsertSchema } from "drizzle-zod";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
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
);

export const insertLocalNodeIdentitySchema = createInsertSchema(localNodeIdentityTable).omit({ singleton: true });
export type InsertLocalNodeIdentity = z.infer<typeof insertLocalNodeIdentitySchema>;
export type LocalNodeIdentity = typeof localNodeIdentityTable.$inferSelect;
