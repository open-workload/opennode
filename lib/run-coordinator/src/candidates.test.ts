import { describe, expect, it } from "vitest";
import {
  eligibleCandidates,
  selectCandidate,
  type NodeCapability,
} from "./candidates";
import { RunCoordinatorError } from "./errors";

const CAPABILITIES: readonly NodeCapability[] = [
  { nodeId: "n1", capabilities: ["gpu"] },
  { nodeId: "n2", capabilities: ["gpu"] },
  { nodeId: "n3", capabilities: ["cpu"] },
];

const BASE = {
  runId: "run-1",
  attempt: 1,
  members: ["n1", "n2", "n3"],
  capabilities: CAPABILITIES,
  requiredCapabilities: ["gpu"],
} as const;

describe("eligibleCandidates (no exclusions parameter)", () => {
  it("returns members holding every required capability, sorted", () => {
    expect(eligibleCandidates(BASE)).toEqual(["n1", "n2"]);
  });

  it("skips members with no capability record or missing capabilities", () => {
    const eligible = eligibleCandidates({
      ...BASE,
      members: ["n1", "n3", "ghost"],
      requiredCapabilities: ["gpu", "storage"],
    });
    expect(eligible).toEqual([]);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(eligibleCandidates(BASE))).toBe(true);
  });

  it("ignores a caller-supplied excludedNodeIds field (RUN-18)", () => {
    const steered = {
      ...BASE,
      excludedNodeIds: ["n1"],
    } as Parameters<typeof eligibleCandidates>[0];
    expect(eligibleCandidates(steered)).toEqual(["n1", "n2"]);
  });
});

describe("selectCandidate (no exclusions parameter)", () => {
  it("returns a candidate from the eligible set", () => {
    const eligible = eligibleCandidates(BASE);
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(eligible).toContain(
        selectCandidate({ ...BASE, runId: `run-${attempt}`, attempt }),
      );
    }
  });

  it("never selects a member that fails the capability filter", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const chosen = selectCandidate({ ...BASE, attempt });
      expect(["n1", "n2"]).toContain(chosen);
    }
  });

  it("is deterministic for the same runId and attempt", () => {
    const first = selectCandidate(BASE);
    const second = selectCandidate({ ...BASE });
    expect(second).toBe(first);
  });

  it("does not depend on member ordering", () => {
    const chosen = selectCandidate(BASE);
    const reversed = selectCandidate({ ...BASE, members: ["n3", "n2", "n1"] });
    expect(reversed).toBe(chosen);
  });

  it("throws NO_ELIGIBLE_WORKER when no member qualifies", () => {
    expect(() =>
      selectCandidate({
        ...BASE,
        requiredCapabilities: ["fpga"],
      }),
    ).toThrow(RunCoordinatorError);
    try {
      selectCandidate({ ...BASE, requiredCapabilities: ["fpga"] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as RunCoordinatorError).code).toBe("NO_ELIGIBLE_WORKER");
    }
  });

  it("cannot be steered by a caller-supplied excludedNodeIds field (RUN-18)", () => {
    const winner = selectCandidate(BASE);
    const steered = {
      ...BASE,
      excludedNodeIds: [winner],
    } as Parameters<typeof selectCandidate>[0];
    expect(selectCandidate(steered)).toBe(winner);
  });
});
