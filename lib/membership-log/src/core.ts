/**
 * Committed membership: admission, eviction and leave are the only way in or out.
 *
 *   commitAdmission / commitEviction / commitLeave  (not leader ──▶ NOT_LEADER)
 *        ▼
 *   assertAdmissionPassed (vote threshold) ──▶ createClusterEvent ──▶ signEntry(prevHash)
 *        ▼
 *   ConsensusLog.propose ──▶ applyFromLog ──▶ applyMembershipEntry per entry
 *        │                      ├──▶ epoch must advance by one; save to store
 *        │                      └──▶ epoch change ──▶ leases.fenceOnEpochChange
 *        └──▶ reconcilePeer(claim) ──▶ consistent | advanced | behind | diverged
 *   createWithRaft wires a RaftEventLogStore in as the ConsensusLog
 */
import {
  ClusterId,
  ClusterEvent,
  NodeId,
  assertClusterId,
  createClusterEvent,
} from "@workspace/opennode-domain";
import {
  EventLog,
  SignedLogEntry,
  Signer,
  signEntry,
} from "@workspace/sync-engine";
import {
  MembershipCertificate,
  SignatureScheme,
  issueMembershipCertificate,
} from "@workspace/peernet";
import { MembershipLogError } from "./errors";
import {
  CommittedAdmissionPayload,
  CommittedEvictionPayload,
  CommittedLeavePayload,
  MEMBERSHIP_ADMISSION_KIND,
  MEMBERSHIP_EVICTION_KIND,
  MEMBERSHIP_LEAVE_KIND,
  MembershipDecisionPayload,
  assertAdmissionPassed,
  assertEvictionPassed,
  leaveMessage,
} from "./events";
import { LeaseRecord, LeaseRegistry } from "./leases";
import {
  RaftEventLogStore,
  RaftEventLogStoreConfig,
} from "@workspace/raft-log";

export interface CommittedMembershipState {
  readonly clusterId: string;
  readonly epoch: number;
  readonly memberIds: readonly string[];
  readonly appliedSequence: number;
}

export interface MembershipLogStore {
  load(): Promise<CommittedMembershipState | undefined>;
  save(state: CommittedMembershipState): Promise<void>;
}

export function createInMemoryMembershipLogStore(): MembershipLogStore {
  let state: CommittedMembershipState | undefined;
  return {
    async load() {
      return state;
    },
    async save(next) {
      state = Object.freeze({
        ...next,
        memberIds: Object.freeze([...next.memberIds]),
      });
    },
  };
}

export interface PeerMembershipClaim {
  readonly clusterId: string;
  readonly epoch: number;
  readonly memberIds: readonly string[];
  readonly height: number;
  readonly tipHash: string | null;
}

export type ReconcileResult =
  | { readonly status: "consistent"; readonly state: CommittedMembershipState }
  | {
      readonly status: "advanced";
      readonly state: CommittedMembershipState;
      readonly fromEpoch: number;
    }
  | {
      readonly status: "behind";
      readonly state: CommittedMembershipState;
      readonly neededEpoch: number;
    }
  | { readonly status: "diverged"; readonly state: CommittedMembershipState };

