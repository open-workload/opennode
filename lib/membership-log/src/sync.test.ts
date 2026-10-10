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
  type SignedLogEntry,
} from "@workspace/sync-engine";
import { MembershipLog, createInMemoryMembershipLogStore } from "./core";
import {
  MEMBERSHIP_ADMISSION_KIND,
  type CommittedAdmissionPayload,
} from "./events";
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

  return { verifier, clusterId, entry, local, membershipStore, membershipLog, membershipService, source };
}

describe("syncMembershipFromPeer", () => {
  it("catches up from a peer log and reconciles committed + domain membership", async () => {
    const f = createFixtures();
    await f.membershipStore.save({
      clusterId: CLUSTER,
      epoch: 0,
      memberIds: Object.freeze(["node-a"]),
      appliedSequence: 0,
    });

    const result = await syncMembershipFromPeer({
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

    expect(result.reconcile.status).toBe("behind");
    expect(result.catchUp).not.toBeNull();
    expect(result.catchUp?.finalHeight).toBe(1);
    expect(await f.local.getHeight()).toBe(1);
    expect(result.membership.epoch).toBe(1);
    expect(result.membership.memberIds).toEqual(["node-a", "node-b"]);
    expect(f.membershipService.currentMembership().memberIds).toEqual([
      "node-a",
      "node-b",
    ]);
  });

  it("skips catch-up when the peer claim is already consistent", async () => {
    const f = createFixtures();
    await f.local.appendVerified([f.entry]);
    await f.membershipStore.save({
      clusterId: CLUSTER,
      epoch: 1,
      memberIds: Object.freeze(["node-a", "node-b"]),
      appliedSequence: 1,
    });
    f.membershipService.reconcile({
      epoch: 1,
      memberIds: ["node-a", "node-b"],
      sequence: 1,
    });

    const result = await syncMembershipFromPeer({
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
      now: 2,
    });

    expect(result.reconcile.status).toBe("consistent");
    expect(result.catchUp).toBeNull();
    expect(result.membership.epoch).toBe(1);
  });
});
