import { DomainError } from "./errors";

export type VoteChoice = "yes" | "no";

export interface GovernanceVote {
  readonly voterId: string;
  readonly choice: VoteChoice;
}

interface ProposalBase {
  readonly proposalId: string;
  readonly epoch: number;
}

export interface AdmissionProposal extends ProposalBase {
  readonly kind: "admission";
  /** The membership snapshot at proposal creation; offline members remain included. */
  readonly electorate: readonly string[];
  readonly candidateId: string;
  readonly votes: readonly GovernanceVote[];
  readonly status: "open" | "passed";
}

export interface EvictionProposal extends ProposalBase {
  readonly kind: "eviction";
  /** Includes the target; the target is excluded only from casting a ballot. */
  readonly electorate: readonly string[];
  readonly targetId: string;
  readonly votes: readonly GovernanceVote[];
  readonly response?: string;
  readonly status: "open" | "passed";
}

export interface VoluntaryLeaveProposal extends ProposalBase {
  readonly kind: "voluntary-leave";
  readonly memberId: string;
  readonly votes: readonly [];
  readonly status: "passed";
}

export type GovernanceProposal =
  | AdmissionProposal
  | EvictionProposal
  | VoluntaryLeaveProposal;

export interface CreateAdmissionProposalInput extends ProposalBase {
  readonly electorate: readonly string[];
  readonly candidateId: string;
}

export interface CreateEvictionProposalInput extends ProposalBase {
  readonly electorate: readonly string[];
  readonly targetId: string;
}

export interface CreateVoluntaryLeaveProposalInput extends ProposalBase {
  readonly memberId: string;
}

export interface CastVoteInput {
  readonly voterId: string;
  readonly epoch: number;
  readonly choice: VoteChoice;
}

export interface SubmitEvictionResponseInput {
  readonly memberId: string;
  readonly epoch: number;
  readonly response: string;
}

export function admissionThreshold(electorateSize: number): number {
  assertElectorateSize(electorateSize);
  return electorateSize === 1
    ? 1
    : Math.max(2, Math.ceil(0.2 * electorateSize));
}

export function evictionThreshold(electorateSize: number): number {
  assertElectorateSize(electorateSize);
  return Math.ceil(0.5 * electorateSize);
}

export function createAdmissionProposal(
  input: CreateAdmissionProposalInput,
): AdmissionProposal {
  validateBase(input);
  const electorate = freezeElectorate(input.electorate);
  validateIdentifier(input.candidateId, "candidateId");
  if (electorate.includes(input.candidateId)) {
    throw new DomainError(
      "INVALID_PROPOSAL",
      "An admission candidate cannot already be in the frozen electorate.",
    );
  }
  return Object.freeze({
    kind: "admission",
    proposalId: input.proposalId,
    epoch: input.epoch,
    electorate,
    candidateId: input.candidateId,
    votes: Object.freeze([]),
    status: "open",
  });
}

export function createEvictionProposal(
  input: CreateEvictionProposalInput,
): EvictionProposal {
  validateBase(input);
  const electorate = freezeElectorate(input.electorate);
  validateIdentifier(input.targetId, "targetId");
  if (!electorate.includes(input.targetId)) {
    throw new DomainError(
      "INVALID_PROPOSAL",
      "The eviction target must be in the frozen electorate.",
    );
  }
  return Object.freeze({
    kind: "eviction",
    proposalId: input.proposalId,
    epoch: input.epoch,
    electorate,
    targetId: input.targetId,
    votes: Object.freeze([]),
    status: "open",
  });
}

export function createVoluntaryLeaveProposal(
  input: CreateVoluntaryLeaveProposalInput,
): VoluntaryLeaveProposal {
  validateBase(input);
  validateIdentifier(input.memberId, "memberId");
  return Object.freeze({
    kind: "voluntary-leave",
    proposalId: input.proposalId,
    epoch: input.epoch,
    memberId: input.memberId,
    votes: Object.freeze([]) as readonly [],
    status: "passed",
  });
}

