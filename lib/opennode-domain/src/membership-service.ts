/**
 * Stateful membership: proposals, revisioned ballots, and the only place the
 * member set and epoch change.
 *
 *   propose* ──▶ open (frozen electorate + computed threshold)
 *   ballot ──▶ cluster, epoch, expiry, signature, revision ──▶ evaluate
 *              │                                            │
 *              │                                open | passed | rejected | expired
 *   commitDecision ──▶ passed ──▶ add | remove member ──▶ epoch++ ──▶ committed
 *   reconcile(newer epoch) ──▶ replace members ──▶ invalidate older proposals
 */
import { DomainError } from "./errors";
import { admissionThreshold, evictionThreshold } from "./governance";

export type ProposalKind = "admission" | "eviction" | "voluntary-leave";

export type ProposalStatus =
  | "open"
  | "passed"
  | "rejected"
  | "expired"
  | "invalidated"
  | "committed";

export type DecisionOutcome =
  | "admitted"
  | "evicted"
  | "left"
  | "rejected"
  | "expired";

export interface Ballot {
  readonly proposalId: string;
  readonly clusterId: string;
  readonly voterId: string;
  readonly epoch: number;
  readonly choice: "yes" | "no";
  readonly expiresAt: number;
  readonly revision: number;
  readonly signature: string;
}

export interface GovernanceAuditSink {
  record(event: {
    readonly kind: string;
    readonly details: Readonly<Record<string, unknown>>;
  }): void;
}

export type BallotSignatureVerifier = (ballot: Ballot) => boolean;

export interface EvictionResponse {
  readonly memberId: string;
  readonly response: string;
  readonly epoch: number;
}

export interface ProposalSnapshot {
  readonly kind: ProposalKind;
  readonly proposalId: string;
  readonly clusterId: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly electorate: readonly string[];
  readonly denominator: number;
  readonly threshold: number;
  readonly yesVotes: number;
  readonly status: ProposalStatus;
  readonly subjectId: string;
  readonly response?: string;
  readonly decision?: DecisionOutcome;
}

export interface MembershipSnapshot {
  readonly clusterId: string;
  readonly epoch: number;
  readonly memberIds: readonly string[];
}

interface ProposalRecord {
  readonly kind: ProposalKind;
  readonly proposalId: string;
  readonly clusterId: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly electorate: readonly string[];
  readonly denominator: number;
  readonly threshold: number;
  readonly subjectId: string;
  status: ProposalStatus;
  readonly ballots: Map<string, Ballot>;
  response?: EvictionResponse;
  outcome?: DecisionOutcome;
}

export interface MembershipServiceConfig {
  readonly clusterId: string;
  readonly auditSink: GovernanceAuditSink;
  readonly verifyBallot?: BallotSignatureVerifier;
  readonly initialMembers?: readonly string[];
  readonly initialEpoch?: number;
}

export class MembershipService {
  private readonly clusterId: string;
  private readonly auditSink: GovernanceAuditSink;
  private readonly verifyBallot: BallotSignatureVerifier;
  private epoch: number;
  private readonly members: Map<string, true>;
  private readonly proposals = new Map<string, ProposalRecord>();

  constructor(config: MembershipServiceConfig) {
    validateId(config.clusterId, "clusterId");
    if (typeof config.auditSink?.record !== "function") {
      throw new DomainError(
        "INVALID_AUDIT_EVENT",
        "An audit sink with a record method is required.",
      );
    }
    this.clusterId = config.clusterId;
    this.auditSink = config.auditSink;
    this.verifyBallot =
      config.verifyBallot ??
      ((ballot) => typeof ballot.signature === "string" && ballot.signature.length > 0);
    this.epoch = config.initialEpoch ?? 0;
    if (!Number.isSafeInteger(this.epoch) || this.epoch < 0) {
      throw new DomainError("INVALID_EPOCH", "Initial epoch is invalid.");
    }
    this.members = new Map();
    for (const memberId of config.initialMembers ?? []) {
      validateId(memberId, "memberId");
      this.members.set(memberId, true);
    }
  }

  currentMembership(): MembershipSnapshot {
    return Object.freeze({
      clusterId: this.clusterId,
      epoch: this.epoch,
      memberIds: Object.freeze([...this.members.keys()].sort()),
    });
  }

