import { describe, it, expect } from "vitest";
import { createClusterId } from "@workspace/opennode-domain";
import {
  createHmacSigner,
  createHmacVerifier,
  createInMemoryEventLogStore,
  EventLog,
} from "@workspace/sync-engine";
import {
  MembershipLog,
  createInMemoryMembershipLogStore,
  type PeerMembershipClaim,
} from "./core";
import type { LeaseRecord } from "./leases";

const CLUSTER = "cluster-1";
const SIGNER_ID = "node-a";
const SECRET = "test-secret";

function createFixtures() {
  const signer = createHmacSigner(SIGNER_ID, SECRET);
  const verifier = createHmacVerifier({ [SIGNER_ID]: SECRET });
  const clusterId = createClusterId(CLUSTER);
  const local = new EventLog(createInMemoryEventLogStore(), clusterId, verifier);
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

  return { verifier, clusterId, local, membershipStore, membershipLog };
}

/** Epoch 1 with node-a + node-b already committed at appliedSequence 1. */
async function seedEpochOne(f: ReturnType<typeof createFixtures>) {
  await f.membershipStore.save({
    clusterId: CLUSTER,
    epoch: 1,
    memberIds: Object.freeze(["node-a", "node-b"]),
    appliedSequence: 1,
  });
}

/** Epoch 0 with node-a only, nothing applied yet — the pre-commit state. */
async function seedEpochZero(f: ReturnType<typeof createFixtures>) {
  await f.membershipStore.save({
    clusterId: CLUSTER,
    epoch: 0,
    memberIds: Object.freeze(["node-a"]),
    appliedSequence: 0,
  });
}

function claim(overrides: Partial<PeerMembershipClaim> = {}): PeerMembershipClaim {
  return {
    clusterId: CLUSTER,
    epoch: 1,
    memberIds: ["node-a", "node-b"],
    height: 7,
    tipHash: "peer-tip-hash",
    ...overrides,
  };
}

function lease(
  leaseId: string,
  membershipEpoch: number,
  expiresAt: number,
): LeaseRecord {
  return {
    leaseId,
    runId: `run-${leaseId}`,
    attempt: 1,
    workerNodeId: "worker-1",
    membershipEpoch,
    expiresAt,
  };
}

const ADMISSION = {
  proposalId: "proposal-1",
  subjectId: "node-b",
  newEpoch: 1,
  electorateDenominator: 1,
  threshold: 1,
  yesVotes: 1,
  eventId: "event-1",
  correlationId: "corr-1",
} as const;

const EVICTION = {
  proposalId: "proposal-2",
  subjectId: "node-a",
  newEpoch: 2,
  electorateDenominator: 2,
  threshold: 1,
  yesVotes: 1,
  eventId: "event-2",
  correlationId: "corr-2",
} as const;

describe("MembershipLog.reconcilePeer", () => {
  it("reports consistent when epoch and members match, ignoring member order", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    const result = await f.membershipLog.reconcilePeer(
      claim({ memberIds: ["node-b", "node-a"] }),
    );

    expect(result).toMatchObject({
      status: "consistent",
      state: {
        clusterId: CLUSTER,
        epoch: 1,
        memberIds: ["node-a", "node-b"],
        appliedSequence: 1,
      },
    });
  });

  it("reports diverged when the epoch matches but the members differ", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    const result = await f.membershipLog.reconcilePeer(
      claim({ memberIds: ["node-a"] }),
    );

    expect(result).toMatchObject({
      status: "diverged",
      state: { clusterId: CLUSTER, epoch: 1, memberIds: ["node-a", "node-b"] },
    });
  });

  it("reports behind with neededEpoch when the peer claim is at a higher epoch", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    const result = await f.membershipLog.reconcilePeer(claim({ epoch: 4 }));

    expect(result).toMatchObject({
      status: "behind",
      neededEpoch: 4,
      state: { epoch: 1, appliedSequence: 1 },
    });
  });

  it("reports diverged when the peer claim is at a lower epoch", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    const result = await f.membershipLog.reconcilePeer(claim({ epoch: 0 }));

    expect(result).toMatchObject({
      status: "diverged",
      state: { epoch: 1, memberIds: ["node-a", "node-b"] },
    });
  });

  it("rejects a claim that belongs to another cluster", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    await expect(
      f.membershipLog.reconcilePeer(claim({ clusterId: "cluster-2" })),
    ).rejects.toMatchObject({ code: "WRONG_CLUSTER" });
  });

  it("ignores claim height and tipHash when epoch and members match", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    const result = await f.membershipLog.reconcilePeer(
      claim({ height: 999_999, tipHash: "0000000000000000" }),
    );

    expect(result).toMatchObject({ status: "consistent" });
  });
});