export function castGovernanceVote(
  proposal: AdmissionProposal | EvictionProposal,
  input: CastVoteInput,
): AdmissionProposal | EvictionProposal {
  validateEpoch(input.epoch);
  if (input.epoch !== proposal.epoch) {
    throw new DomainError(
      "INVALID_EPOCH",
      `Vote epoch ${input.epoch} does not match proposal epoch ${proposal.epoch}.`,
    );
  }
  validateIdentifier(input.voterId, "voterId");
  if (input.choice !== "yes" && input.choice !== "no") {
    throw new DomainError("INVALID_PROPOSAL", "Vote choice must be yes or no.");
  }
  if (proposal.status === "passed") {
    throw new DomainError("INVALID_PROPOSAL", "A passed proposal is closed.");
  }
  if (proposal.kind === "admission" && input.voterId === proposal.candidateId) {
    throw new DomainError(
      "CANDIDATE_CANNOT_VOTE",
      "The admission candidate cannot vote on their own proposal.",
    );
  }
  if (proposal.kind === "eviction" && input.voterId === proposal.targetId) {
    throw new DomainError(
      "TARGET_CANNOT_VOTE",
      "The eviction target may respond but cannot cast a ballot.",
    );
  }
  if (!proposal.electorate.includes(input.voterId)) {
    throw new DomainError(
      "UNAUTHORIZED_VOTER",
      "Voter is not in the frozen proposal electorate.",
    );
  }
  if (proposal.votes.some((vote) => vote.voterId === input.voterId)) {
    throw new DomainError(
      "DUPLICATE_VOTE",
      "A voter may cast only one ballot on a proposal.",
    );
  }

  const votes = Object.freeze([
    ...proposal.votes,
    Object.freeze({ voterId: input.voterId, choice: input.choice }),
  ]);
  const yesVotes = votes.filter((vote) => vote.choice === "yes").length;
  const threshold =
    proposal.kind === "admission"
      ? admissionThreshold(proposal.electorate.length)
      : evictionThreshold(proposal.electorate.length);
  return Object.freeze({
    ...proposal,
    votes,
    status: yesVotes >= threshold ? "passed" : "open",
  });
}

export function submitEvictionResponse(
  proposal: EvictionProposal,
  input: SubmitEvictionResponseInput,
): EvictionProposal {
  validateEpoch(input.epoch);
  if (input.epoch !== proposal.epoch) {
    throw new DomainError(
      "INVALID_EPOCH",
      `Response epoch ${input.epoch} does not match proposal epoch ${proposal.epoch}.`,
    );
  }
  validateIdentifier(input.memberId, "memberId");
  if (input.memberId !== proposal.targetId) {
    throw new DomainError(
      "INVALID_RESPONSE",
      "Only the eviction target may submit a response.",
    );
  }
  if (proposal.response !== undefined) {
    throw new DomainError(
      "DUPLICATE_RESPONSE",
      "An eviction target may submit only one response.",
    );
  }
  if (typeof input.response !== "string" || input.response.trim().length === 0) {
    throw new DomainError("INVALID_RESPONSE", "Response must not be empty.");
  }
  return Object.freeze({ ...proposal, response: input.response });
}

/** Returns only governance-rule passage; consensus commit/finality is external. */
export function hasGovernancePassed(proposal: GovernanceProposal): boolean {
  return proposal.status === "passed";
}

/** Voluntary leave is unilateral and is deliberately not a ballot proposal. */
export function requireVoteProposal(
  proposal: GovernanceProposal,
): AdmissionProposal | EvictionProposal {
  if (proposal.kind === "voluntary-leave") {
    throw new DomainError(
      "VOLUNTARY_LEAVE_REQUIRES_NO_VOTE",
      "Voluntary leave does not require a governance vote.",
    );
  }
  return proposal;
}

function validateBase(input: ProposalBase): void {
  validateIdentifier(input.proposalId, "proposalId");
  validateEpoch(input.epoch);
}

function validateEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new DomainError(
      "INVALID_EPOCH",
      "Epoch must be a non-negative safe integer.",
    );
  }
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", `${label} must not be empty.`);
  }
}

function freezeElectorate(electorate: readonly string[]): readonly string[] {
  if (!Array.isArray(electorate) || electorate.length === 0) {
    throw new DomainError(
      "INVALID_ELECTORATE",
      "The frozen electorate must contain at least one member.",
    );
  }
  const snapshot = [...electorate];
  for (const memberId of snapshot) {
    validateIdentifier(memberId, "electorate member ID");
  }
  if (new Set(snapshot).size !== snapshot.length) {
    throw new DomainError(
      "INVALID_ELECTORATE",
      "The frozen electorate cannot contain duplicate member IDs.",
    );
  }
  return Object.freeze(snapshot);
}

function assertElectorateSize(electorateSize: number): void {
  if (!Number.isSafeInteger(electorateSize) || electorateSize < 1) {
    throw new DomainError(
      "INVALID_ELECTORATE",
      "Electorate size must be a positive safe integer.",
    );
  }
}
