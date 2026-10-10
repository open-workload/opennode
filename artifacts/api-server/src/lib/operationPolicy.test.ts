import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATION_ROLES, ROLES, requiredRoleFor } from "./operationPolicy";

const SPEC_URL = new URL("../../../../lib/api-spec/openapi.yaml", import.meta.url);
const spec = readFileSync(SPEC_URL, "utf8");
const specOperationIds = [...spec.matchAll(/operationId:[ \t]*(\S+)/g)].map((match) => match[1]);

describe("operationPolicy (API-02)", () => {
  it("reads a non-trivial, duplicate-free operation set from the OpenAPI spec", () => {
    expect(specOperationIds.length).toBeGreaterThanOrEqual(20);
    expect(new Set(specOperationIds).size).toBe(specOperationIds.length);
  });

  it("maps every spec operation to exactly one required role", () => {
    expect(Object.keys(OPERATION_ROLES).sort()).toEqual([...new Set(specOperationIds)].sort());
  });

  it("uses only roles from the viewer/operator/admin role model", () => {
    expect([...ROLES].sort()).toEqual(["admin", "operator", "viewer"]);
    for (const [operationId, role] of Object.entries(OPERATION_ROLES)) {
      expect(ROLES, operationId).toContain(role);
    }
  });

  it("requires admin for flag and kill-switch mutations", () => {
    expect(requiredRoleFor("updateFeatureFlags")).toBe("admin");
    expect(requiredRoleFor("activateKillSwitch")).toBe("admin");
    expect(requiredRoleFor("deactivateKillSwitch")).toBe("admin");
  });

  it("requires operator for run and membership mutations", () => {
    expect(requiredRoleFor("submitRun")).toBe("operator");
    expect(requiredRoleFor("cancelRun")).toBe("operator");
    expect(requiredRoleFor("createMembershipProposal")).toBe("operator");
    expect(requiredRoleFor("castMembershipVote")).toBe("operator");
    expect(requiredRoleFor("requestNodeLeave")).toBe("operator");
  });

  it("requires viewer for reads", () => {
    expect(requiredRoleFor("listNodes")).toBe("viewer");
    expect(requiredRoleFor("getDashboardSummary")).toBe("viewer");
    expect(requiredRoleFor("listRuns")).toBe("viewer");
    expect(requiredRoleFor("getFeatureFlags")).toBe("viewer");
    expect(requiredRoleFor("healthCheck")).toBe("viewer");
  });
});
