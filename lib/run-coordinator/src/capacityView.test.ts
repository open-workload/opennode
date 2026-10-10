import { describe, expect, it } from "vitest";
import { deriveExcludedNodeIds, type CapacityView } from "./capacityView";

function view(overrides: Partial<CapacityView> = {}): CapacityView {
  return {
    committedMemberIds: new Set<string>(),
    quarantined: new Set<string>(),
    draining: new Set<string>(),
    unhealthy: new Set<string>(),
    ...overrides,
  };
}

describe("deriveExcludedNodeIds", () => {
  it("unions committed, quarantined, draining, and unhealthy sets", () => {
    const excluded = deriveExcludedNodeIds(
      view({
        committedMemberIds: new Set(["m1"]),
        quarantined: new Set(["q1"]),
        draining: new Set(["d1"]),
        unhealthy: new Set(["u1"]),
      }),
    );
    expect(excluded.sort()).toEqual(["d1", "m1", "q1", "u1"]);
  });

  it("dedupes ids present in more than one set", () => {
    const excluded = deriveExcludedNodeIds(
      view({
        committedMemberIds: new Set(["n1"]),
        quarantined: new Set(["n1", "n2"]),
        draining: new Set(["n2"]),
        unhealthy: new Set(["n1"]),
      }),
    );
    expect(excluded.sort()).toEqual(["n1", "n2"]);
  });

  it("returns [] for an empty view", () => {
    expect(deriveExcludedNodeIds(view())).toEqual([]);
  });
});