  getProposal(proposalId: string): ProposalSnapshot {
    return this.snapshot(this.requireProposal(proposalId), undefined);
  }

  listProposals(): readonly ProposalSnapshot[] {
    return Object.freeze(
      [...this.proposals.values()]
        .map((p) => this.snapshot(p, undefined))
        .sort((a, b) => a.proposalId.localeCompare(b.proposalId)),
    );
  }

  proposeAdmission(input: {
    readonly proposalId: string;
    readonly candidateId: string;
    readonly expiresAt: number;
    readonly now: number;
  }): ProposalSnapshot {
    validateId(input.proposalId, "proposalId");
    validateId(input.candidateId, "candidateId");
    validateTime(input.expiresAt, "expiresAt");
    validateTime(input.now, "now");
    if (input.expiresAt <= input.now) {
      throw new DomainError(
        "INVALID_PROPOSAL",
        "Proposal expiry must be in the future.",
      );
    }
    if (this.members.has(input.candidateId)) {
      throw new DomainError(
        "ALREADY_A_MEMBER",
        "The candidate is already a member.",
      );
    }
    if (this.proposals.has(input.proposalId)) {
      throw new DomainError(
        "INVALID_PROPOSAL",
        "Proposal ID is already in use.",
      );
    }
    const electorate = Object.freeze(
      [...this.members.keys()].filter((m) => m !== input.candidateId).sort(),
    );
    if (electorate.length === 0) {
      throw new DomainError(
        "INVALID_ELECTORATE",
        "Admission requires at least one eligible non-candidate voter.",
      );
    }
    const denominator = electorate.length;
    const record: ProposalRecord = {
      kind: "admission",
      proposalId: input.proposalId,
      clusterId: this.clusterId,
      epoch: this.epoch,
      expiresAt: input.expiresAt,
      electorate,
      denominator,
      threshold: admissionThreshold(denominator),
      subjectId: input.candidateId,
      status: "open",
      ballots: new Map(),
    };
    this.proposals.set(record.proposalId, record);
    this.audit("governance.proposal.opened", {
      kind: record.kind,
      proposalId: record.proposalId,
      epoch: record.epoch,
      denominator: record.denominator,
      threshold: record.threshold,
      subjectId: record.subjectId,
      expiresAt: record.expiresAt,
    });
    return this.snapshot(record, input.now);
  }

  proposeEviction(input: {
    readonly proposalId: string;
    readonly targetId: string;
    readonly expiresAt: number;
    readonly now: number;
  }): ProposalSnapshot {
    validateId(input.proposalId, "proposalId");
    validateId(input.targetId, "targetId");
    validateTime(input.expiresAt, "expiresAt");
    validateTime(input.now, "now");
    if (input.expiresAt <= input.now) {
      throw new DomainError(
        "INVALID_PROPOSAL",
        "Proposal expiry must be in the future.",
      );
    }
    if (!this.members.has(input.targetId)) {
      throw new DomainError(
        "NOT_A_MEMBER",
        "The eviction target is not a current member.",
      );
    }
    if (this.proposals.has(input.proposalId)) {
      throw new DomainError(
        "INVALID_PROPOSAL",
        "Proposal ID is already in use.",
      );
    }
    const electorate = Object.freeze([...this.members.keys()].sort());
    const denominator = electorate.length;
    const record: ProposalRecord = {
      kind: "eviction",
      proposalId: input.proposalId,
      clusterId: this.clusterId,
      epoch: this.epoch,
      expiresAt: input.expiresAt,
      electorate,
      denominator,
      threshold: evictionThreshold(denominator),
      subjectId: input.targetId,
      status: "open",
      ballots: new Map(),
    };
    this.proposals.set(record.proposalId, record);
    this.audit("governance.proposal.opened", {
      kind: record.kind,
      proposalId: record.proposalId,
      epoch: record.epoch,
      denominator: record.denominator,
      threshold: record.threshold,
      subjectId: record.subjectId,
      expiresAt: record.expiresAt,
    });
    return this.snapshot(record, input.now);
  }

