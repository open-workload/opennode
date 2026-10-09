import { describe, it, expect } from "vitest";
import { MetricsRegistry } from "./metricsRegistry";

describe("MetricsRegistry", () => {
  it("increments a counter and renders Prometheus text exposition", () => {
    const registry = new MetricsRegistry();
    registry.increment("run_coordinator_submissions_total");
    const output = registry.render();
    expect(output).toContain("# TYPE run_coordinator_submissions_total counter");
    expect(output).toContain("run_coordinator_submissions_total 1");
  });

  it("accumulates increments and supports an explicit value", () => {
    const registry = new MetricsRegistry();
    registry.increment("run_coordinator_lease_grants_total");
    registry.increment("run_coordinator_lease_grants_total", {}, 4);
    expect(registry.render()).toContain("run_coordinator_lease_grants_total 5");
  });

  it("sets a gauge and replaces its previous value", () => {
    const registry = new MetricsRegistry();
    registry.set("peer_connected", 3);
    registry.set("peer_connected", 5);
    const output = registry.render();
    expect(output).toContain("# TYPE peer_connected gauge");
    expect(output).toContain("peer_connected 5");
    expect(output).not.toContain("peer_connected 3");
  });

  it("renders allowlisted labels sorted by name", () => {
    const registry = new MetricsRegistry();
    registry.increment("membership_votes_accepted_total", { status: "ok", nodeId: "n1" });
    expect(registry.render()).toContain('membership_votes_accepted_total{nodeId="n1",status="ok"} 1');
  });

  it("escapes backslashes, quotes, and newlines in label values", () => {
    const registry = new MetricsRegistry();
    registry.set("subsystem_health", 1, { reason: 'a"b\\c\nd' });
    expect(registry.render()).toContain('subsystem_health{reason="a\\"b\\\\c\\nd"} 1');
  });

  it("drops forbidden high-cardinality labels and counts the drop", () => {
    const registry = new MetricsRegistry();
    registry.increment("x_total", { runId: "run-123", status: "ok" });
    const output = registry.render();
    expect(output).toContain('x_total{status="ok"} 1');
    expect(output).not.toContain("runId");
    expect(output).toContain("# TYPE metric_label_dropped_total counter");
    expect(output).toContain("metric_label_dropped_total 1");
  });

  it("counts each forbidden label that is dropped", () => {
    const registry = new MetricsRegistry();
    registry.increment("x_total", { runId: "a", attemptId: "b", clientKey: "c" });
    const output = registry.render();
    expect(output).toContain("metric_label_dropped_total 3");
    expect(output).toContain("x_total 1");
  });

  it("renders metrics deterministically ordered by name", () => {
    const registry = new MetricsRegistry();
    registry.increment("b_total");
    registry.increment("a_total");
    const output = registry.render();
    expect(output.indexOf("a_total")).toBeLessThan(output.indexOf("b_total"));
  });
});
