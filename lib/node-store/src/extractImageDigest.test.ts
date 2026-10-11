import { describe, expect, it } from "vitest";
import { extractImageDigest } from "./nodeStore";

const DIGEST = "a".repeat(64);

describe("extractImageDigest", () => {
  it("returns the digest for an image pinned by sha256 digest", () => {
    expect(extractImageDigest(`alpine:3.19@sha256:${DIGEST}`)).toBe(`sha256:${DIGEST}`);
  });

  it("returns null for an image without a digest", () => {
    expect(extractImageDigest("alpine:3.19")).toBeNull();
  });

  it("returns null when the image is null", () => {
    expect(extractImageDigest(null)).toBeNull();
  });

  it("returns null for a digest with the wrong length", () => {
    expect(extractImageDigest(`alpine:3.19@sha256:${"a".repeat(63)}`)).toBeNull();
    expect(extractImageDigest(`alpine:3.19@sha256:${"a".repeat(65)}`)).toBeNull();
  });
});
