import { describe, it, expect, vi } from "vitest";
import { sha256Hex, verifyChecksum } from "./hash";

describe("verifyChecksum", () => {
  it("accepts a matching checksum", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyChecksum(data, sha256Hex(data))).toBe(true);
  });

  it("rejects a checksum for different data", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    expect(verifyChecksum(data, sha256Hex(new Uint8Array([4, 3, 2, 1])))).toBe(false);
  });

  it("rejects an odd-length checksum instead of truncating it", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const checksum = sha256Hex(data);
    expect(verifyChecksum(data, checksum.slice(1))).toBe(false);
    expect(verifyChecksum(data, `${checksum}a`)).toBe(false);
  });

  it("rejects a same-length non-hex checksum instead of truncating it", () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const checksum = sha256Hex(data);
    expect(verifyChecksum(data, `${checksum.slice(0, 62)}zz`)).toBe(false);
  });

  it("compares digests without short-circuiting on the first mismatch", () => {
    const every = vi.spyOn(Uint8Array.prototype, "every");
    const data = new Uint8Array([1, 2, 3, 4]);
    verifyChecksum(data, sha256Hex(data));
    expect(every).not.toHaveBeenCalled();
    every.mockRestore();
  });
});
