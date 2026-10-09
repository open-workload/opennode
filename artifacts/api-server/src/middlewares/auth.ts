import { getAuth } from "@clerk/express";
import { type NextFunction, type Request, type Response } from "express";

export interface AuthenticatedRequest extends Request {
  auth?: {
    userId: string;
    sessionId: string;
    actorId: string;
    claims: unknown;
  };
}

function readClerkAuth(req: Request): AuthenticatedRequest["auth"] | undefined {
  try {
    const clerkAuth = getAuth(req);
    if (!clerkAuth.userId) return undefined;
    return {
      userId: clerkAuth.userId,
      sessionId: clerkAuth.sessionId ?? "",
      // Never trust a caller-supplied actor header or JWT `azp` as a user ID.
      actorId: clerkAuth.userId,
      claims: clerkAuth.sessionClaims,
    };
  } catch {
    // Missing Clerk middleware is a deployment error; callers are denied rather
    // than falling back to an unverified bearer token.
    return undefined;
  }
}

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const verifiedAuth = readClerkAuth(req);
  if (!verifiedAuth) {
    res.status(401).json({ error: "Authentication required", code: "UNAUTHORIZED" });
    return;
  }
  req.auth = verifiedAuth;
  res.locals.actorId = verifiedAuth.actorId;
  next();
}

export function optionalAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const verifiedAuth = readClerkAuth(req);
  if (verifiedAuth) {
    req.auth = verifiedAuth;
    res.locals.actorId = verifiedAuth.actorId;
  }
  next();
}