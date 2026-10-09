import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Clerk session cookies authenticate browser requests, so state-changing
 * requests must prove they came from this artifact's origin. CLI requests use
 * Clerk-verified bearer tokens and do not depend on browser cookies.
 */
export function sameOriginWriteGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  if (req.get("authorization")?.startsWith("Bearer ")) {
    next();
    return;
  }

  const origin = req.get("origin");
  const host = req.get("host");
  const fetchSite = req.get("sec-fetch-site");

  if (!origin || !host || (fetchSite && fetchSite !== "same-origin")) {
    res.status(403).json({ error: "A same-origin browser request is required", code: "CSRF_REJECTED" });
    return;
  }

  try {
    const originUrl = new URL(origin);
    if (!["https:", "http:"].includes(originUrl.protocol) || originUrl.host !== host) {
      res.status(403).json({ error: "A same-origin browser request is required", code: "CSRF_REJECTED" });
      return;
    }
  } catch {
    res.status(403).json({ error: "A valid same-origin request is required", code: "CSRF_REJECTED" });
    return;
  }

  next();
}
