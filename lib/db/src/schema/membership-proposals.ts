import { createInsertSchema } from "drizzle-zod";
import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { proposalKindEnum, proposalStatusEnum } from "./enums";

export const membershipProposalsTable = pgTable(
  "membership_proposals",
  {
    id: text("id").primaryKey(),
    kind: proposalKindEnum("kind").notNull(),
    targetNodeId: text("target_node_id").notNull(),
    targetNodeName: text("target_node_name"),
    reason: text("reason").notNull(),
    status: proposalStatusEnum("status").notNull(),
    membershipEpoch: integer("membership_epoch").notNull(),
    eligibleVoterCount: integer("eligible_voter_count").notNull(),
    requiredYesVotes: integer("required_yes_votes").notNull(),
    eligibleVoterNodeIds: jsonb("eligible_voter_node_ids").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("membership_proposals_status_created_idx").on(table.status, table.createdAt),
    index("membership_proposals_created_idx").on(table.createdAt),
    index("membership_proposals_target_node_idx").on(table.targetNodeId),
    index("membership_proposals_epoch_idx").on(table.membershipEpoch),
    check("membership_proposals_reason_not_empty", sql`length(trim(${table.reason})) > 0`),
    check("membership_proposals_target_not_empty", sql`length(trim(${table.targetNodeId})) > 0`),
    check("membership_proposals_voter_count_positive", sql`${table.eligibleVoterCount} > 0`),
    check("membership_proposals_required_yes_positive", sql`${table.requiredYesVotes} > 0`),
    check("membership_proposals_required_yes_le_voters", sql`${table.requiredYesVotes} <= ${table.eligibleVoterCount}`),
    check("membership_proposals_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const insertMembershipProposalSchema = createInsertSchema(membershipProposalsTable).omit({
  createdAt: true,
});
export type InsertMembershipProposal = z.infer<typeof insertMembershipProposalSchema>;
export type MembershipProposal = typeof membershipProposalsTable.$inferSelect;