export function applyMembershipEntry(
  state: CommittedMembershipState,
  entry: SignedLogEntry<MembershipDecisionPayload>,
  opts: {
    readonly clusterId: ClusterId;
    readonly verifier?: SignatureScheme;
  },
): CommittedMembershipState {
  const event = entry.event as ClusterEvent<MembershipDecisionPayload>;
  if (event.clusterId.value !== opts.clusterId.value) {
    throw new MembershipLogError("WRONG_CLUSTER", "Entry cluster mismatch.");
  }
  if (event.sequence !== state.appliedSequence) {
    throw new MembershipLogError(
      "MEMBERSHIP_LOG_INVALID",
      `Entry sequence ${event.sequence} is not next after ${state.appliedSequence}.`,
    );
  }
  const payload = event.payload;
  if (
    payload.previousEpoch !== state.epoch ||
    payload.newEpoch !== state.epoch + 1
  ) {
    throw new MembershipLogError(
      "MEMBERSHIP_EPOCH_REGRESSION",
      `Payload epochs ${payload.previousEpoch}->${payload.newEpoch} inconsistent with state epoch ${state.epoch}.`,
    );
  }
  switch (event.kind) {
    case MEMBERSHIP_ADMISSION_KIND: {
      if (payload.type !== "admission") throw invalidShape();
      assertAdmissionPassed(payload as CommittedAdmissionPayload);
      if (state.memberIds.includes(payload.subjectId)) {
        throw new MembershipLogError(
          "SUBJECT_ALREADY_MEMBER",
          "Subject already admitted.",
        );
      }
      return {
        clusterId: state.clusterId,
        epoch: payload.newEpoch,
        memberIds: Object.freeze([...state.memberIds, payload.subjectId].sort()),
        appliedSequence: event.sequence + 1,
      };
    }
    case MEMBERSHIP_EVICTION_KIND: {
      if (payload.type !== "eviction") throw invalidShape();
      assertEvictionPassed(payload as CommittedEvictionPayload);
      if (!state.memberIds.includes(payload.subjectId)) {
        throw new MembershipLogError(
          "SUBJECT_NOT_MEMBER",
          "Eviction subject not a member.",
        );
      }
      return {
        clusterId: state.clusterId,
        epoch: payload.newEpoch,
        memberIds: Object.freeze(
          state.memberIds.filter((m) => m !== payload.subjectId).sort(),
        ),
        appliedSequence: event.sequence + 1,
      };
    }
    case MEMBERSHIP_LEAVE_KIND: {
      if (payload.type !== "leave") throw invalidShape();
      if (!state.memberIds.includes(payload.subjectId)) {
        throw new MembershipLogError(
          "SUBJECT_NOT_MEMBER",
          "Leaving subject not a member.",
        );
      }
      if (opts.verifier !== undefined) {
        const ok = opts.verifier.verify(
          { schemaVersion: 1, value: payload.signerNodeId } as NodeId,
          leaveMessage({
            clusterId: opts.clusterId.value,
            subjectId: payload.subjectId,
            previousEpoch: payload.previousEpoch,
            newEpoch: payload.newEpoch,
          }),
          payload.signature,
        );
        if (!ok) {
          throw new MembershipLogError(
            "INVALID_LEAVE_SIGNATURE",
            "Leave event signature invalid.",
          );
        }
      }
      return {
        clusterId: state.clusterId,
        epoch: payload.newEpoch,
        memberIds: Object.freeze(
          state.memberIds.filter((m) => m !== payload.subjectId).sort(),
        ),
        appliedSequence: event.sequence + 1,
      };
    }
    default:
      throw new MembershipLogError(
        "MEMBERSHIP_LOG_INVALID",
        `Unrecognized membership event kind ${event.kind}.`,
      );
  }
}

function invalidShape(): MembershipLogError {
  return new MembershipLogError("MEMBERSHIP_LOG_INVALID", "Payload type mismatch.");
}

export interface ConsensusLog {
  readonly isLeader: () => boolean;
  readonly getLeaderId: () => string | null;
  readonly propose: (entry: SignedLogEntry) => Promise<SignedLogEntry>;
  readonly getHeight: () => Promise<number>;
  readonly getEntry: (sequence: number) => Promise<SignedLogEntry | undefined>;
  readonly getRange: (fromInclusive: number, toExclusive: number) => Promise<SignedLogEntry[]>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

export class MembershipLog {
  private readonly clusterId: ClusterId;
  private readonly consensusLog: ConsensusLog;
  private readonly signer: Signer;
  private readonly store: MembershipLogStore;
  private readonly leaveVerifier?: SignatureScheme;
  readonly leases: LeaseRegistry;

  constructor(deps: {
    readonly clusterId: ClusterId;
    readonly consensusLog: ConsensusLog;
    readonly signer: Signer;
    readonly store: MembershipLogStore;
    readonly leaveVerifier?: SignatureScheme;
    readonly leases?: LeaseRegistry;
  }) {
    assertClusterId(deps.clusterId);
    this.clusterId = deps.clusterId;
    this.consensusLog = deps.consensusLog;
    this.signer = deps.signer;
    this.store = deps.store;
    this.leaveVerifier = deps.leaveVerifier;
    this.leases = deps.leases ?? new LeaseRegistry();
  }

  static async createWithRaft(deps: {
    readonly clusterId: ClusterId;
    readonly raftConfig: RaftEventLogStoreConfig;
    readonly signer: Signer;
    readonly store: MembershipLogStore;
    readonly leaveVerifier?: SignatureScheme;
    readonly leases?: LeaseRegistry;
  }): Promise<MembershipLog> {
    const raftStore = new RaftEventLogStore(deps.raftConfig);
    await raftStore.start();

    const consensusLog: ConsensusLog = {
      isLeader: () => raftStore.isLeader(),
      getLeaderId: () => raftStore.getLeaderId(),
      propose: async (entry) => {
        await raftStore.append([entry]);
        return entry;
      },
      getHeight: () => raftStore.getHeight(),
      getEntry: (seq) => raftStore.getEntry(seq),
      getRange: (from, to) => raftStore.getRange(from, to),
      start: () => raftStore.start(),
      stop: () => raftStore.stop(),
    };

    return new MembershipLog({
      clusterId: deps.clusterId,
      consensusLog,
      signer: deps.signer,
      store: deps.store,
      leaveVerifier: deps.leaveVerifier,
      leases: deps.leases,
    });
  }

