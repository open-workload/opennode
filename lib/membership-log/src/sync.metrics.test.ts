import { describe, it, expect } from "vitest";
import {
  createClusterEvent,
  createClusterId,
  MembershipService,
  type ClusterEvent,
} from "@workspace/opennode-domain";
import {
  createHmacSigner,
  createHmacVerifier,
  createInMemoryCheckpointStore,
  createInMemoryEventLogStore,
  createInMemoryPeerLogSource,
  EventLog,
  signEntry,
  type PeerLogSource,
  type SignedLogEntry,
} from "@workspace/sync-engine";
import { renderMetrics } from "@workspace/observability";
import { MembershipLog, createInMemoryMembershipLogStore } from "./core";
import type { CommittedAdmissionPayload } from "./events";
import { MEMBERSHIP_ADMISSION_KIND } from "./events";
import { syncMembershipFromPeer } from "./sync";

const CLUSTER = "cluster-1";
const SIGNER_ID = "node-a";
const SECRET = "test-secret";

function createFixtures() {
  const signer = createHmacSigner(SIGNER_ID, SECRET);
  const verifier = createHmacVerifier({ [SIGNER_ID]: SECRET });
  const clusterId = createClusterId(CLUSTER);

  const payload: CommittedAdmissionPayload = {
    type: "admission",
    proposalId: "proposal-1",
    subjectId: "node-b",
    previousEpoch: 0,
    newEpoch: 1,
    electorateDenominator: 1,
    threshold: 1,
    yesVotes: 1,
  };
  const event: ClusterEvent = createClusterEvent({
    eventId: "event-1",
    clusterId,
    sequence: 0,
    epoch: 1,
    kind: MEMBERSHIP_ADMISSION_KIND,
    correlationId: "corr-1",
    payload,
  });
  const entry: SignedLogEntry = signEntry(event, null, signer);

  const localStore = createInMemoryEventLogStore();
  const local = new EventLog(localStore, clusterId, verifier);

  const membershipStore = createInMemoryMembershipLogStore();
  const membershipLog = new MembershipLog({
    clusterId,
    consensusLog: {
      isLeader: () => true,
      getLeaderId: () => SIGNER_ID,
      propose: async (proposed) => {
        await local.appendEvent(proposed.event, signer);
        return proposed;
      },
      getHeight: () => local.getHeight(),
      getEntry: (sequence) => local.getEntry(sequence),
      getRange: (from, to) => local.getRange(from, to),
      start: async () => undefined,
      stop: async () => undefined,
    },
    signer,
    store: membershipStore,
  });

  const membershipService = new MembershipService({
    clusterId: CLUSTER,
    auditSink: { record: () => undefined },
    initialMembers: ["node-a"],
    initialEpoch: 0,
  });

  const source = createInMemoryPeerLogSource({
    clusterId,
    entries: [entry],
    snapshot: null,
    chunkSize: 64,
  });

  return { verifier, clusterId, entry, local, membershipLog, membershipService, source };
}

describe("membership sync metrics", () => {
  it("emits sync.catchup_lag after catching up and a healthy sync.error_rate", async () => {
    const f = createFixtures();

    await syncMembershipFromPeer({
      clusterId: f.clusterId,
      local: f.local,
      source: f.source,
      checkpointStore: createInMemoryCheckpointStore(),
      verifier: f.verifier,
      membershipLog: f.membershipLog,
      membershipService: f.membershipService,
      claim: {
        clusterId: CLUSTER,
        epoch: 1,
        memberIds: ["node-a", "node-b"],
        height: 1,
        tipHash: f.entry.hash,
      },
      now: 1,
    });

    expect(renderMetrics()).toContain("sync.catchup_lag 1");
    expect(renderMetrics()).toContain("sync.error_rate 0");
  });

  it("emits sync.error_rate when catch-up from the peer fails", async () => {
    const f = createFixtures();
    const failingSource: PeerLogSource = {
      ...f.source,
      getHeight: async () => {
        throw new Error("peer unreachable");
      },
    };

    await expect(
      syncMembershipFromPeer({
        clusterId: f.clusterId,
        local: f.local,
        source: failingSource,
        checkpointStore: createInMemoryCheckpointStore(),
        verifier: f.verifier,
        membershipLog: f.membershipLog,
        membershipService: f.membershipService,
        claim: {
          clusterId: CLUSTER,
          epoch: 1,
          memberIds: ["node-a", "node-b"],
          height: 1,
          tipHash: f.entry.hash,
        },
        now: 2,
      }),
    ).rejects.toThrow("peer unreachable");

    expect(renderMetrics()).toContain("sync.error_rate 1");
  });
});