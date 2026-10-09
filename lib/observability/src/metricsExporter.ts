export enum MetricType {
  Counter = "counter",
  Gauge = "gauge",
  Histogram = "histogram",
  Summary = "summary",
}

export interface MetricLabel {
  name: string;
  value: string;
}

export interface Metric {
  name: string;
  type: MetricType;
  value: number;
  labels: MetricLabel[];
  timestamp: number;
  help?: string;
}

export interface MetricsSnapshot {
  metrics: Metric[];
  timestamp: number;
}

export interface MetricsExporter {
  export(snapshot: MetricsSnapshot): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createNoopExporter(): MetricsExporter {
  return {
    async export() {},
    async flush() {},
    async shutdown() {},
  };
}