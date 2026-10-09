import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const CORRELATION_HEADER = "x-request-id";

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const fromPino = (req as Request & { id?: string | number }).id;
  const incoming = req.header(CORRELATION_HEADER);
  const actorId = res.locals.actorId;
  const requestId =
    typeof fromPino === "string" && fromPino.length > 0
      ? fromPino
      : incoming && incoming.trim().length > 0 && incoming.length <= 128
        ? incoming
        : randomUUID();
  res.locals.requestId = requestId;
  res.locals.actorId = actorId;
  res.setHeader(CORRELATION_HEADER, requestId);
  next();
}

export function requestId(res: Response): string {
  return typeof res.locals.requestId === "string" ? res.locals.requestId : "";
}

export function actorId(res: Response): string | undefined {
  return typeof res.locals.actorId === "string" ? res.locals.actorId : undefined;
}
