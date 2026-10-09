import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { sameOriginWriteGuard } from "./sameOriginWriteGuard";

function invoke(method: string, headers: Record<string, string>) {
  const req = {
    method,
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const res = { status, json } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  sameOriginWriteGuard(req, res, next);
  return { status, json, next };
}

describe("sameOriginWriteGuard", () => {
  it("allows a same-origin cookie-authenticated write", () => {
    const result = invoke("POST", {
      origin: "https://opennode.example",
      host: "opennode.example",
      "sec-fetch-site": "same-origin",
    });

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it("rejects cross-origin and missing-origin cookie writes", () => {
    const crossOrigin = invoke("POST", {
      origin: "https://attacker.example",
      host: "opennode.example",
      "sec-fetch-site": "cross-site",
    });
    const missingOrigin = invoke("POST", { host: "opennode.example" });

    expect(crossOrigin.status).toHaveBeenCalledWith(403);
    expect(missingOrigin.status).toHaveBeenCalledWith(403);
    expect(crossOrigin.next).not.toHaveBeenCalled();
    expect(missingOrigin.next).not.toHaveBeenCalled();
  });

  it("allows safe reads and bearer-authenticated CLI writes", () => {
    const read = invoke("GET", { host: "opennode.example" });
    const cliWrite = invoke("POST", {
      authorization: "Bearer clerk-token",
    });

    expect(read.next).toHaveBeenCalledOnce();
    expect(cliWrite.next).toHaveBeenCalledOnce();
  });
});
