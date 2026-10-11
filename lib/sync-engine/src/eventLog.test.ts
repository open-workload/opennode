import { describe, it, expect } from "vitest";
import {
  createClusterEvent,
  createClusterId,
  type ClusterEvent,
} from "@workspace/opennode-domain";
import { SyncEngineError, type SyncEngineErrorCode } from "./errors";
import {
  entryHash,
  signEntry,
  validateEntry,
  type EntryContext,
  type SignedLogEntry,
} from "./eventLog";
import { createHmacSigner, createHmacVerifier, type Signer } from "./signing";
import { sha256Hex } from "./hash";

const SIGNER_ID = "node-a";
const SECRET = "test-secret";
const CLUSTER = "cluster-1";

function createFixtures() {
  const signer = createHmacSigner(SIGNER_ID, SECRET);
  const verifier = createHmacVerifier({ [SIGNER_ID]: SECRET });
  const clusterId = createClusterId(CLUSTER);
  const event = createClusterEvent({
    eventId: "event-1",
    clusterId,
    sequence: 0,
    epoch: 1,
    kind: "oc.test",
    correlationId: "corr-1",
    payload: { type: "test", value: 1 },
  });
  const entry = signEntry(event, null, signer);
  return { signer, verifier, clusterId, event, entry };
}

function createContext(
  verifier: EntryContext["verifier"],
  clusterId: EntryContext["clusterId"],
  overrides: Partial<EntryContext> = {},
): EntryContext {
  return {
    clusterId,
    verifier,
    expectedSequence: 0,
    expectedPrevHash: null,
    previousEpoch: null,
    ...overrides,
  };
}

function entryErrorCode(
  candidate: SignedLogEntry,
  ctx: EntryContext,
): SyncEngineErrorCode | undefined {
  try {
    validateEntry(candidate, ctx);
    return undefined;
  } catch (error) {
    if (error instanceof SyncEngineError) return error.code;
    throw error;
  }
}

function signConsistentEvent(
  event: ClusterEvent,
  signer: Signer,
  prevHash: string | null = null,
): SignedLogEntry {
  const hash = entryHash(event, prevHash);
  return {
    schemaVersion: 1,
    event,
    prevHash,
    hash,
    signerId: signer.signerId,
    signature: signer.sign(hash),
  };
}

describe("validateEntry malformed events", () => {
  it("accepts a well-formed signed entry", () => {
    const { verifier, clusterId, entry } = createFixtures();
    expect(entryErrorCode(entry, createContext(verifier, clusterId))).toBe(
      undefined,
    );
  });

  it("rejects an unsupported entry schema version (eventLog.ts:77)", () => {
    const { verifier, clusterId, entry } = createFixtures();
    const candidate = { ...entry, schemaVersion: 2 } as unknown as SignedLogEntry;
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "SCHEMA_VERSION_MISMATCH",
    );
  });

  it("rejects an unsupported event schema version (eventLog.ts:83)", () => {
    const { signer, verifier, clusterId, event } = createFixtures();
    const newerEvent = {
      ...event,
      schemaVersion: 2,
    } as unknown as ClusterEvent;
    const candidate = signConsistentEvent(newerEvent, signer);
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "SCHEMA_VERSION_MISMATCH",
    );
  });

  it("rejects an event from a different cluster (eventLog.ts:89)", () => {
    const { signer, verifier, clusterId } = createFixtures();
    const otherEvent = createClusterEvent({
      eventId: "event-other",
      clusterId: createClusterId("cluster-2"),
      sequence: 0,
      epoch: 1,
      kind: "oc.test",
      correlationId: "corr-other",
      payload: { type: "test", value: 2 },
    });
    const candidate = signEntry(otherEvent, null, signer);
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "WRONG_CLUSTER",
    );
  });

  it("rejects an unexpected sequence (eventLog.ts:95)", () => {
    const { signer, verifier, clusterId, event } = createFixtures();
    const ahead = {
      ...event,
      sequence: 1,
    } as unknown as ClusterEvent;
    const candidate = signConsistentEvent(ahead, signer);
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "SEQUENCE_GAP",
    );
  });

  it("rejects a prevHash that does not link to the previous entry (eventLog.ts:101)", () => {
    const { signer, verifier, clusterId, event } = createFixtures();
    const candidate = signConsistentEvent(event, signer, sha256Hex("other-tip"));
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "BROKEN_HASH_LINK",
    );
  });

  it("rejects an epoch that regresses (eventLog.ts:107)", () => {
    const { signer, verifier, clusterId, event } = createFixtures();
    const young = { ...event, epoch: 1 } as unknown as ClusterEvent;
    const candidate = signConsistentEvent(young, signer);
    expect(
      entryErrorCode(
        candidate,
        createContext(verifier, clusterId, { previousEpoch: 5 }),
      ),
    ).toBe("EPOCH_REGRESSION");
  });

  it("rejects a hash that does not match the canonical payload (eventLog.ts:113)", () => {
    const { signer, verifier, clusterId, entry } = createFixtures();
    const tamperedHash = sha256Hex("tampered");
    const candidate = {
      ...entry,
      hash: tamperedHash,
      signature: signer.sign(tamperedHash),
    } as SignedLogEntry;
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "BROKEN_HASH_LINK",
    );
  });
});

describe("validateEntry signature failures", () => {
  it("rejects a tampered signature (eventLog.ts:120)", () => {
    const { verifier, clusterId, entry } = createFixtures();
    const candidate = { ...entry, signature: "00".repeat(32) } as SignedLogEntry;
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "SIGNATURE_INVALID",
    );
  });

  it("rejects a signature signed by an unknown signer", () => {
    const { verifier, clusterId, entry } = createFixtures();
    const candidate = {
      ...entry,
      signerId: "node-unknown",
    } as SignedLogEntry;
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "SIGNATURE_INVALID",
    );
  });
});

describe("validateEntry protocol downgrade", () => {
  it("rejects a downgraded entry schema version (eventLog.ts:77)", () => {
    const { signer, verifier, clusterId, event } = createFixtures();
    const candidate = signConsistentEvent(event, signer);
    const downgraded = {
      ...candidate,
      schemaVersion: 0,
    } as unknown as SignedLogEntry;
    expect(entryErrorCode(downgraded, createContext(verifier, clusterId))).toBe(
      "SCHEMA_VERSION_MISMATCH",
    );
  });

  it("rejects a downgraded event schema version (eventLog.ts:83)", () => {
    const { signer, verifier, clusterId, event } = createFixtures();
    const downgradedEvent = {
      ...event,
      schemaVersion: 0,
    } as unknown as ClusterEvent;
    const candidate = signConsistentEvent(downgradedEvent, signer);
    expect(entryErrorCode(candidate, createContext(verifier, clusterId))).toBe(
      "SCHEMA_VERSION_MISMATCH",
    );
  });
});
