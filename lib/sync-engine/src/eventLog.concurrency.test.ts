import { describe, it, expect } from "vitest";
import {
  createClusterEvent,
  createClusterId,
  type ClusterId,
  type ClusterEvent,
} from "@workspace/opennode-domain";
import { SyncEngineError, type SyncEngineErrorCode } from "./errors";
import { EventLog, signEntry, type SignedLogEntry } from "./eventLog";
import { createInMemoryEventLogStore } from "./memory";
import { createHmacSigner, createHmacVerifier, type Signer } from "./signing";

const SIGNER_ID = "node-a";
const SECRET = "test-secret";
const CLUSTER = "cluster-1";

function createLog() {
  const signer = createHmacSigner(SIGNER_ID, SECRET);
  const verifier = createHmacVerifier({ [SIGNER_ID]: SECRET });
  const clusterId = createClusterId(CLUSTER);
  const store = createInMemoryEventLogStore();
  const log = new EventLog(store, clusterId, verifier);
  return { signer, verifier, clusterId, store, log };
}

function createEvent(
  clusterId: ClusterId,
  eventId: string,
  sequence: number,
): ClusterEvent {
  return createClusterEvent({
    eventId,
    clusterId,
    sequence,
    epoch: 1,
    kind: "oc.test",
    correlationId: `corr-${eventId}`,
    payload: { type: "test", value: sequence },
  });
}

function settleErrorCode(
  result: PromiseSettledResult<SignedLogEntry>,
): SyncEngineErrorCode | undefined {
  if (result.status === "fulfilled") return undefined;
  if (result.reason instanceof SyncEngineError) return result.reason.code;
  throw result.reason;
}

async function appendErrorCode(
  log: EventLog,
  event: ClusterEvent,
  signer: Signer,
): Promise<SyncEngineErrorCode | undefined> {
  try {
    await log.appendEvent(event, signer);
    return undefined;
  } catch (error) {
    if (error instanceof SyncEngineError) return error.code;
    throw error;
  }
}

describe("EventLog concurrent appends (CONC-01)", () => {
  it("commits exactly one entry when two appends race for the same tip", async () => {
    const { signer, clusterId, store, log } = createLog();
    const eventA = createEvent(clusterId, "event-a", 0);
    const eventB = createEvent(clusterId, "event-b", 0);

    const results = await Promise.allSettled([
      log.appendEvent(eventA, signer),
      log.appendEvent(eventB, signer),
    ]);

    const codes = results.map(settleErrorCode);
    expect(codes.filter((code) => code === undefined)).toHaveLength(1);
    expect(codes.filter((code) => code === "SEQUENCE_GAP")).toHaveLength(1);
    expect(await store.getHeight()).toBe(1);

    const committed = await store.getRange(0, 1);
    expect(committed).toHaveLength(1);
    const candidateHashes = new Set([
      signEntry(eventA, null, signer).hash,
      signEntry(eventB, null, signer).hash,
    ]);
    expect(candidateHashes.has(committed[0].hash)).toBe(true);
    expect(committed[0].event.sequence).toBe(0);
  });

  it("appends sequentially without serialization side effects", async () => {
    const { signer, clusterId, store, log } = createLog();

    const first = await log.appendEvent(
      createEvent(clusterId, "seq-0", 0),
      signer,
    );
    const second = await log.appendEvent(
      createEvent(clusterId, "seq-1", 1),
      signer,
    );

    expect(await store.getHeight()).toBe(2);
    expect(second.prevHash).toBe(first.hash);
    expect(await log.getEntry(0)).toEqual(first);
    expect(await log.getEntry(1)).toEqual(second);
  });

  it("keeps accepting appends after a rejected one (chain not poisoned)", async () => {
    const { signer, clusterId, store, log } = createLog();

    await log.appendEvent(createEvent(clusterId, "base-0", 0), signer);
    expect(
      await appendErrorCode(log, createEvent(clusterId, "skip-5", 5), signer),
    ).toBe("SEQUENCE_GAP");

    const next = await log.appendEvent(createEvent(clusterId, "base-1", 1), signer);

    expect(await store.getHeight()).toBe(2);
    expect(next.prevHash).toBeDefined();
  });
});
