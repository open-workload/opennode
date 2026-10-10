/**
 * Liveness view of a peer, keyed by node_id and scoped to a cluster.
 *
 *   peer_status ──▶ node_id (PK), cluster_id, address, capabilities[], metadata
 *        │      └──▶ status: node_status enum; membership_epoch >= 0
 *        │      └──▶ last_seen_at / last_heartbeat_at drive staleness decisions
 *        └──▶ partial unique index: at most one row with is_local = true
 *   table ──▶ createInsertSchema ──▶ InsertPeerStatus / PeerStatus
 */
import { createInsertSchema } from "drizzle-zod";
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { nodeStatusEnum } from "./enums";

export const peerStatusTable = pgTable(
  "peer_status",
  {
    nodeId: text("node_id").primaryKey(),
    clusterId: text("cluster_id").notNull(),
    status: nodeStatusEnum("status").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    protocolVersion: text("protocol_version").notNull(),
    membershipEpoch: integer("membership_epoch").notNull(),
    isLocal: boolean("is_local").notNull().default(false),
    capabilities: text("capabilities").array().notNull().default([]),
    address: text("address"),
    metadata: text("metadata").notNull().default("{}"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("peer_status_cluster_idx").on(table.clusterId),
    index("peer_status_status_idx").on(table.status),
    index("peer_status_epoch_idx").on(table.membershipEpoch),
    uniqueIndex("peer_status_one_local_idx")
      .on(table.isLocal)
      .where(sql`${table.isLocal} = true`),
    check("peer_status_node_id_not_empty", sql`length(trim(${table.nodeId})) > 0`),
    check("peer_status_cluster_id_not_empty", sql`length(trim(${table.clusterId})) > 0`),
    check("peer_status_protocol_version_not_empty", sql`length(trim(${table.protocolVersion})) > 0`),
    check("peer_status_membership_epoch_nonneg", sql`${table.membershipEpoch} >= 0`),
  ],
);

export const insertPeerStatusSchema = createInsertSchema(peerStatusTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertPeerStatus = z.infer<typeof insertPeerStatusSchema>;
export type PeerStatus = typeof peerStatusTable.$inferSelect;