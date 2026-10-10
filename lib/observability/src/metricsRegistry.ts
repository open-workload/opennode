/**
 * Tiny in-memory Prometheus registry: counters, gauges, and text exposition.
 *
 *   increment(name, labels) / set(name, value, labels) ──▶ series map
 *        │                                                │
 *        └──▶ filterLabels: allowlist is nodeId, clusterId,  ▼
 *            status, reason, subsystem        rejected label ──▶ metric_label_dropped_total
 *   render() ──▶ sorted "# TYPE" plus sample lines ──▶ Prometheus text exposition
 */
export type MetricLabels = Record<string, string>;

export type MetricType = "counter" | "gauge";

const ALLOWED_LABELS: ReadonlySet<string> = new Set([
  "nodeId",
  "clusterId",
  "status",
  "reason",
  "subsystem",
]);

const LABEL_DROPPED_METRIC = "metric_label_dropped_total";

interface MetricLabel {
  name: string;
  value: string;
}

interface MetricSample {
  labels: MetricLabel[];
  value: number;
}

interface MetricSeries {
  type: MetricType;
  samples: Map<string, MetricSample>;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function labelKey(labels: readonly MetricLabel[]): string {
  return labels.map((label) => `${label.name}="${escapeLabelValue(label.value)}"`).join(",");
}

function formatSample(name: string, sample: MetricSample): string {
  if (sample.labels.length === 0) {
    return `${name} ${sample.value}`;
  }
  return `${name}{${labelKey(sample.labels)}} ${sample.value}`;
}

/**
 * A tiny in-memory Prometheus registry. It is deliberately minimal: counters
 * via `increment`, gauges via `set`, and a text exposition via `render`.
 *
 * Labels are restricted to a fixed low-cardinality allowlist (OPS-05). Any
 * other label is dropped and counted in `metric_label_dropped_total` rather
 * than being allowed to blow up cardinality.
 */
export class MetricsRegistry {
  private readonly series = new Map<string, MetricSeries>();
  private droppedLabels = 0;

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const sample = this.resolveSample(name, "counter", labels);
    sample.value += value;
  }

  set(name: string, value: number, labels: MetricLabels = {}): void {
    const sample = this.resolveSample(name, "gauge", labels);
    sample.value = value;
  }

  render(): string {
    const names = new Set(this.series.keys());
    names.add(LABEL_DROPPED_METRIC);

    const sorted = [...names].sort();
    const lines: string[] = [];
    for (const name of sorted) {
      const metric =
        name === LABEL_DROPPED_METRIC
          ? { type: "counter" as MetricType, samples: new Map([[`${LABEL_DROPPED_METRIC}`, { labels: [], value: this.droppedLabels }]]) }
          : this.series.get(name);
      if (metric === undefined) continue;
      lines.push(`# TYPE ${name} ${metric.type}`);
      const samples = [...metric.samples.values()].sort((a, b) =>
        labelKey(a.labels) < labelKey(b.labels) ? -1 : labelKey(a.labels) > labelKey(b.labels) ? 1 : 0,
      );
      for (const sample of samples) {
        lines.push(formatSample(name, sample));
      }
    }
    return lines.join("\n") + "\n";
  }

  private resolveSample(name: string, type: MetricType, labels: MetricLabels): MetricSample {
    const filtered = this.filterLabels(labels);
    let metric = this.series.get(name);
    if (metric === undefined) {
      metric = { type, samples: new Map() };
      this.series.set(name, metric);
    }
    const key = labelKey(filtered);
    let sample = metric.samples.get(key);
    if (sample === undefined) {
      sample = { labels: filtered, value: 0 };
      metric.samples.set(key, sample);
    }
    return sample;
  }

  private filterLabels(labels: MetricLabels): MetricLabel[] {
    const kept: MetricLabel[] = [];
    for (const [name, value] of Object.entries(labels)) {
      if (ALLOWED_LABELS.has(name)) {
        kept.push({ name, value });
      } else {
        this.droppedLabels += 1;
      }
    }
    kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return kept;
  }
}

export const metricsRegistry = new MetricsRegistry();

export function renderMetrics(): string {
  return metricsRegistry.render();
}