  requestLeave(input: {
    readonly memberId: string;
    readonly proposalId?: string;
    readonly now: number;
  }): ProposalSnapshot {
    validateId(input.memberId, "memberId");
    validateTime(input.now, "now");
    if (!this.members.has(input.memberId)) {
      throw new DomainError(
        "NOT_A_MEMBER",
        "Only a current member may leave.",
      );
    }
    const proposalId = input.proposalId ?? `leave-${input.memberId}-${this.epoch}`;
    validateId(proposalId, "proposalId");
    if (this.proposals.has(proposalId)) {
      throw new DomainError(
        "INVALID_PROPOSAL",
        "Proposal ID is already in use.",
      );
    }
    const record: ProposalRecord = {
      kind: "voluntary-leave",
      proposalId,
      clusterId: this.clusterId,
      epoch: this.epoch,
      expiresAt: input.now,
      electorate: Object.freeze([input.memberId]),
      denominator: 1,
      threshold: 1,
      subjectId: input.memberId,
      status: "passed",
      ballots: new Map(),
    };
    this.proposals.set(proposalId, record);
    this.audit("governance.leave.requested", {
      proposalId,
      memberId: input.memberId,
      epoch: this.epoch,
    });
    return this.snapshot(record, input.now);
  }

  submitEvictionResponse(input: {
    readonly proposalId: string;
    readonly memberId: string;
    readonly epoch: number;
    readonly response: string;
    readonly now: number;
  }): ProposalSnapshot {
    const record = this.requireProposal(input.proposalId);
    if (record.kind !== "eviction") {
      throw new DomainError("INVALID_RESPONSE", "Only evictions accept responses.");
    }
    if (input.memberId !== record.subjectId) {
      throw new DomainError(
        "INVALID_RESPONSE",
        "Only the eviction target may respond.",
      );
    }
    if (input.epoch !== record.epoch || record.epoch !== this.epoch) {
      throw new DomainError("STALE_EPOCH", "Response epoch is stale.");
    }
    if (input.now >= record.expiresAt) {
      throw new DomainError("PROPOSAL_EXPIRED", "The proposal has expired.");
    }
    if (record.response !== undefined) {
      throw new DomainError("DUPLICATE_RESPONSE", "Response already recorded.");
    }
    validateId(input.response, "response");
    record.response = Object.freeze({
      memberId: input.memberId,
      response: input.response,
      epoch: input.epoch,
    });
    this.audit("governance.eviction.response", {
      proposalId: record.proposalId,
      memberId: input.memberId,
      epoch: input.epoch,
    });
    return this.snapshot(record, input.now);
  }

  castVote(ballot: Ballot, input: { readonly now: number }): ProposalSnapshot {
    validateBallotShape(ballot);
    validateTime(input.now, "now");
    const record = this.requireProposal(ballot.proposalId);
    if (record.kind === "voluntary-leave") {
      throw new DomainError(
        "VOLUNTARY_LEAVE_REQUIRES_NO_VOTE",
        "Voluntary leave does not accept ballots.",
      );
    }
    if (ballot.clusterId !== this.clusterId || ballot.clusterId !== record.clusterId) {
      throw new DomainError(
        "INVALID_BALLOT",
        "Ballot cluster ID does not match.",
      );
    }
    if (ballot.epoch !== record.epoch || record.epoch !== this.epoch) {
      throw new DomainError(
        "STALE_EPOCH",
        `Ballot epoch ${ballot.epoch} does not match proposal epoch ${record.epoch}.`,
      );
    }
    if (record.status !== "open") {
      throw new DomainError("PROPOSAL_CLOSED", "The proposal is closed.");
    }
    if (input.now >= record.expiresAt) {
      throw new DomainError("PROPOSAL_EXPIRED", "The proposal has expired.");
    }
    if (ballot.expiresAt <= input.now) {
      throw new DomainError("VOTE_EXPIRED", "The ballot has expired.");
    }
    if (!this.verifyBallot(ballot)) {
      throw new DomainError(
        "INVALID_BALLOT",
        "Ballot signature verification failed.",
      );
    }
    if (record.kind === "admission" && ballot.voterId === record.subjectId) {
      throw new DomainError(
        "CANDIDATE_CANNOT_VOTE",
        "The candidate cannot vote on their own admission.",
      );
    }
    if (record.kind === "eviction" && ballot.voterId === record.subjectId) {
      throw new DomainError(
        "TARGET_CANNOT_VOTE",
        "The target cannot cast a counted ballot.",
      );
    }
    if (!record.electorate.includes(ballot.voterId)) {
      throw new DomainError(
        "UNAUTHORIZED_VOTER",
        "Voter is not in the frozen electorate.",
      );
    }
    const last = record.ballots.get(ballot.voterId);
    if (last !== undefined) {
      if (ballot.revision < last.revision) {
        throw new DomainError(
          "REPLAYED_BALLOT",
          "A lower-revision ballot is replayed.",
        );
      }
      if (ballot.revision === last.revision) {
        if (last.choice === ballot.choice) {
          throw new DomainError(
            "DUPLICATE_BALLOT",
            "This ballot revision was already accepted.",
          );
        }
        throw new DomainError(
          "CONFLICTING_BALLOT",
          "A different choice with the same revision is rejected.",
        );
      }
    }
    record.ballots.set(ballot.voterId, Object.freeze({ ...ballot }));
    record.status = this.evaluate(record, input.now);
    this.audit("governance.ballot.accepted", {
      proposalId: record.proposalId,
      voterId: ballot.voterId,
      epoch: ballot.epoch,
      choice: ballot.choice,
      revision: ballot.revision,
      expiresAt: ballot.expiresAt,
      yesVotes: countYes(record),
      threshold: record.threshold,
      denominator: record.denominator,
      status: record.status,
    });
    return this.snapshot(record, input.now);
  }

