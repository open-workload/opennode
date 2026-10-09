# OpenNode — SLIs, SLOs, and Error Budgets

> ⚠️ **The repository is under active development.** Several claims in this
> document went stale within hours of being written — `lib/peernet/src/libp2pTransport.ts`
> appeared after the first draft had correctly reported that no production transport
> existed. Every factual claim below was verified against source on **2026-10-09**; treat
> unverified specifics as suspect and re-check before relying on them.

> **Why this document exists.** The review found **no SLI or SLO definition anywhere
> in the repository**, and **all 15 alert rules in `lib/observability/src/alertRules.ts`
> reference metric names that no code emits** — there is no instrumentation library
> at all, and the production exporter is a no-op. Alert thresholds were unanchored
> magic numbers; `sync.catchup_lag > 1000` has no stated unit.
>
> Per OPS-03, observability *emission* is the deliverable. This document defines the
> targets; each row names the instrumented call site that must produce it.
>
> **Current status: all targets below are UNIMPLEMENTED.** No metric named in this
> document may appear in a dashboard until its emitting call site exists (OPS-03).

---

## Metric naming convention

One canonical convention, used by all alert rules, dashboards, and tests:

```
<subsystem>.<signal>_<unit>
```

Subsystems: `consensus`, `sync`, `peer`, `membership`, `run_coordinator`,
`worker`, `content_store`, `api`.

**Rules (OPS-05):**

- Permitted labels are a fixed low-cardinality allowlist: `nodeId`, `clusterId`,
  `status`, `reason`, `subsystem`.
- High-cardinality identifiers (`runId`, `attemptId`, `requestId`, `clientKey`,
  `proposalId`) are **forbidden as labels**. They belong in logs and traces,
  correlated by ID, not as metric dimensions. Recording one MUST drop the sample
  and increment `metric_label_dropped_total`.
- Every metric referenced by a registered alert rule MUST have a producing call
  site; CI fails otherwise.

---

## SLIs

| ID | User-visible journey | SLI | Unit | Window | Emitting call site (must exist) |
|---|---|---|---|---|---|
| SLI-01 | Submit a run | Time from accepted `run.submitted` commit to lease grant | ms | 5 min rolling | `run-coordinator` `acquireLease` |
| SLI-02 | Submit a run | Time from submit request received to `202` returned | ms | 5 min rolling | `api-server` submit route |
| SLI-03 | Watch a run | Time from first worker output to first entry visible in the log stream | ms | 5 min rolling | `node-store` `appendLog` → SSE emit |
| SLI-04 | Watch a run | Age of newest log entry relative to now, while a run is non-terminal | ms | 1 min scrape | `worker-runtime` log writer |
| SLI-05 | Watch a run | Age of a `queued` run (queue age) | ms | 1 min scrape | `run-coordinator` queue |
| SLI-06 | Join a cluster | Catch-up lag: local applied height vs. highest peer-advertised height | events | 1 min scrape | `sync-engine` catch-up worker |
| SLI-07 | Join a cluster | Time to reach `synced` from a cold start | s | per join | `sync-engine` catch-up worker |
| SLI-08 | Trust the cluster | Consensus quorum availability | boolean (1/0) | 1 min scrape | consensus engine adapter |
| SLI-09 | Trust the cluster | Fraction of admitted members currently `synced` | ratio 0–1 | 5 min rolling | `sync-engine` + membership read model |
| SLI-10 | Trust the cluster | Peers authenticated and connected | count | 1 min scrape | `peernet` transport |
| SLI-11 | Trust the cluster | Handshakes rejected, by reason | count/min | 5 min rolling | `peernet` handshake verifier |
| SLI-12 | Get work done | Lease renewals succeeded / attempted | ratio | 15 min rolling | `run-coordinator` renewal |
| SLI-13 | Get work done | Attempts fenced, by reason | count | 15 min rolling | `run-coordinator` reconcile |
| SLI-14 | Get work done | Runs reaching a terminal state | count | 15 min rolling | `run-coordinator` |
| SLI-15 | Get work done | Runs with no executing worker while holding a committed lease | count | 5 min rolling | `run-coordinator` reconcile |
| SLI-16 | Get work done | Duplicate submissions collapsed by idempotency | count | 5 min rolling | `run-coordinator` submit |
| SLI-17 | Get work done | Idempotency-key conflicts (genuine user collisions) | count | 5 min rolling | `run-coordinator` submit |
| SLI-18 | Workload isolation | Worker cleanup failures (scratch or credential not removed) | count | 15 min rolling | `worker-runtime` teardown |
| SLI-19 | Workload isolation | Orphan content chunks awaiting collection | count | 1 hour | `content-store` GC |
| SLI-20 | Workload isolation | Workloads terminated by each enforced limit | count | 15 min rolling | `worker-runtime` terminal result |
| SLI-21 | Secret hygiene | Denied secret reads | count | 5 min rolling | `secret-broker` authorize |
| SLI-22 | Governance | Proposals reaching a terminal outcome | count | 1 hour | `membership-service` finalize |
| SLI-23 | Governance | Proposals stuck without a terminal outcome | count | 1 hour | `membership-service` |
| SLI-24 | API | Request rate by route and status class | count/min | 5 min rolling | `api-server` |
| SLI-25 | API | p95 request latency by route | ms | 5 min rolling | `api-server` |
| SLI-26 | API | Alert notification delivery failures | count | 5 min rolling | `observability` alert evaluator |

