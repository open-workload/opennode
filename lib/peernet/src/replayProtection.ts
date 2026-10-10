/**
 * Fixed-window rate limiter plus a nonce cache for handshake/discovery traffic.
 *
 *   nonce ──▶ sweep expired ──▶ seen? ──yes──▶ false (replay)
 *                          └──no──▶ evict oldest at cap ──▶ record ──▶ true
 *
 *   key ──▶ current window ──▶ count >= limit? ──yes──▶ PeerNetError
 *                                    └──no──▶ count++ ──▶ remaining allowance
 *
 * createNonceCache is wired into api-server peerAuth; createRateLimiter has no caller.
 */
import { PeerNetError } from "./errors";

export interface NonceCache {
  /** Returns true the first time a nonce is seen within the window. */
  checkAndRecord(nonce: string, now: number, expiresAt: number): boolean;
  readonly size: number;
}

export function createNonceCache(maxEntries = 4096): NonceCache {
  const seen = new Map<string, number>();
  return {
    checkAndRecord(nonce: string, now: number, expiresAt: number): boolean {
      if (typeof nonce !== "string" || nonce.trim().length === 0) {
        throw new PeerNetError("HANDSHAKE_REPLAYED", "Nonce must not be empty.");
      }
      for (const [key, expiry] of seen) {
        if (expiry <= now) seen.delete(key);
      }
      if (seen.has(nonce)) return false;
      if (seen.size >= maxEntries) {
        const oldest = seen.keys().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.set(nonce, expiresAt);
      return true;
    },
    get size() {
      return seen.size;
    },
  };
}

export interface RateLimiter {
  /** Throws a PeerNetError when the allowance for `key` is exhausted. */
  consume(key: string, now: number, code: "HANDSHAKE_RATE_LIMITED" | "DISCOVERY_RATE_LIMITED"): void;
  /** Remaining allowance in the current window for `key`. */
  remaining(key: string, now: number): number;
}

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new PeerNetError("INVALID_IDENTIFIER", "Rate limit must be positive.");
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new PeerNetError("INVALID_IDENTIFIER", "Rate window must be positive.");
  }
  const buckets = new Map<string, { windowStart: number; count: number }>();
  const windowOf = (now: number) => Math.floor(now / windowMs) * windowMs;
  return {
    consume(key, now, code) {
      const start = windowOf(now);
      const bucket = buckets.get(key);
      if (!bucket || bucket.windowStart !== start) {
        buckets.set(key, { windowStart: start, count: 1 });
        return;
      }
      if (bucket.count >= limit) {
        throw new PeerNetError(code, `Rate limit exceeded for ${key}.`);
      }
      bucket.count += 1;
    },
    remaining(key, now) {
      const bucket = buckets.get(key);
      if (!bucket || bucket.windowStart !== windowOf(now)) return limit;
      return Math.max(0, limit - bucket.count);
    },
  };
}
