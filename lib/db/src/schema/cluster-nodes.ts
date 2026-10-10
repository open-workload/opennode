/**
 * Known cluster members, one row per node.
 *
 *   cluster_nodes ──▶ id, name, public_key (unique), address, is_local
 *        │       └──▶ status: node_status, role: node_role (from ./enums)
 *        │       └──▶ membership_epoch >= 0, protocol_version non-empty
 *        │       └──▶ can_execute: whether this node may be given runs
 *        └──▶ partial unique index: at most one row with is_local = true
 *   table ──▶ createInsertSchema ──▶ InsertClusterNode / ClusterNode
 */
import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { nodeRoleEnum, nodeStatusEnum } from "./enums";

/**
 * Per-node view of known members. Public keys are public identity material;
 * private keys must never be stored in this table or in the application DB.
 */
export const clusterNodesTable = pgTable(
  "cluster_nodes",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    publicKey: text("public_key").unique(),
    status: nodeStatusEnum("status").notNull(),
    role: nodeRoleEnum("role").notNull(),
    protocolVersion: text("protocol_version").notNull(),
    membershipEpoch: integer("membership_epoch").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    address: text("address"),
    canExecute: boolean("can_execute").notNull(),
    isLocal: boolean("is_local").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("cluster_nodes_status_idx").on(table.status),
    index("cluster_nodes_epoch_idx").on(table.membershipEpoch),
    index("cluster_nodes_public_key_idx").on(table.publicKey),
    uniqueIndex("cluster_nodes_one_local_idx")
      .on(table.isLocal)
      .where(sql`${table.isLocal} = true`),
    check("cluster_nodes_id_not_empty", sql`length(trim(${table.id})) > 0`),
    check("cluster_nodes_name_not_empty", sql`length(trim(${table.name})) > 0`),
    check("cluster_nodes_protocol_version_not_empty", sql`length(trim(${table.protocolVersion})) > 0`),
    check("cluster_nodes_membership_epoch_nonneg", sql`${table.membershipEpoch} >= 0`),
    check("cluster_nodes_public_key_not_empty", sql`${table.publicKey} IS NULL OR length(trim(${table.publicKey})) > 0`),
  ],
);

export const insertClusterNodeSchema = createInsertSchema(clusterNodesTable).omit({
  updatedAt: true,
});
export type InsertClusterNode = z.infer<typeof insertClusterNodeSchema>;
export type ClusterNode = typeof clusterNodesTable.$inferSelect;
