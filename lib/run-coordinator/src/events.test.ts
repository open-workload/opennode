import { describe, expect, it } from "vitest";
import {
  RUN_ATTEMPT_FENCED_KIND,
  RUN_ATTEMPT_OBSERVED_KIND,
  RUN_CANCEL_REQUESTED_KIND,
  RUN_LEASE_GRANTED_KIND,
  RUN_LEASE_RENEWED_KIND,
  RUN_RETRY_REQUESTED_KIND,
  RUN_SUBMITTED_KIND,
  isRunKind,
} from "./events";

describe("run event kinds", () => {
  it("isRunKind recognises every emitted run kind", () => {
    expect(isRunKind(RUN_SUBMITTED_KIND)).toBe(true);
    expect(isRunKind(RUN_LEASE_GRANTED_KIND)).toBe(true);
    expect(isRunKind(RUN_LEASE_RENEWED_KIND)).toBe(true);
    expect(isRunKind(RUN_ATTEMPT_OBSERVED_KIND)).toBe(true);
    expect(isRunKind(RUN_CANCEL_REQUESTED_KIND)).toBe(true);
    expect(isRunKind(RUN_RETRY_REQUESTED_KIND)).toBe(true);
    expect(isRunKind(RUN_ATTEMPT_FENCED_KIND)).toBe(true);
  });

  it("isRunKind rejects foreign kinds", () => {
    expect(isRunKind("membership.epoch_advanced")).toBe(false);
    expect(isRunKind("")).toBe(false);
  });
});