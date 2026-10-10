import { describe, it, expect } from "vitest";
import { renderMetrics } from "@workspace/observability";
import {
  DefaultRetentionPolicy,
  InMemoryAssignmentGate,
  InMemoryCapacityController,
  InMemoryCredentialRevoker,
  NodeLifecycleController,
} from "./controller";

describe("node lifecycle metrics", () => {
  it("emits membership.key_revocation_pending when an eviction revokes credentials", async () => {
    const controller = new NodeLifecycleController({
      gate: new InMemoryAssignmentGate(),
      drainer: { drain: async () => ({ activeAtStart: 0, drained: 0, relinquished: 0 }) },
      credentials: new InMemoryCredentialRevoker(),
      leases: { invalidate: async () => 0 },
      capacity: new InMemoryCapacityController(),
      retention: new DefaultRetentionPolicy(),
      now: () => 1000,
    });

    const report = await controller.handleEviction({ subjectId: "node-x", epoch: 2 });

    expect(report.credentialsRevoked).toBe(true);
    expect(renderMetrics()).toContain("# TYPE membership.key_revocation_pending counter");
    expect(renderMetrics()).toContain("membership.key_revocation_pending 1");
  });
});