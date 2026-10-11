/**
 * API-02 operation policy: the role model and the total operation ─▶ required
 * role map. The unit test compares OPERATION_ROLES against the operationIds in
 * lib/api-spec/openapi.yaml, so a spec change fails until the map is updated.
 *
 *   openapi.yaml operationIds ──▶ OPERATION_ROLES (exactly one role each)
 *                                        │
 *   requiredRoleFor(op) ◀────────────────┘
 *          │
 *          ▼  Role = viewer │ operator │ admin (hierarchy, enforced by requireRole)
 */

export type Role = "viewer" | "operator" | "admin";

export const ROLES: readonly Role[] = ["viewer", "operator", "admin"];

export const OPERATION_ROLES = {
  healthCheck: "viewer",

  getDashboardSummary: "viewer",
  listNodes: "viewer",
  listActivity: "viewer",

  listMembershipProposals: "viewer",
  createMembershipProposal: "operator",
  getMembershipProposal: "viewer",
  castMembershipVote: "operator",
  submitEvictionResponse: "operator",
  requestNodeLeave: "operator",
  getMembershipStatus: "viewer",

  listPeerStatus: "viewer",

  listRuns: "viewer",
  submitRun: "operator",
  preflightRun: "operator",
  getRun: "viewer",
  getRunLogs: "viewer",
  cancelRun: "operator",
  streamRunLogs: "viewer",
  listRunArtifacts: "viewer",
  getRunArtifact: "viewer",
  retryRun: "operator",
  reconcileRuns: "operator",

  getFeatureFlags: "viewer",
  updateFeatureFlags: "admin",
  activateKillSwitch: "admin",
  deactivateKillSwitch: "admin",
} as const satisfies Record<string, Role>;

export type OperationId = keyof typeof OPERATION_ROLES;

export function requiredRoleFor(operationId: OperationId): Role {
  return OPERATION_ROLES[operationId];
}
