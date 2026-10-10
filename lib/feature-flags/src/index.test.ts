import { describe, it, expect } from "vitest";
import { FeatureFlags, FeatureFlagsError } from "./index";

describe("FeatureFlags", () => {
  it("applyOverrides changes a value observable through getMaxConcurrentRuns", () => {
    const flags = new FeatureFlags();
    flags.applyOverrides({ "execution.max_concurrent_runs": 16 });
    expect(flags.getMaxConcurrentRuns()).toBe(16);
  });

  it("invalid override value throws FeatureFlagsError with code INVALID_OVERRIDE", () => {
    const flags = new FeatureFlags();
    expect(() => {
      flags.applyOverrides({ "execution.max_concurrent_runs": 5 });
    }).toThrow(FeatureFlagsError);
    expect(() => {
      flags.applyOverrides({ "execution.max_concurrent_runs": 5 });
    }).toThrow(expect.objectContaining({ code: "INVALID_OVERRIDE" }));
  });

  it("unknown key is ignored and known flags unaffected", () => {
    const flags = new FeatureFlags();
    expect(() => {
      flags.applyOverrides({ "unknown.flag.key": 123 as any });
    }).not.toThrow();
    expect(flags.getMaxConcurrentRuns()).toBe(8);
  });

  it("constructor flags still work", () => {
    const flags = new FeatureFlags({ flags: { "execution.max_concurrent_runs": 4 } });
    expect(flags.getMaxConcurrentRuns()).toBe(4);
  });

  it("re-applying an override replaces the default", () => {
    const flags = new FeatureFlags();
    flags.applyOverrides({ "execution.max_concurrent_runs": 16 });
    expect(flags.getMaxConcurrentRuns()).toBe(16);
    flags.applyOverrides({ "execution.max_concurrent_runs": 32 });
    expect(flags.getMaxConcurrentRuns()).toBe(32);
  });

  it("kill-switch state preserved across an in-place override", () => {
    const flags = new FeatureFlags({ enableKillSwitch: true });
    flags.activateKillSwitch("test", "tester");
    flags.applyOverrides({ "execution.max_concurrent_runs": 16 });
    expect(flags.isNewExecutionAllowed()).toBe(false);
    expect(flags.getKillSwitch().isEnabled()).toBe(true);
  });
});