  commitDecision(input: {
    readonly proposalId: string;
    readonly now: number;
  }): ProposalSnapshot & { readonly outcome: DecisionOutcome } {
    const record = this.requireProposal(input.proposalId);
    validateTime(input.now, "now");
    if (record.status === "committed") {
      throw new DomainError("PROPOSAL_CLOSED", "Already committed.");
    }
    if (record.status === "invalidated") {
      throw new DomainError(
        "DECISION_NOT_FINAL",
        "The proposal was invalidated by a newer epoch.",
      );
    }
    const settled =
      record.kind === "voluntary-leave"
        ? ("passed" as ProposalStatus)
        : this.evaluate(record, input.now);
    if (settled !== "passed" && settled !== "rejected" && settled !== "expired") {
      throw new DomainError(
        "DECISION_NOT_FINAL",
        "The proposal has not yet reached a final outcome.",
      );
    }
    let outcome: DecisionOutcome;
    if (settled === "passed") {
      outcome =
        record.kind === "admission"
          ? "admitted"
          : record.kind === "eviction"
            ? "evicted"
            : "left";
      if (record.kind === "admission") {
        if (this.members.has(record.subjectId)) {
          throw new DomainError("ALREADY_A_MEMBER", "Candidate already admitted.");
        }
        this.members.set(record.subjectId, true);
      } else {
        if (!this.members.has(record.subjectId)) {
          throw new DomainError("NOT_A_MEMBER", "Subject already removed.");
        }
        this.members.delete(record.subjectId);
      }
      this.epoch += 1;
    } else {
      outcome = settled === "expired" ? "expired" : "rejected";
    }
    record.outcome = outcome;
    record.status = "committed";
    this.audit("governance.decision.committed", {
      proposalId: record.proposalId,
      kind: record.kind,
      outcome,
      subjectId: record.subjectId,
      yesVotes: countYes(record),
      denominator: record.denominator,
      threshold: record.threshold,
      newEpoch: this.epoch,
    });
    return this.snapshot(record, input.now) as ProposalSnapshot & {
      readonly outcome: DecisionOutcome;
    };
  }

