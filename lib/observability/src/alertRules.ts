export enum AlertSeverity {
  Info = "info",
  Warning = "warning",
  Critical = "critical",
}

export interface AlertCondition {
  metricName: string;
  operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
  threshold: number;
  durationMs?: number;
  labels?: Record<string, string>;
}

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  severity: AlertSeverity;
  condition: AlertCondition;
  subsystem: string;
  runbookUrl?: string;
  enabled: boolean;
  cooldownMs?: number;
  labels?: Record<string, string>;
}

export interface AlertContext {
  rule: AlertRule;
  metricValue: number;
  timestamp: number;
  labels: Record<string, string>;
  correlationIds?: Record<string, string>;
}

export interface AlertNotification {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  message: string;
  context: AlertContext;
  firedAt: number;
  resolvedAt?: number;
  status: "firing" | "resolved";
}

type AlertHandler = (notification: AlertNotification) => void;

export class AlertRuleRegistry {
  private rules = new Map<string, AlertRule>();
  private firingAlerts = new Map<string, AlertNotification>();
  private handlers: AlertHandler[] = [];
  private evaluationIntervals = new Map<string, ReturnType<typeof setInterval>>();

  register(rule: AlertRule): void {
    if (this.rules.has(rule.id)) {
      throw new Error(`Alert rule with id ${rule.id} already exists`);
    }
    this.rules.set(rule.id, rule);
  }

  unregister(ruleId: string): void {
    this.rules.delete(ruleId);
    this.stopEvaluation(ruleId);
    this.firingAlerts.delete(ruleId);
  }

  getRule(ruleId: string): AlertRule | undefined {
    return this.rules.get(ruleId);
  }

  getAllRules(): AlertRule[] {
    return Array.from(this.rules.values());
  }

  getRulesBySubsystem(subsystem: string): AlertRule[] {
    return Array.from(this.rules.values()).filter(r => r.subsystem === subsystem);
  }

