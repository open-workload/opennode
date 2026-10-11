/**
 * OPS-03 guard: observability must be emission, not declaration.
 *
 *   alertRules.ts ──▶ extractAlertMetricNames ──▶ 15 metric names
 *                                                    │
 *     source tree ──▶ walkSourceFiles ──▶ production files
 *                                                    ▼
 *                analyzeMetricProducers ──▶ unproduced / untracked / stale
 *                                                    │
 *                          KNOWN_UNPRODUCED_ALLOWLIST ─┘──▶ GuardResult
 *
 * A metric referenced by a registered alert rule must have a real producing
 * call site (an `increment("name")` / `set("name", ...)` in non-test source),
 * or be a tracked allowlist entry. An allowlist entry that later gains a
 * producer is stale and fails CI.
 */
import type { GuardResult } from './guard';
import { isTestFile, walkSourceFiles, type SourceFile } from './source';

export interface MetricProducerAnalysis {
  readonly unproduced: readonly string[];
  readonly untracked: readonly string[];
  readonly stale: readonly string[];
}

const ALERT_RULES_PATH = 'lib/observability/src/alertRules.ts';

function escapeRegExp(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The emission API is `metricsRegistry.increment(name, labels?, value?)` and
 * `metricsRegistry.set(name, value, labels?)` (metricsRegistry.ts). A metric
 * is "produced" only when its name is the literal first argument to one of
 * those calls — a bare mention of the name is a reference, not a call site.
 */
export function producerPattern(metric: string): RegExp {
  return new RegExp(`\\b(?:increment|set)\\s*\\(\\s*["'\`]${escapeRegExp(metric)}["'\`]`);
}

export function extractAlertMetricNames(source: string): string[] {
  const names = [...source.matchAll(/metricName:\s*"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(names)].sort();
}

export function analyzeMetricProducers(
  metrics: readonly string[],
  files: readonly SourceFile[],
  allowlist: readonly string[],
): MetricProducerAnalysis {
  const allowed = new Set(allowlist);
  const production = files.filter((file) => !isTestFile(file.path));

  const unproduced: string[] = [];
  const stale: string[] = [];

  for (const metric of metrics) {
    const pattern = producerPattern(metric);
    const hasProducer = production.some((file) => {
      pattern.lastIndex = 0;
      return pattern.test(file.content);
    });

    if (!hasProducer) {
      unproduced.push(metric);
    } else if (allowed.has(`OPS-03:${metric}`)) {
      stale.push(metric);
    }
  }

  const untracked = unproduced.filter((metric) => !allowed.has(`OPS-03:${metric}`));
  return { unproduced, untracked, stale };
}

/**
 * Explicit, requirement-tracked allowlist for OPS-03. Every entry is an
 * alert-rule metric with no producing call site yet; removing an entry is how
 * we record that the metric became emitted. A metric that gains a producer
 * while still listed here fails CI as a stale entry.
 *
 * Tracking ids are `OPS-03:<metric>`; each comment names the owning module.
 */
export const KNOWN_UNPRODUCED_ALLOWLIST: readonly string[] = [
  // OPS-03:peer.connectivity_status — owning module is lib/peernet transport;
  // NOT writable: the only transport impl lib/peernet/src/inMemory.ts is never
  // imported and its transportHealth() has zero callers, so there is no live
  // connectivity-status signal to instrument.
  'OPS-03:peer.connectivity_status',
  // OPS-03:peer.anomaly_score — owning module is lib/peernet membership;
  // NOT writable: no anomaly-detection concept exists anywhere in lib/peernet.
  'OPS-03:peer.anomaly_score',
  // OPS-03:worker.health_status — owning module is lib/worker-runtime;
  // NOT writable: the runtime exposes no health/readiness signal and nothing
  // registers a HealthCheck, so there is no event to instrument.
  'OPS-03:worker.health_status',
  // OPS-03:worker.log_lag_ms — owning module is lib/worker-runtime;
  // NOT writable: the runtime has no log-streaming backlog measurement; the
  // log stream is api-server-local and carries no source-side lag.
  'OPS-03:worker.log_lag_ms',
];

export function checkMetricProducers(root: string): GuardResult {
  const files = walkSourceFiles(root, (path) => path.startsWith('scripts/src/ci-checks/'));
  const alertRules = files.find((file) => file.path === ALERT_RULES_PATH);
  const metrics = alertRules === undefined ? [] : extractAlertMetricNames(alertRules.content);
  const analysis = analyzeMetricProducers(metrics, files, KNOWN_UNPRODUCED_ALLOWLIST);

  const failures = [
    ...analysis.untracked.map(
      (metric) =>
        `alert-rule metric has no producing call site and is not allowlisted: OPS-03:${metric} — ` +
        `instrument it in its owning module or add it to KNOWN_UNPRODUCED_ALLOWLIST with a tracking id`,
    ),
    ...analysis.stale.map(
      (metric) =>
        `stale allowlist entry: OPS-03:${metric} now has a producing call site — ` +
        `remove it from KNOWN_UNPRODUCED_ALLOWLIST`,
    ),
  ];

  return {
    name: 'OPS-03 metric producers',
    ok: failures.length === 0,
    failures,
    summary:
      `${metrics.length} alert metrics: ` +
      `${analysis.unproduced.length - analysis.untracked.length} allowlisted, ` +
      `${metrics.length - analysis.unproduced.length} produced, ` +
      `${analysis.untracked.length} untracked, ${analysis.stale.length} stale`,
  };
}