describe("MembershipLog fencing", () => {
  it("fencingEpoch returns the committed state epoch", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    expect(await f.membershipLog.fencingEpoch()).toBe(1);
  });

  it("fenceLeases removes only stale leases and returns exactly those", async () => {
    const f = createFixtures();
    await seedEpochOne(f);

    const olderEpoch = lease("lease-older-epoch", 0, 9_000);
    const valid = lease("lease-valid", 1, 9_000);
    const expired = lease("lease-expired", 1, 999);
    f.membershipLog.leases.add(olderEpoch);
    f.membershipLog.leases.add(valid);
    f.membershipLog.leases.add(expired);

    const removed = await f.membershipLog.fenceLeases(1_000);

    expect([...removed].map((l) => l.leaseId).sort()).toEqual([
      "lease-expired",
      "lease-older-epoch",
    ]);
    expect(f.membershipLog.leases.get(valid.leaseId)).toBeDefined();
    expect(f.membershipLog.leases.get(expired.leaseId)).toBeUndefined();
    expect(f.membershipLog.leases.get(olderEpoch.leaseId)).toBeUndefined();
  });
});

describe("MembershipLog commit epoch advance", () => {
  it("commitAdmission advances the epoch by exactly one and admits the subject", async () => {
    const f = createFixtures();
    await seedEpochZero(f);

    await f.membershipLog.commitAdmission({ ...ADMISSION, now: 1_000 });

    expect(await f.membershipLog.getState()).toEqual({
      clusterId: CLUSTER,
      epoch: 1,
      memberIds: ["node-a", "node-b"],
      appliedSequence: 1,
    });
  });

  it("commitEviction advances the epoch by exactly one and removes the subject", async () => {
    const f = createFixtures();
    await seedEpochZero(f);
    await f.membershipLog.commitAdmission({ ...ADMISSION, now: 1_000 });

    await f.membershipLog.commitEviction({ ...EVICTION, now: 2_000 });

    expect(await f.membershipLog.getState()).toEqual({
      clusterId: CLUSTER,
      epoch: 2,
      memberIds: ["node-b"],
      appliedSequence: 2,
    });
  });

  it("commitAdmission rejects a newEpoch that skips ahead", async () => {
    const f = createFixtures();
    await seedEpochZero(f);

    await expect(
      f.membershipLog.commitAdmission({ ...ADMISSION, newEpoch: 3, now: 1_000 }),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_EPOCH_REGRESSION" });
  });

  it("commitAdmission fences older-epoch and expired leases on epoch advance", async () => {
    const f = createFixtures();
    await seedEpochZero(f);

    const olderEpoch = lease("lease-older-epoch", 0, 9_000);
    const valid = lease("lease-valid", 1, 9_000);
    const expired = lease("lease-expired", 1, 100);
    f.membershipLog.leases.add(olderEpoch);
    f.membershipLog.leases.add(valid);
    f.membershipLog.leases.add(expired);

    await f.membershipLog.commitAdmission({ ...ADMISSION, now: 5_000 });

    expect(f.membershipLog.leases.get(olderEpoch.leaseId)).toBeUndefined();
    expect(f.membershipLog.leases.get(expired.leaseId)).toBeUndefined();
    expect(f.membershipLog.leases.get(valid.leaseId)).toBeDefined();
  });
});
