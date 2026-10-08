import { createInsertSchema } from "drizzle-zod";
import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
  ],
);

export const insertMembershipProposalSchema = createInsertSchema(membershipProposalsTable).omit({
  createdAt: true,
});
export type InsertMembershipProposal = z.infer<typeof insertMembershipProposalSchema>;
export type MembershipProposal = typeof membershipProposalsTable.$inferSelect;
