import { createInsertSchema } from "drizzle-zod";
import { index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { membershipProposalsTable } from "./membership-proposals";
import { voteChoiceEnum } from "./enums";

export const membershipVotesTable = pgTable(
  "membership_votes",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id")
      .notNull()
      .references(() => membershipProposalsTable.id, { onDelete: "cascade" }),
    voterNodeId: text("voter_node_id").notNull(),
    choice: voteChoiceEnum("choice").notNull(),
    membershipEpoch: integer("membership_epoch").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("membership_votes_proposal_voter_unique").on(table.proposalId, table.voterNodeId),
    index("membership_votes_voter_created_idx").on(table.voterNodeId, table.createdAt),
  ],
);

export const insertMembershipVoteSchema = createInsertSchema(membershipVotesTable).omit({
  createdAt: true,
});
export type InsertMembershipVote = z.infer<typeof insertMembershipVoteSchema>;
export type MembershipVote = typeof membershipVotesTable.$inferSelect;
