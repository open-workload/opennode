/**
 * Catch the consensus log up from a peer, then push membership into the domain view.
 *
 *   peer claim ──▶ membershipLog.reconcilePeer ──┬── consistent ──▶ skip catch-up
 *        │                                       └── otherwise ──▶ runCatchUp
 *        │                                                            (local, source)
 *        ▼                                                                │
 *   membershipLog.reconcile(now) ◀─────────────────────────────────────────┘
 *        │
 *        ▼
 *   membershipService.reconcile({ epoch, memberIds, sequence })
 *        └──▶ MembershipSyncResult { reconcile, catchUp, membership }
 */
import {
  ClusterId,
  MembershipService,
  MembershipSnapshot,
} from "@workspace/opennode-domain";
import {
  CheckpointStore,
  EventLog,
  PeerLogSource,
  SignatureVerifier,
  runCatchUp,
  type CatchUpResult,
} from "@workspace/sync-engine";
import { MembershipLog, PeerMembershipClaim, ReconcileResult } from "./core";

export interface MembershipSyncResult {
  readonly reconcile: ReconcileResult;
  /** Present only when the peer's claim required the local log to catch up. */
  readonly catchUp: CatchUpResult | null;
  readonly membership: MembershipSnapshot;
}

/**
 * Drive catch-up and membership reconciliation against a peer.
 *
 * The peer's committed membership claim is compared first. If the local node
 * is behind or diverged, the consensus log is caught up from the peer's
 * `PeerLogSource` via `runCatchUp`, the committed membership log is replayed,
 * and the resulting epoch/member set is pushed into the domain
 * `MembershipService` so its view tracks the committed log.
 */
export async function syncMembershipFromPeer(opts: {
  readonly clusterId: ClusterId;
  readonly local: EventLog;
  readonly source: PeerLogSource;
  readonly checkpointStore: CheckpointStore;
  readonly verifier: SignatureVerifier;
  readonly membershipLog: MembershipLog;
  readonly membershipService: MembershipService;
  readonly claim: PeerMembershipClaim;
  readonly now: number;
  readonly peers?: readonly PeerLogSource[];
  readonly chunkSize?: number;
}): Promise<MembershipSyncResult> {
  const reconcile = await opts.membershipLog.reconcilePeer(opts.claim);
  const catchUp =
    reconcile.status === "consistent"
      ? null
      : await runCatchUp({
          clusterId: opts.clusterId,
          local: opts.local,
          source: opts.source,
          checkpointStore: opts.checkpointStore,
          verifier: opts.verifier,
          ...(opts.peers === undefined ? {} : { peers: opts.peers }),
          ...(opts.chunkSize === undefined ? {} : { chunkSize: opts.chunkSize }),
        });
  const state = await opts.membershipLog.reconcile(opts.now);
  const membership = opts.membershipService.reconcile({
    epoch: state.epoch,
    memberIds: state.memberIds,
    sequence: state.appliedSequence,
  });
  return { reconcile, catchUp, membership };
}
