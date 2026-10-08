import { createInsertSchema } from "drizzle-zod";
import { boolean, check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { consensusStatusEnum, syncStatusEnum } from "./enums";

export const clusterMetadataTable = pgTable(
  "cluster_metadata",
  {
    singleton: boolean("singleton").primaryKey().notNull().default(true),
    clusterId: text("cluster_id").notNull(),
    membershipEpoch: integer("membership_epoch").notNull(),
    syncStatus: syncStatusEnum("sync_status").notNull(),
    consensusStatus: consensusStatusEnum("consensus_status").notNull(),
  },
  (table) => [check("cluster_metadata_singleton_true", sql`${table.singleton}`)],
);

export const insertClusterMetadataSchema = createInsertSchema(clusterMetadataTable);
export type InsertClusterMetadata = z.infer<typeof insertClusterMetadataSchema>;
export type ClusterMetadata = typeof clusterMetadataTable.$inferSelect;