  reconcile(input: {
    readonly epoch: number;
    readonly memberIds: readonly string[];
    readonly sequence: number;
  }): MembershipSnapshot {
    if (!Number.isSafeInteger(input.epoch) || input.epoch < 0) {
      throw new DomainError("INVALID_EPOCH", "Epoch must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new DomainError("INVALID_EVENT", "Sequence must be a non-negative safe integer.");
    }
    if (input.epoch < this.epoch) {
      throw new DomainError(
        "STALE_EPOCH",
        `Committed epoch ${input.epoch} is behind local epoch ${this.epoch}.`,
      );
    }
    for (const memberId of input.memberIds) validateId(memberId, "memberId");
    if (new Set(input.memberIds).size !== input.memberIds.length) {
      throw new DomainError(
        "INVALID_EVENT",
        "Committed member list contains duplicates.",
      );
    }
    if (input.epoch === this.epoch) {
      const current = [...this.members.keys()].sort();
      const incoming = [...input.memberIds].sort();
      if (JSON.stringify(current) === JSON.stringify(incoming)) {
        return this.currentMembership();
      }
      throw new DomainError(
        "INVALID_DECISION",
        "Conflicting committed membership at the same epoch.",
      );
    }
    this.epoch = input.epoch;
    this.members.clear();
    for (const memberId of input.memberIds) this.members.set(memberId, true);
    for (const record of this.proposals.values()) {
      if (record.status === "open" || record.status === "passed" || record.status === "rejected") {
        if (record.epoch < this.epoch) {
          record.status = "invalidated";
          this.audit("governance.proposal.invalidated", {
            proposalId: record.proposalId,
            epoch: record.epoch,
            newEpoch: this.epoch,
          });
        }
      }
    }
    this.audit("governance.membership.reconciled", {
      epoch: this.epoch,
      sequence: input.sequence,
      memberIds: [...input.memberIds].sort(),
    });
    return this.currentMembership();
  }

  private evaluate(record: ProposalRecord, now: number): ProposalStatus {
    if (record.status === "committed" || record.status === "invalidated") {
      return record.status;
    }
    if (record.kind === "voluntary-leave") {
      return record.status;
    }
    const yes = countYes(record);
    if (yes >= record.threshold) return "passed";
    if (now >= record.expiresAt) return "expired";
    const eligible = eligibleVoters(record);
    const remaining = eligible.filter(
      (voterId) => !record.ballots.has(voterId),
    ).length;
    if (yes + remaining < record.threshold) return "rejected";
    return "open";
  }

  private snapshot(record: ProposalRecord, now: number | undefined): ProposalSnapshot {
    const status =
      record.status === "committed" || record.status === "invalidated"
        ? record.status
        : now === undefined
          ? record.status
          : this.evaluate(record, now);
    return Object.freeze({
      kind: record.kind,
      proposalId: record.proposalId,
      clusterId: record.clusterId,
      epoch: record.epoch,
      expiresAt: record.expiresAt,
      electorate: record.electorate,
      denominator: record.denominator,
      threshold: record.threshold,
      yesVotes: countYes(record),
      status,
      subjectId: record.subjectId,
      ...(record.response !== undefined
        ? { response: record.response.response }
        : {}),
      ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
    });
  }

  private requireProposal(proposalId: string): ProposalRecord {
    validateId(proposalId, "proposalId");
    const record = this.proposals.get(proposalId);
    if (record === undefined) {
      throw new DomainError(
        "PROPOSAL_NOT_FOUND",
        `Unknown proposal ${proposalId}.`,
      );
    }
    return record;
  }

  private audit(kind: string, details: Readonly<Record<string, unknown>>): void {
    this.auditSink.record({ kind, details });
  }
}

function countYes(record: ProposalRecord): number {
  let yes = 0;
  for (const ballot of record.ballots.values()) {
    if (ballot.choice === "yes") yes += 1;
  }
  return yes;
}

function eligibleVoters(record: ProposalRecord): readonly string[] {
  return record.electorate.filter((id) => id !== record.subjectId);
}

function validateBallotShape(ballot: Ballot): void {
  if (typeof ballot !== "object" || ballot === null) {
    throw new DomainError("INVALID_BALLOT", "Ballot is required.");
  }
  validateId(ballot.proposalId, "proposalId");
  validateId(ballot.clusterId, "clusterId");
  validateId(ballot.voterId, "voterId");
  if (!Number.isSafeInteger(ballot.epoch) || ballot.epoch < 0) {
    throw new DomainError("INVALID_EPOCH", "Ballot epoch is invalid.");
  }
  if (ballot.choice !== "yes" && ballot.choice !== "no") {
    throw new DomainError("INVALID_BALLOT", "Ballot choice is invalid.");
  }
  if (!Number.isSafeInteger(ballot.expiresAt) || ballot.expiresAt < 0) {
    throw new DomainError("INVALID_BALLOT", "Ballot expiry is invalid.");
  }
  if (!Number.isSafeInteger(ballot.revision) || ballot.revision < 0) {
    throw new DomainError("INVALID_BALLOT", "Ballot revision is invalid.");
  }
  if (typeof ballot.signature !== "string" || ballot.signature.length === 0) {
    throw new DomainError("INVALID_BALLOT", "Ballot signature is required.");
  }
}

function validateId(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_IDENTIFIER", `${label} must not be empty.`);
  }
}

function validateTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_BALLOT", `${label} must be a non-negative safe integer.`);
  }
}
