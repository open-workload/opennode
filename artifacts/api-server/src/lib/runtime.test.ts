import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ??= "postgresql://opennode:opennode@localhost:5432/opennode_test";

const MIRRORED_RUN_ID = "db-run-1";

const nodeStoreModule = vi.hoisted(() => {
  const mirroredRow = {
    id: "db-run-1",
    clientRequestId: "actor-1:client-1",
    name: "smoke",
    mode: "diagnostic",
    image: null,
    command: [],
    status: "queued",
    executionMode: "built_in_diagnostic",
    submittedBy: "actor-1",
    submittedViaNodeId: "actor-1",
    workerNodeId: null,
    attemptCount: 0,
    resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
    networkPolicy: "deny_all",
    failureReason: null,
    requestFingerprint: "fp",
  };

  class FakeDrizzleNodeStore {
    private readonly runs = new Map<string, unknown>([[mirroredRow.id, mirroredRow]]);
    async getLocalNodeId(): Promise<string> {
      return "local-test-node";
    }
    async listNodeIdentities(): Promise<unknown[]> {
      return [];
    }
    async submitRun(): Promise<{ run: typeof mirroredRow; created: boolean }> {
      return { run: mirroredRow, created: true };
    }
    async getRun(runId: string): Promise<unknown | null> {
      return this.runs.get(runId) ?? null;
    }
    async recordAudit(): Promise<unknown> {
      return {};
    }
  }

  class FakeIdentityKeystore {
    private identity: { secretKey: string; nodeId: string } | undefined;
    load(): { secretKey: string; nodeId: string } | undefined {
      return this.identity;
    }
    save(identity: { secretKey: string; nodeId: string }): void {
      this.identity = identity;
    }
  }

  return { FakeDrizzleNodeStore, FakeIdentityKeystore };
});

const dbModule = vi.hoisted(() => ({
  db: {
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
    select: () => ({ from: () => ({ limit: async () => [] as unknown[] }) }),
  },
}));

vi.mock("@workspace/db", () => ({
  db: dbModule.db,
  clusterNodesTable: { id: "clusterNodes.id" },
  localNodeIdentityTable: { singleton: "localNodeIdentity.singleton", nodeId: "localNodeIdentity.nodeId" },
}));

vi.mock("@workspace/node-store", () => ({
  DrizzleNodeStore: nodeStoreModule.FakeDrizzleNodeStore,
  NodeStoreIdentityKeystore: nodeStoreModule.FakeIdentityKeystore,
}));

const { getGovernance, getRunCoordinator, nodeStore } = await import("./runtime");

describe("getRunCoordinator", () => {
  it("mirrors a submitted run into the node store so dbRunId is assigned", async () => {
    const coordinator = await getRunCoordinator();
    const { run } = await coordinator.submit({
      clientKey: "actor-1:client-1",
      actorId: "actor-1",
      spec: {
        name: "smoke",
        mode: "built-in-diagnostic",
        image: null,
        resources: { cpuMilli: 100, memoryMiB: 128, diskMiB: 64, timeoutSeconds: 60 },
        expectedOutputBytes: 0,
        secretRefs: [],
        requiredCapabilities: [],
        networkPolicy: "deny_all",
        sideEffectClass: "at-least-once",
        tenantId: "default",
        projectId: "default",
      },
      correlationId: "req-1",
      now: Date.now(),
    });

    const committed = (await coordinator.getState()).runs.find((r) => r.runId === run.runId);
    expect(committed?.dbRunId).toBe(MIRRORED_RUN_ID);

    const dbRun = committed?.dbRunId ? await nodeStore.getRun(committed.dbRunId) : null;
    expect(dbRun).not.toBeNull();
  });

  it("boots one verified node identity and uses it as the signer identity", async () => {
    const g = await getGovernance();
    expect(g.localNodeId).toBeTruthy();
    expect(g.signerNodeId).toBe(g.localNodeId);
  });
});
