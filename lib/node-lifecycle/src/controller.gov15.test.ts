import { describe, it, expect } from "vitest";
import {
  DefaultRetentionPolicy,
  InMemoryAssignmentGate,
  InMemoryCapacityController,
  InMemoryCredentialRevoker,
  NodeLifecycleController,
} from "./controller";

describe("GOV-15 assignment gate scoping", () => {
  it("stops new assignments only for the given subject and cause", () => {
    const gate = new InMemoryAssignmentGate();

    gate.stopNewAssignments("node-a", "eviction");

    expect(gate.acceptsNewAssignments("node-a")).toBe(false);
    expect(gate.acceptsNewAssignments("node-b")).toBe(true);
  });

  it("resumes a stopped scope through the documented re-enable path", () => {
    const gate = new InMemoryAssignmentGate();

    gate.stopNewAssignments("node-a", "eviction");
    expect(gate.acceptsNewAssignments("node-a")).toBe(false);

    gate.resumeAssignments("node-a", "eviction");
    expect(gate.acceptsNewAssignments("node-a")).toBe(true);
  });
});

function makeController() {
  const gate = new InMemoryAssignmentGate();
  const credentials = new InMemoryCredentialRevoker();
  const capacity = new InMemoryCapacityController();
  const controller = new NodeLifecycleController({
    gate,
    drainer: { drain: async () => ({ activeAtStart: 0, drained: 0, relinquished: 0 }) },
    credentials,
    leases: { invalidate: async () => 0 },
    capacity,
    retention: new DefaultRetentionPolicy(),
    now: () => 1000,
  });
  return { controller, gate, credentials, capacity };
}

describe("GOV-15 eviction side effects", () => {
  it("evicts a remote peer without disabling the local node", async () => {
    const { controller, gate, credentials, capacity } = makeController();

    const report = await controller.handleEviction({ subjectId: "node-victim", epoch: 3 });

    expect(report.stoppedNewAssignments).toBe(true);
    expect(controller.acceptsNewAssignments()).toBe(true);
    expect(gate.acceptsNewAssignments("node-victim")).toBe(false);
    expect(gate.acceptsNewAssignments("node-local")).toBe(true);
    expect(credentials.isRevoked("node-victim")).toBe(true);
    expect(capacity.isQuarantined("node-victim")).toBe(true);
  });

  it("fences leases for the evicted subject only", async () => {
    const fenced: Array<{ subject: string; cause: string }> = [];
    const controller = new NodeLifecycleController({
      gate: new InMemoryAssignmentGate(),
      drainer: { drain: async () => ({ activeAtStart: 0, drained: 0, relinquished: 0 }) },
      credentials: new InMemoryCredentialRevoker(),
      leases: {
        invalidate: async (subject, cause) => {
          fenced.push({ subject, cause });
          return 1;
        },
      },
      capacity: new InMemoryCapacityController(),
      retention: new DefaultRetentionPolicy(),
      now: () => 1000,
    });

    const report = await controller.handleEviction({ subjectId: "node-victim", epoch: 5 });

    expect(report.leasesInvalidated).toBe(1);
    expect(fenced).toEqual([{ subject: "node-victim", cause: "eviction" }]);
  });

  it("lets the local node resume new assignments after its own leave", async () => {
    const { controller } = makeController();

    await controller.handleVoluntaryLeave({
      subjectId: "node-local",
      clusterId: "cluster-1",
      previousEpoch: 1,
      newEpoch: 2,
      signerNodeId: "node-local",
      signature: "sig",
    });
    expect(controller.acceptsNewAssignments()).toBe(false);

    controller.resumeAssignments("node-local", "voluntary-leave");
    expect(controller.acceptsNewAssignments()).toBe(true);
  });
});

describe("GOV-15 voluntary leave side effects", () => {
  it("revokes credentials and quarantines capacity on voluntary leave", async () => {
    const { controller, credentials, capacity } = makeController();

    const report = await controller.handleVoluntaryLeave({
      subjectId: "node-local",
      clusterId: "cluster-1",
      previousEpoch: 1,
      newEpoch: 2,
      signerNodeId: "node-local",
      signature: "sig",
    });

    expect(report.credentialsRevoked).toBe(true);
    expect(report.capacityQuarantined).toBe(true);
    expect(credentials.isRevoked("node-local")).toBe(true);
    expect(capacity.isQuarantined("node-local")).toBe(true);
  });
});

