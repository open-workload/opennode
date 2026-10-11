import { afterEach, describe, expect, it } from "vitest";
import { FaultType, globalFailureInjector, type FaultPointRegistration } from "./injector";
import { clearFaultPoints, registerFaultPoints } from "./registry";

const point: FaultPointRegistration = {
  name: "registry-test.operation",
  subsystem: "registry-test",
  description: "Operation used to verify registry wiring",
  supportedFaultTypes: [FaultType.Error],
};

describe("fault point registry", () => {
  afterEach(() => {
    clearFaultPoints();
    globalFailureInjector.reset();
  });

  it("registers a fault point on the global injector so inject() reaches it", async () => {
    registerFaultPoints([point]);
    globalFailureInjector.enable();
    globalFailureInjector.createInjection(point.name, {
      type: FaultType.Error,
      probability: 1.0,
      errorMessage: "injected from registry",
    });

    await expect(globalFailureInjector.inject(point.name, async () => "ran")).rejects.toThrow(
      "injected from registry",
    );
  });

  it("still rejects an injection at an unregistered fault point", () => {
    expect(() =>
      globalFailureInjector.createInjection("registry-test.missing", { type: FaultType.Error }),
    ).toThrow(/not registered/);
  });
});
