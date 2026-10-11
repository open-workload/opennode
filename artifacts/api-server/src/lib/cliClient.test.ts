import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_API_BASE_URL,
  authedFetch,
  buildAuthHeaders,
  resolveApiBaseUrl,
  type CliCredentials,
} from "./cliClient";

const validCreds: CliCredentials = {
  token: "tok-123",
  expiresAt: Date.now() + 60_000,
  apiUrl: "http://creds:1234",
};

const expiredCreds: CliCredentials = {
  token: "tok-old",
  expiresAt: Date.now() - 1_000,
  apiUrl: "http://creds:1234",
};

describe("cliClient (API-15)", () => {
  it("resolves the API base URL from the --api-url flag first", () => {
    expect(
      resolveApiBaseUrl({ flagUrl: "http://flag", envUrl: "http://env", creds: validCreds }),
    ).toBe("http://flag");
  });

  it("falls back to OPENNODE_API_URL when no flag is given", () => {
    expect(resolveApiBaseUrl({ envUrl: "http://env", creds: validCreds })).toBe("http://env");
  });

  it("falls back to stored credentials, then the default", () => {
    expect(resolveApiBaseUrl({ creds: validCreds })).toBe("http://creds:1234");
    expect(resolveApiBaseUrl({})).toBe(DEFAULT_API_BASE_URL);
  });

  it("adds a Bearer header only while the token is unexpired", () => {
    expect(buildAuthHeaders(validCreds, { Accept: "text/event-stream" })).toEqual({
      Accept: "text/event-stream",
      Authorization: "Bearer tok-123",
    });
    expect(buildAuthHeaders(expiredCreds, { Accept: "text/event-stream" })).toEqual({
      Accept: "text/event-stream",
    });
    expect(buildAuthHeaders(null)).toEqual({});
  });

  it("sends the streaming request with the Bearer header", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await authedFetch("http://api/api/runs/logs/stream?runId=r1", validCreds, {
        headers: { Accept: "text/event-stream" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://api/api/runs/logs/stream?runId=r1",
        expect.objectContaining({
          headers: { Accept: "text/event-stream", Authorization: "Bearer tok-123" },
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