  addHandler(handler: AlertHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  evaluate(metricName: string, value: number, labels: Record<string, string>, correlationIds?: Record<string, string>): void {
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      if (rule.condition.metricName !== metricName) continue;

      const labelMatch = !rule.condition.labels ||
        Object.entries(rule.condition.labels).every(([k, v]) => labels[k] === v);

      if (!labelMatch) continue;

      const matches = this.checkCondition(rule.condition, value);
      const alertKey = `${rule.id}:${JSON.stringify(labels)}`;

      if (matches) {
        if (!this.firingAlerts.has(alertKey)) {
          const notification: AlertNotification = {
            id: `${rule.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            message: this.formatMessage(rule, value, labels),
            context: {
              rule,
              metricValue: value,
              timestamp: Date.now(),
              labels,
              correlationIds,
            },
            firedAt: Date.now(),
            status: "firing",
          };
          this.firingAlerts.set(alertKey, notification);
          this.notify(notification);
        }
      } else {
        const existing = this.firingAlerts.get(alertKey);
        if (existing) {
          existing.status = "resolved";
          existing.resolvedAt = Date.now();
          this.notify(existing);
          this.firingAlerts.delete(alertKey);
        }
      }
    }
  }

  private checkCondition(condition: AlertCondition, value: number): boolean {
    switch (condition.operator) {
      case "gt": return value > condition.threshold;
      case "gte": return value >= condition.threshold;
      case "lt": return value < condition.threshold;
      case "lte": return value <= condition.threshold;
      case "eq": return value === condition.threshold;
      case "neq": return value !== condition.threshold;
      default: return false;
    }
  }

  private formatMessage(rule: AlertRule, value: number, labels: Record<string, string>): string {
    const labelStr = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(", ");
    return `${rule.name}: ${rule.condition.metricName} ${rule.condition.operator} ${rule.condition.threshold} (current: ${value})${labelStr ? ` {${labelStr}}` : ""}`;
  }

  private notify(notification: AlertNotification): void {
    for (const handler of this.handlers) {
      try {
        handler(notification);
      } catch {
        // Silently ignore handler errors
      }
    }
  }

  startEvaluation(metricsProvider: () => Promise<Map<string, { value: number; labels: Record<string, string> }>>, intervalMs = 30000): void {
    const interval = setInterval(async () => {
      try {
        const metrics = await metricsProvider();
        for (const [name, { value, labels }] of metrics) {
          this.evaluate(name, value, labels);
        }
      } catch {
        // Silently ignore evaluation errors
      }
    }, intervalMs);

    this.evaluationIntervals.set("global", interval);
  }

  stopEvaluation(ruleId?: string): void {
    if (ruleId) {
      const interval = this.evaluationIntervals.get(ruleId);
      if (interval) {
        clearInterval(interval);
        this.evaluationIntervals.delete(ruleId);
      }
    } else {
      for (const interval of this.evaluationIntervals.values()) {
        clearInterval(interval);
      }
      this.evaluationIntervals.clear();
    }
  }

  getFiringAlerts(): AlertNotification[] {
    return Array.from(this.firingAlerts.values());
  }

  getFiringAlertsBySubsystem(subsystem: string): AlertNotification[] {
    return Array.from(this.firingAlerts.values()).filter(a => a.context.rule.subsystem === subsystem);
  }
}

export const alertRuleRegistry = new AlertRuleRegistry();

export function createDefaultAlertRules(): AlertRule[] {
  return [
    {
      id: "consensus.quorum_loss",
      name: "Consensus Quorum Loss",
      description: "Consensus quorum lost - cluster cannot make progress",
      severity: AlertSeverity.Critical,
      condition: { metricName: "consensus.quorum_available", operator: "eq", threshold: 0, durationMs: 30000 },
      subsystem: "consensus",
      runbookUrl: "runbooks/quorum_loss.md",
      enabled: true,
      cooldownMs: 60000,
    },
    {
      id: "consensus.proposal_stuck",
      name: "Stuck Proposal",
      description: "Consensus proposal not committing within expected time",
      severity: AlertSeverity.Warning,
      condition: { metricName: "consensus.proposal_age_ms", operator: "gt", threshold: 60000, durationMs: 120000 },
      subsystem: "consensus",
      runbookUrl: "runbooks/stuck_proposal.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "peer.connectivity_lost",
      name: "Peer Connectivity Lost",
      description: "Peer unreachable for extended period",
      severity: AlertSeverity.Warning,
      condition: { metricName: "peer.connectivity_status", operator: "eq", threshold: 0, durationMs: 60000 },
      subsystem: "peernet",
      runbookUrl: "runbooks/peer_connectivity.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "peer.suspected_compromised",
      name: "Suspected Compromised Peer",
      description: "Peer exhibiting anomalous behavior suggesting compromise",
      severity: AlertSeverity.Critical,
      condition: { metricName: "peer.anomaly_score", operator: "gt", threshold: 0.8, durationMs: 300000 },
      subsystem: "peernet",
      runbookUrl: "runbooks/compromised_peer.md",
      enabled: true,
      cooldownMs: 600000,
    },
    {
      id: "sync.catchup_lag",
      name: "Sync Catch-up Lag",
      description: "Node falling behind in log replication",
      severity: AlertSeverity.Warning,
      condition: { metricName: "sync.catchup_lag", operator: "gt", threshold: 1000, durationMs: 300000 },
      subsystem: "sync-engine",
      runbookUrl: "runbooks/sync_lag.md",
      enabled: true,
      cooldownMs: 600000,
    },
    {
      id: "sync.errors_high",
      name: "High Sync Error Rate",
      description: "Elevated sync errors indicating potential issues",
      severity: AlertSeverity.Warning,
      condition: { metricName: "sync.error_rate", operator: "gt", threshold: 0.1, durationMs: 180000 },
      subsystem: "sync-engine",
      runbookUrl: "runbooks/sync_errors.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "run_coordinator.queue_age",
      name: "Run Queue Age High",
      description: "Runs waiting in queue for extended time",
      severity: AlertSeverity.Warning,
      condition: { metricName: "run_coordinator.queue_age_ms", operator: "gt", threshold: 300000, durationMs: 600000 },
      subsystem: "run-coordinator",
      runbookUrl: "runbooks/queue_age.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "run_coordinator.lease_expiry",
      name: "Lease Expiry Imminent",
      description: "Active lease approaching expiry without renewal",
      severity: AlertSeverity.Warning,
      condition: { metricName: "run_coordinator.lease_ttl_ms", operator: "lt", threshold: 60000 },
      subsystem: "run-coordinator",
      runbookUrl: "runbooks/stale_lease.md",
      enabled: true,
      cooldownMs: 60000,
    },
    {
      id: "run_coordinator.duplicate_submissions",
      name: "Duplicate Submissions Detected",
      description: "Multiple submissions with same idempotency key",
      severity: AlertSeverity.Info,
      condition: { metricName: "run_coordinator.duplicate_submissions", operator: "gt", threshold: 0 },
      subsystem: "run-coordinator",
      runbookUrl: "runbooks/duplicate_submissions.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "worker.health_degraded",
      name: "Worker Health Degraded",
      description: "Worker reporting unhealthy or degraded status",
      severity: AlertSeverity.Warning,
      condition: { metricName: "worker.health_status", operator: "neq", threshold: 1 },
      subsystem: "worker-runtime",
      runbookUrl: "runbooks/worker_health.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "worker.log_lag",
      name: "Worker Log Lag",
      description: "Worker log streaming falling behind",
      severity: AlertSeverity.Warning,
      condition: { metricName: "worker.log_lag_ms", operator: "gt", threshold: 30000, durationMs: 180000 },
      subsystem: "worker-runtime",
      runbookUrl: "runbooks/log_lag.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "content_store.orphan_cleanup_failed",
      name: "Orphan Cleanup Failed",
      description: "Content store orphan cleanup operation failed",
      severity: AlertSeverity.Warning,
      condition: { metricName: "content_store.orphan_cleanup_errors", operator: "gt", threshold: 0 },
      subsystem: "content-store",
      runbookUrl: "runbooks/orphan_cleanup.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "membership.key_revocation",
      name: "Key Revocation Required",
      description: "Node key revocation triggered",
      severity: AlertSeverity.Critical,
      condition: { metricName: "membership.key_revocation_pending", operator: "gt", threshold: 0 },
      subsystem: "membership-log",
      runbookUrl: "runbooks/key_revocation.md",
      enabled: true,
      cooldownMs: 60000,
    },
    {
      id: "provider.outage",
      name: "Execution Provider Outage",
      description: "Execution provider unavailable or erroring",
      severity: AlertSeverity.Critical,
      condition: { metricName: "provider.availability", operator: "eq", threshold: 0, durationMs: 60000 },
      subsystem: "worker-runtime",
      runbookUrl: "runbooks/provider_outage.md",
      enabled: true,
      cooldownMs: 300000,
    },
    {
      id: "secret_broker.expired_credentials",
      name: "Expired Credentials",
      description: "Secret broker detecting expired credentials",
      severity: AlertSeverity.Warning,
      condition: { metricName: "secret_broker.expired_credentials", operator: "gt", threshold: 0 },
      subsystem: "secret-broker",
      runbookUrl: "runbooks/expired_credentials.md",
      enabled: true,
      cooldownMs: 300000,
    },
  ];
}