---

## SLOs

| ID | SLI | Objective | Window | Error budget | Blocks release? |
|---|---|---|---|---|---|
| SLO-01 | SLI-01 | ≥ 99% of runs leased within 30 s | 30 d | 0.1% | Yes |
| SLO-02 | SLI-02 | ≥ 99.9% of submissions return `202` within 2 s | 30 d | 0.01% | Yes |
| SLO-03 | SLI-03 | ≥ 99% of first log entries visible within 5 s | 30 d | 0.1% | Yes |
| SLO-04 | SLI-04 | ≥ 99% of non-terminal runs have log age < 30 s | 30 d | 0.1% | No |
| SLO-05 | SLI-05 | ≥ 95% of runs start within 5 min of becoming unblocked | 30 d | 0.5% | No |
| SLO-06 | SLI-08 | ≥ 99.95% quorum availability | 30 d | 0.005% | Yes |
| SLO-07 | SLI-09 | ≥ 99% of admitted members synced | 30 d | 0.1% | Yes |
| SLO-08 | SLI-07 | ≥ 99% of joins reach synced within 15 min | 30 d | 0.1% | No |
| SLO-09 | SLI-11 | Handshake rejection rate stays below 1% of attempts in steady state | 7 d | 1% | No |
| SLO-10 | SLI-12 | ≥ 99.9% of lease renewals succeed while the worker is live | 30 d | 0.01% | Yes |
| SLO-11 | SLI-15 | Zero runs hold a lease with no executing worker beyond the detection interval | 30 d | 0 | Yes |
| SLO-12 | SLI-14 | ≥ 99% of dispatched runs reach a terminal state within lease + grace | 30 d | 0.1% | Yes |
| SLO-13 | SLI-18 | ≥ 99.9% of attempts clean up scratch and credentials successfully | 30 d | 0.01% | Yes |
| SLO-14 | SLI-19 | Orphan chunks reclaimed within the configured grace period | 24 h | 0.1% | No |
| SLO-15 | SLI-23 | Zero proposals stuck without a terminal outcome beyond 2× their TTL | 24 h | 0 | Yes |
| SLO-16 | SLI-25 | p95 API latency < 500 ms (excluding streaming routes) | 30 d | 1% | No |
| SLO-17 | SLI-26 | ≥ 99.9% of firing alerts deliver successfully | 30 d | 0.01% | Yes |

**Release policy (OPS-06):** a release is blocked when any SLO's burn rate
exceeds its budget. Fast-burn (14× budget over 1 h) and slow-burn (2× over 6 h)
multi-window alerting MUST be configured for every `Yes` SLO.

---

## Alert threshold → SLO mapping

Every alert threshold MUST cite the SLO it protects (OPS-06). Rule IDs and metric
names below are transcribed from `lib/observability/src/alertRules.ts` and verified
against source. **All thresholds are UNIMPLEMENTED** because none of these metrics has a
producing call site.

| Alert rule (`id`) | Metric (`condition.metricName`) | Threshold | Protects | Review note |
|---|---|---|---|---|
| `consensus.quorum_loss` | `consensus.quorum_available` | `== 0` for 30 s | SLO-06 | `durationMs` declared but not enforced — fires on a single sample |
| `consensus.proposal_stuck` | `consensus.proposal_age_ms` | > threshold | SLO-15 | Not previously mapped |
| `peer.connectivity_lost` | `peer.connectivity_status` | `< 1` | SLO-07 | Fires per cluster, not per peer; needs peer scoping — OPS-05 |
| `peer.suspected_compromised` | `peer.anomaly_score` | `> 0.8` for 10 min | SLO-06 | **No anomaly scorer exists anywhere in the codebase.** Rule can never fire |
| `sync.catchup_lag` | `sync.catchup_lag` | `> 1000` for 15 min | SLO-07 | Unit unstated — events or ms? No producer |
| `sync.errors_high` | `sync.error_rate` | `> 0.05` for 10 min | SLO-07 | No producer |
| `run_coordinator.queue_age` | `run_coordinator.queue_age_ms` | `> 300000` for 10 min | SLO-05 | Value arbitrary; re-derive from SLO-05 |
| `run_coordinator.lease_expiry` | `run_coordinator.lease_ttl_ms` | > 0 for 5 min | SLO-10 | Alerts on expiry without renewal for a renewal mechanism that **does not exist** (RUN-03) |
| `run_coordinator.duplicate_submissions` | `run_coordinator.duplicate_submissions` | > 10/min | SLO-01 | No producer |
| `worker.health_degraded` | `worker.health_status` | `< 1` | SLO-12 | No producer |
| `worker.log_lag` | `worker.log_lag_ms` | `> 30000` | SLO-04 | No producer |
| `content_store.orphan_cleanup_failed` | `content_store.orphan_cleanup_errors` | `> 0` | SLO-13 | No producer; no GC exists (SEC-13) |
| `membership.key_revocation` | `membership.key_revocation_pending` | `> 0` | SLO-11 | No producer |
| `provider.outage` | `provider.availability` | `== 0` for 5 min | SLO-12 | No producer |
| `secret_broker.expired_credentials` | `secret_broker.expired_credentials` | `> 0` | — | No producer |

