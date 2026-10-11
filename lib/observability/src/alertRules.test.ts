import { describe, it, expect } from "vitest";
import {
  AlertRuleRegistry,
  AlertSeverity,
  type AlertNotification,
  type AlertRule,
} from "./alertRules";

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "test.rule",
    name: "Test Rule",
    description: "A rule used to exercise the evaluator",
    severity: AlertSeverity.Warning,
    condition: { metricName: "test.metric", operator: "gt", threshold: 10 },
    subsystem: "test",
    enabled: true,
    ...overrides,
  };
}

describe("AlertRuleRegistry durationMs and cooldownMs (OPS-09)", () => {
  it("does not fire on a single sample while durationMs is not yet sustained", () => {
    let now = 1_000_000;
    const registry = new AlertRuleRegistry(() => now);
    registry.register(
      makeRule({
        condition: { metricName: "test.metric", operator: "gt", threshold: 10, durationMs: 1000 },
      }),
    );
    const fired: AlertNotification[] = [];
    registry.addHandler((n) => fired.push(n));

    registry.evaluate("test.metric", 20, {});

    expect(fired).toHaveLength(0);
    expect(registry.getFiringAlerts()).toHaveLength(0);
  });

  it("fires once the condition has been true for durationMs", () => {
    let now = 1_000_000;
    const registry = new AlertRuleRegistry(() => now);
    registry.register(
      makeRule({
        condition: { metricName: "test.metric", operator: "gt", threshold: 10, durationMs: 1000 },
      }),
    );
    const fired: AlertNotification[] = [];
    registry.addHandler((n) => fired.push(n));

    registry.evaluate("test.metric", 20, {});
    now += 999;
    registry.evaluate("test.metric", 20, {});
    expect(fired).toHaveLength(0);

    now += 1;
    registry.evaluate("test.metric", 20, {});

    expect(fired).toHaveLength(1);
    expect(fired[0].status).toBe("firing");
    expect(registry.getFiringAlerts()).toHaveLength(1);
  });

  it("suppresses re-fire within cooldownMs after a resolution", () => {
    let now = 1_000_000;
    const registry = new AlertRuleRegistry(() => now);
    registry.register(makeRule({ cooldownMs: 5000 }));
    const fired: AlertNotification[] = [];
    registry.addHandler((n) => fired.push(n));

    registry.evaluate("test.metric", 20, {});
    expect(fired).toHaveLength(1);

    now += 100;
    registry.evaluate("test.metric", 5, {});
    expect(fired).toHaveLength(2);

    now += 100;
    registry.evaluate("test.metric", 20, {});
    expect(fired).toHaveLength(2);
    expect(registry.getFiringAlerts()).toHaveLength(0);

    now += 5000;
    registry.evaluate("test.metric", 20, {});
    expect(fired).toHaveLength(3);
    expect(registry.getFiringAlerts()).toHaveLength(1);
  });
});
