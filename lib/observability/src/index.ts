/**
 * Public surface of lib/observability: re-exports only, no logic of its own.
 *
 *   metricsRegistry ─┐  MetricsRegistry, metricsRegistry, renderMetrics
 *   metricsExporter ─┤  MetricType, MetricsExporter / Metric / Snapshot types
 *   healthCheck ─────┤  HealthCheckRegistry, HealthStatus, endpoint types
 *   logCorrelation ──┤  LogCorrelator, CorrelationIds, StructuredLogEntry, LogLevel
 *   alertRules ──────┘  AlertRuleRegistry, AlertSeverity, AlertRule types
 *        └──▶ consumers so far: api-server routes import only the metrics side
 */
export {
  MetricsRegistry,
  metricsRegistry,
  renderMetrics,
} from "./metricsRegistry";
export type { MetricLabels } from "./metricsRegistry";

export {
  MetricType,
} from "./metricsExporter";
export type {
  MetricsExporter,
  Metric,
  MetricLabel,
  MetricsSnapshot,
} from "./metricsExporter";

export {
  HealthCheckRegistry,
  HealthStatus,
} from "./healthCheck";
export type {
  HealthCheckEndpoint,
  HealthCheck,
  HealthCheckResult,
  SubsystemHealth,
} from "./healthCheck";

export {
  LogCorrelator,
} from "./logCorrelation";
export type {
  CorrelationContext,
  CorrelationIds,
  StructuredLogEntry,
  LogLevel,
} from "./logCorrelation";

export {
  AlertRuleRegistry,
  AlertSeverity,
} from "./alertRules";
export type {
  AlertRule,
  AlertCondition,
  AlertContext,
  AlertNotification,
} from "./alertRules";