That is exactly **15 rules**, and **none** has a producing call site.

> **Naming unification has not happened.** The table above uses the rule package's
> existing `metricName` values, which follow no consistent convention — `sync.catchup_lag`
> (no unit suffix), `run_coordinator.queue_age_ms` (unit suffix), `peer.connectivity_status`
> (a status, not a gauge). The convention in this document has **not** been applied to the
> code. Migrating rule metrics is part of OPS-03.

### One alert-quality defect (previously misstated)

**CORRECTION.** An earlier draft of this document claimed that
`AlertRuleRegistry.formatMessage` throws a `ReferenceError` because it interpolates an
out-of-scope `condition` variable, and concluded that *no alert can ever fire*. **That claim
was wrong.** `lib/observability/src/alertRules.ts:147-150` reads `rule.condition.metricName`,
`rule.condition.operator`, and `rule.condition.threshold` — `rule` is a parameter of the
method and is in scope. No `ReferenceError` is possible, and all 15 rules would fire
correctly given a metric.

The underlying defect is real but narrower: `formatMessage` is called at line 109, **before**
`notify()` at line 121, and `evaluate()` has no try/catch around it, so a genuine throw would
propagate out of `evaluate()` and then be swallowed by the empty `catch {}` in
`startEvaluation` (`:162-175`). See OPS-04.

**What genuinely blocks alerting** is simpler and confirmed: no metric has a producer, so
every rule sits permanently in `pending`.

---

## Missing alerting (no rule exists)

| Condition | Protects | Required rule |
|---|---|---|
| Worker must be contained (EXEC-11) | SLO-13 | `worker.containment_required` |
| Restore event / restored node not yet reconciled (SYNC-17, DATA-04) | SLO-11 | `sync.restored_unreconciled` |
| Cluster divergence detected (SYNC-10) | SLO-06 | `consensus.divergence_detected` |
| Identity collision / duplicate NodeId detected (NET-02, GOV-21) | SLO-06 | `peer.identity_collision` |
| Audit chain verification failure (DATA-07) | compliance | `audit.chain_verification_failed` |
| Secret read from a stale epoch or fenced lease (SEC-02) | compliance | `secret.stale_epoch_read` |
| Kill switch engaged / disarmed (OPS-12, CFG-01) | SLO-12 | `feature_flag.kill_switch_active` — **does not exist**; note the current endpoints mutate an instance the coordinator never reads |
| Audit write failure (DATA-16) | compliance | `audit.write_failed` |
| Concurrent-commit conflict rate (CONC-01) | SLO-01 | `run_coordinator.commit_conflict_total` |

Each is required by OPS-09 with a runbook in `docs/runbooks/`.

---

## Observability acceptance criteria

Observability work is complete only when **all** of the following hold:

1. Every SLI in this table has a named instrumented call site that emits its metric.
2. A CI check fails when any alert-rule metric has no producing call site (OPS-03).
3. A CI check fails when a metric label uses a forbidden high-cardinality
   identifier (OPS-05).
4. Every alert in the threshold table transitions to `firing` in a test when its
   metric crosses threshold, and a single-sample excursion does **not** page
   (OPS-04).
5. Every alert with severity `critical` resolves to a committed runbook (OPS-09).
6. `/metrics` is mounted and access-controlled (API-13).
7. The production exporter is not a no-op implementation (OPS-03). *Note: the
   current no-op is not even reachable — `createNoopExporter` is not re-exported
   from the package barrel, so nothing can construct it and nothing emits anything.*
8. Every time-dependent module accepts an injected `Clock`, so every window in
   this document is testable with a fake clock and zero wall-clock delay (OPS-15,
   TIME-01).
9. Rule metrics have been migrated to the naming convention above, or the convention
   has been amended to match the code (OPS-03, OPS-05).
