/**
 * API-02 role gate: runs before a route handler so authorization is evaluated
 * before any protected state is read. Roles come from the verified credential
 * (`req.auth.claims.roles`, set by Clerk session claims) — never from headers
 * or the request body. GAP: production Clerk session claims do not yet carry a
 * `roles` field, so every request fails closed (403) until claims are
 * provisioned with one; tests inject roles via a mocked `req.auth`.
 *
 *   no req.auth ─▶ 401 UNAUTHORIZED (authn never happened; auth.ts owns this)
 *   claims.roles missing / not known role names ─▶ 403 FORBIDDEN (fail closed)
 *   max(role rank) >= required rank ─▶ next()
 *   otherwise ─▶ 403 { code: "FORBIDDEN" }
 */

import type { NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "./auth";
import { ROLES, requiredRoleFor, type OperationId, type Role } from "../lib/operationPolicy";

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

function heldRoles(req: Request): Role[] {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) return [];
  const claims = auth.claims as { roles?: unknown } | null | undefined;
  if (!Array.isArray(claims?.roles)) return [];
  return claims.roles.filter((role): role is Role => ROLES.includes(role as Role));
}

export function requireRole(required: Role): <P extends Request["params"] = Request["params"]>(req: Request<P>, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
      return;
    }
    const allowed = heldRoles(req).some((role) => ROLE_RANK[role] >= ROLE_RANK[required]);
    if (!allowed) {
      res.status(403).json({ error: "Forbidden", code: "FORBIDDEN" });
      return;
    }
    next();
  };
}

export function requireRoleFor(operationId: OperationId): <P extends Request["params"] = Request["params"]>(req: Request<P>, res: Response, next: NextFunction) => void {
  return requireRole(requiredRoleFor(operationId));
}