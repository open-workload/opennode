import { describe, it, expect } from "vitest";
import { createNonceCache, createRateLimiter } from "@workspace/peernet/replayProtection";
import { PeerNetError } from "@workspace/peernet/errors";

describe("replayProtection - rate limiter (message floods)", () => {
  it("N calls pass within window, N+1 throws with given code, resets after window", () => {
    const limit = 3;
    const windowMs = 1000;
    const limiter = createRateLimiter(limit, windowMs);
    const now = 1_000_000;

    // N calls pass
    limiter.consume("key-1", now, "HANDSHAKE_RATE_LIMITED");
    limiter.consume("key-1", now + 100, "HANDSHAKE_RATE_LIMITED");
    limiter.consume("key-1", now + 500, "HANDSHAKE_RATE_LIMITED");

    // N+1 throws with given code
    expect(() => limiter.consume("key-1", now + 800, "HANDSHAKE_RATE_LIMITED")).toThrowError(
      PeerNetError,
    );
    try {
      limiter.consume("key-1", now + 800, "HANDSHAKE_RATE_LIMITED");
    } catch (err) {
      expect(err).toMatchObject({ code: "HANDSHAKE_RATE_LIMITED" });
    }

    // Reset after window
    limiter.consume("key-1", now + windowMs, "DISCOVERY_RATE_LIMITED");
  });

  it("rate limit resets when window advances", () => {
    const limiter = createRateLimiter(2, 100);
    const now = 5000;
    limiter.consume("peer-x", now, "DISCOVERY_RATE_LIMITED");
    limiter.consume("peer-x", now + 10, "DISCOVERY_RATE_LIMITED");
    expect(() => limiter.consume("peer-x", now + 20, "DISCOVERY_RATE_LIMITED")).toThrow();
    // Next window - should pass
    limiter.consume("peer-x", now + 100, "DISCOVERY_RATE_LIMITED");
  });

  it("different keys have independent limits", () => {
    const limiter = createRateLimiter(1, 1000);
    const now = 100;
    limiter.consume("a", now, "HANDSHAKE_RATE_LIMITED");
    expect(() => limiter.consume("a", now + 10, "HANDSHAKE_RATE_LIMITED")).toThrow();
    // b should still be allowed
    limiter.consume("b", now + 10, "HANDSHAKE_RATE_LIMITED");
  });
});

describe("replayProtection - nonce cache (replay)", () => {
  it("first use returns true, replay returns false, expired nonce is reusable", () => {
    const cache = createNonceCache(10);
    const now = 10_000;
    const expiresAt = now + 5000;

    // first use
    expect(cache.checkAndRecord("nonce-1", now, expiresAt)).toBe(true);
    // replay
    expect(cache.checkAndRecord("nonce-1", now + 100, expiresAt)).toBe(false);

    // expired nonce reusable
    const expiredNonce = "nonce-expired";
    expect(cache.checkAndRecord(expiredNonce, now, now + 1)).toBe(true);
    // after expiry
    expect(cache.checkAndRecord(expiredNonce, now + 2, now + 100)).toBe(true);
  });

  it("evicts oldest at capacity", () => {
    const cache = createNonceCache(2);
    const now = 0;
    expect(cache.checkAndRecord("n1", now, now + 1000)).toBe(true);
    expect(cache.checkAndRecord("n2", now, now + 1000)).toBe(true);
    expect(cache.checkAndRecord("n3", now, now + 1000)).toBe(true);
    // n1 should be evicted (oldest); n2,n3 remain
    expect(cache.checkAndRecord("n1", now, now + 1000)).toBe(true); // evicts oldest (n2) to make room
    expect(cache.checkAndRecord("n3", now, now + 1000)).toBe(false); // n3 still there
  });

  it("empty nonce throws HANDSHAKE_REPLAYED", () => {
    const cache = createNonceCache(10);
    expect(() => cache.checkAndRecord("", 0, 100)).toThrowError(PeerNetError);
    try {
      cache.checkAndRecord("", 0, 100);
    } catch (err) {
      expect(err).toMatchObject({ code: "HANDSHAKE_REPLAYED" });
    }
  });
});
