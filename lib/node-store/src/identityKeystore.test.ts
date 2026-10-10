import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
  const state = {
    existingIdentity: [] as Array<{ nodeId: string }>,
  };
  const db = {
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    }),
    select: () => ({
      from: () => ({ limit: async () => state.existingIdentity }),
    }),
  };
  return { db, state };
});

vi.mock("@workspace/db", () => ({
  db: dbMock.db,
  clusterNodesTable: { id: "clusterNodes.id" },
  localNodeIdentityTable: { singleton: "localNodeIdentity.singleton", nodeId: "localNodeIdentity.nodeId" },
}));

import { ensureNodeIdentity } from "@workspace/opennode-domain";
import { NodeStoreIdentityKeystore } from "./identityKeystore";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "opennode-keystore-"));
  dbMock.state.existingIdentity = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("NodeStoreIdentityKeystore", () => {
  it("returns undefined before anything is saved (first boot)", () => {
    const keystore = new NodeStoreIdentityKeystore(join(dir, "node-identity.json"));
    expect(keystore.load()).toBeUndefined();
  });

  it("round-trips the persisted identity across instances", () => {
    const path = join(dir, "node-identity.json");
    new NodeStoreIdentityKeystore(path).save({ secretKey: "secret-1", nodeId: "node-1" });
    expect(new NodeStoreIdentityKeystore(path).load()).toEqual({ secretKey: "secret-1", nodeId: "node-1" });
  });

  it("creates the identity exactly once and reuses it across boots", async () => {
    const path = join(dir, "node-identity.json");
    const createSecretKey = vi.fn(() => "secret-abc");

    const first = await ensureNodeIdentity(new NodeStoreIdentityKeystore(path), createSecretKey);
    const second = await ensureNodeIdentity(new NodeStoreIdentityKeystore(path), createSecretKey);

    expect(second.nodeId.value).toBe(first.nodeId.value);
    expect(createSecretKey).toHaveBeenCalledTimes(1);
  });

  it("refuses to boot when local_node_identity disagrees with the stored key", async () => {
    const path = join(dir, "node-identity.json");
    await ensureNodeIdentity(new NodeStoreIdentityKeystore(path), () => "secret-abc");

    dbMock.state.existingIdentity = [{ nodeId: "different-node" }];

    await expect(
      ensureNodeIdentity(new NodeStoreIdentityKeystore(path), () => "secret-abc"),
    ).rejects.toMatchObject({ code: "IDENTITY_COLLISION" });
  });
});