  async getState(): Promise<CommittedMembershipState> {
    const stored = await this.store.load();
    if (stored !== undefined) return stored;
    return Object.freeze({
      clusterId: this.clusterId.value,
      epoch: 0,
      memberIds: Object.freeze([] as string[]),
      appliedSequence: 0,
    });
  }

  async commitAdmission(input: {
    readonly proposalId: string;
    readonly subjectId: string;
    readonly newEpoch: number;
    readonly electorateDenominator: number;
    readonly threshold: number;
    readonly yesVotes: number;
    readonly eventId: string;
    readonly correlationId: string;
    readonly now?: number;
  }): Promise<SignedLogEntry> {
    if (!this.consensusLog.isLeader()) {
      throw new MembershipLogError("NOT_LEADER", "Only leader can commit membership changes");
    }

    const state = await this.getState();
    const payload: CommittedAdmissionPayload = {
      type: "admission",
      proposalId: input.proposalId,
      subjectId: input.subjectId,
      previousEpoch: state.epoch,
      newEpoch: input.newEpoch,
      electorateDenominator: input.electorateDenominator,
      threshold: input.threshold,
      yesVotes: input.yesVotes,
    };
    assertAdmissionPassed(payload);
    if (input.newEpoch !== state.epoch + 1) {
      throw new MembershipLogError(
        "MEMBERSHIP_EPOCH_REGRESSION",
        `newEpoch must be ${state.epoch + 1}.`,
      );
    }
    const height = await this.consensusLog.getHeight();
    const event = createClusterEvent({
      eventId: input.eventId,
      clusterId: this.clusterId,
      sequence: height,
      epoch: input.newEpoch,
      kind: MEMBERSHIP_ADMISSION_KIND,
      correlationId: input.correlationId,
      payload,
    });
    const tip = await this.consensusLog.getEntry(height - 1);
    const prevHash = tip?.hash ?? null;
    const signedEntry = signEntry(event, prevHash, this.signer);
    const entry = await this.consensusLog.propose(signedEntry);
    await this.applyFromLog(input.now);
    return entry;
  }

  async commitEviction(input: {
    readonly proposalId: string;
    readonly subjectId: string;
    readonly newEpoch: number;
    readonly electorateDenominator: number;
    readonly threshold: number;
    readonly yesVotes: number;
    readonly eventId: string;
    readonly correlationId: string;
    readonly now?: number;
  }): Promise<SignedLogEntry> {
    if (!this.consensusLog.isLeader()) {
      throw new MembershipLogError("NOT_LEADER", "Only leader can commit membership changes");
    }

    const state = await this.getState();
    const payload: CommittedEvictionPayload = {
      type: "eviction",
      proposalId: input.proposalId,
      subjectId: input.subjectId,
      previousEpoch: state.epoch,
      newEpoch: input.newEpoch,
      electorateDenominator: input.electorateDenominator,
      threshold: input.threshold,
      yesVotes: input.yesVotes,
    };
    assertEvictionPassed(payload);
    if (input.newEpoch !== state.epoch + 1) {
      throw new MembershipLogError(
        "MEMBERSHIP_EPOCH_REGRESSION",
        `newEpoch must be ${state.epoch + 1}.`,
      );
    }
    const height = await this.consensusLog.getHeight();
    const event = createClusterEvent({
      eventId: input.eventId,
      clusterId: this.clusterId,
      sequence: height,
      epoch: input.newEpoch,
      kind: MEMBERSHIP_EVICTION_KIND,
      correlationId: input.correlationId,
      payload,
    });
    const tip = await this.consensusLog.getEntry(height - 1);
    const prevHash = tip?.hash ?? null;
    const signedEntry = signEntry(event, prevHash, this.signer);
    const entry = await this.consensusLog.propose(signedEntry);
    await this.applyFromLog(input.now);
    return entry;
  }

