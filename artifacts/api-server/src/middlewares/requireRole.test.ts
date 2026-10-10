import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireRole, requireRoleFor } from "./requireRole";
import type { Role } from "../lib/operationPolicy";

function invoke(required: Role, auth?: { claims: unknown }) {
  const req = (auth === undefined
    ? {}
    : {
        auth: { userId: "user_1", sessionId: "session_1", actorId: "user_1", ...auth },
      }) as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  requireRole(required)(req, res, next);
  return { status, json, next };
}

function withRoles(...roles: unknown[]): { claims: unknown } {
  return { claims: { roles } };
}

describe("requireRole (API-02)", () => {
  it("lets a viewer through a viewer-gated operation", () => {
    const result = invoke("viewer", withRoles("viewer"));
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it("treats the role model as a hierarchy: operator and admin satisfy viewer, admin satisfies operator", () => {
    expect(invoke("viewer", withRoles("operator")).next).toHaveBeenCalledOnce();
    expect(invoke("viewer", withRoles("admin")).next).toHaveBeenCalledOnce();
    expect(invoke("operator", withRoles("admin")).next).toHaveBeenCalledOnce();
  });

  it("denies a principal below the required role with 403 FORBIDDEN", () => {
    const denied = invoke("admin", withRoles("operator"));
    expect(denied.status).toHaveBeenCalledWith(403);
    expect(denied.json).toHaveBeenCalledWith({ error: "Forbidden", code: "FORBIDDEN" });
    expect(denied.next).not.toHaveBeenCalled();

    expect(invoke("operator", withRoles("viewer")).status).toHaveBeenCalledWith(403);
    expect(invoke("viewer", withRoles()).status).toHaveBeenCalledWith(403);
  });

  it("fails closed when the claims carry no roles field", () => {
    const result = invoke("viewer", { claims: { sub: "user_1" } });
    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith({ error: "Forbidden", code: "FORBIDDEN" });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("fails closed when roles is not an array of known role names", () => {
    expect(invoke("viewer", { claims: { roles: "admin" } }).status).toHaveBeenCalledWith(403);
    expect(invoke("viewer", { claims: { roles: ["superuser", 7] } }).status).toHaveBeenCalledWith(403);
    expect(invoke("viewer", { claims: null }).status).toHaveBeenCalledWith(403);
  });

  it("answers 401 UNAUTHORIZED when the auth middleware never ran", () => {
    const result = invoke("viewer");
    expect(result.status).toHaveBeenCalledWith(401);
    expect(result.json).toHaveBeenCalledWith({ error: "Authentication required", code: "UNAUTHORIZED" });
    expect(result.next).not.toHaveBeenCalled();
  });

  it("requireRoleFor gates on the operation's policy role", () => {
    const readAllowed = requireRoleFor("listNodes");
    const req = {
      auth: { userId: "user_1", sessionId: "s", actorId: "user_1", claims: { roles: ["viewer"] } },
    } as unknown as Request;
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn() as unknown as NextFunction;
    readAllowed(req, { status, json } as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();

    const killSwitch = requireRoleFor("activateKillSwitch");
    const deniedNext = vi.fn() as unknown as NextFunction;
    const deniedStatus = vi.fn().mockReturnThis();
    killSwitch(req, { status: deniedStatus, json } as unknown as Response, deniedNext);
    expect(deniedStatus).toHaveBeenCalledWith(403);
    expect(deniedNext).not.toHaveBeenCalled();
  });
});