  async commitLeave(input: {
    readonly proposalId: string;
    readonly memberId: string;
    readonly secretKey: string;
    readonly signerNodeId: string;
    readonly scheme: SignatureScheme;
    readonly eventId: string;
    readonly correlationId: string;
    readonly now?: number;
  }): Promise<SignedLogEntry> {
    if (!this.consensusLog.isLeader()) {
      throw new MembershipLogError("NOT_LEADER", "Only leader can commit membership changes");
    }

    const state = await this.getState();
    if (!state.memberIds.includes(input.memberId)) {
      throw new MembershipLogError("SUBJECT_NOT_MEMBER", "Not a member.");
    }
    const newEpoch = state.epoch + 1;
    const signature = input.scheme.sign(
      new TextEncoder().encode(input.secretKey),
      leaveMessage({
        clusterId: this.clusterId.value,
        subjectId: input.memberId,
        previousEpoch: state.epoch,
        newEpoch,
      }),
    );
    const payload: CommittedLeavePayload = {
      type: "leave",
      proposalId: input.proposalId,
      subjectId: input.memberId,
      previousEpoch: state.epoch,
      newEpoch,
      signerNodeId: input.signerNodeId,
      signature,
    };
    const height = await this.consensusLog.getHeight();
    const event = createClusterEvent({
      eventId: input.eventId,
      clusterId: this.clusterId,
      sequence: height,
      epoch: newEpoch,
      kind: MEMBERSHIP_LEAVE_KIND,
      correlationId: input.correlationId,
      payload,
    });
    const tip = await this.consensusLog.getEntry(height - 1);
    const prevHash = tip?.hash ?? null;
    const signedEntry = signEntry(event, prevHash, this.signer);
    const entry = await this.consensusLog.propose(signedEntry);
    await this.applyFromLog(input.now);
    return entry;
  }

  async reconcile(now?: number): Promise<CommittedMembershipState> {
    return this.applyFromLog(now);
  }

  async reconcilePeer(claim: PeerMembershipClaim): Promise<ReconcileResult> {
    const state = await this.getState();
    if (claim.clusterId !== state.clusterId) {
      throw new MembershipLogError(
        "WRONG_CLUSTER",
        "Peer claim for another cluster.",
      );
    }
    if (claim.epoch < state.epoch) {
      return { status: "diverged", state };
    }
    if (claim.epoch === state.epoch) {
      const sameMembers =
        claim.memberIds.length === state.memberIds.length &&
        [...claim.memberIds].sort().join("\u001f") ===
          [...state.memberIds].sort().join("\u001f");
      if (sameMembers) return { status: "consistent", state };
      return { status: "diverged", state };
    }
    return { status: "behind", state, neededEpoch: claim.epoch };
  }

  async fencingEpoch(): Promise<number> {
    return (await this.getState()).epoch;
  }

  async fenceLeases(now: number): Promise<readonly LeaseRecord[]> {
    const state = await this.getState();
    return this.leases.fenceOnEpochChange(state.epoch, now);
  }

  async issueMembershipCredential(input: {
    readonly nodeId: NodeId;
    readonly now: number;
    readonly ttlMs: number;
    readonly secretKey: string;
    readonly scheme: SignatureScheme;
  }): Promise<MembershipCertificate> {
    const state = await this.getState();
    if (!state.memberIds.includes(input.nodeId.value)) {
      throw new MembershipLogError(
        "MEMBERSHIP_NOT_COMMITTED",
        "Credential issuance requires a committed membership epoch.",
      );
    }
    return issueMembershipCertificate({
      clusterId: this.clusterId,
      nodeId: input.nodeId,
      epoch: state.epoch,
      issuedAt: input.now,
      ttlMs: input.ttlMs,
      caPrivateKey: new TextEncoder().encode(input.secretKey),
      caPublicKey: new TextEncoder().encode(input.secretKey), // In real impl, derive from secretKey
    });
  }

  private async applyFromLog(now: number | undefined): Promise<CommittedMembershipState> {
    const stored = (await this.store.load()) ?? {
      clusterId: this.clusterId.value,
      epoch: 0,
      memberIds: Object.freeze([] as string[]),
      appliedSequence: 0,
    };
    const height = await this.consensusLog.getHeight();
    const entries = await this.consensusLog.getRange(stored.appliedSequence, height);
    let state = stored;
    for (const entry of entries) {
      const event = entry.event;
      if (
        event.kind === MEMBERSHIP_ADMISSION_KIND ||
        event.kind === MEMBERSHIP_EVICTION_KIND ||
        event.kind === MEMBERSHIP_LEAVE_KIND
      ) {
        state = applyMembershipEntry(
          state,
          entry as SignedLogEntry<MembershipDecisionPayload>,
          {
            clusterId: this.clusterId,
            ...(this.leaveVerifier !== undefined
              ? { verifier: this.leaveVerifier }
              : {}),
          },
        );
      } else {
        state = { ...state, appliedSequence: event.sequence + 1 };
      }
    }
    if (state.epoch > stored.epoch && now !== undefined) {
      this.leases.fenceOnEpochChange(state.epoch, now);
    }
    await this.store.save(state);
    return state;
  }
}