---
name: opennode-runbook-authoring
description: Write a runbook that resolves from runbookUrl in lib/observability/src/alertRules.ts. Use when authoring or fixing any of the 15 runbooks the alert rules demand, when an alert points at a missing or misnamed runbook during an incident, or when checking on-call (OPS-10) readiness against the OPS-09 7-section template.
---

# Authoring OpenNode runbooks

`lib/observability/src/alertRules.ts` is the **registry of truth**. `docs/runbooks/README.md`
is prose and it has drifted. When the two disagree, the alert rules win.

## 1. The naming rule — do this first

The filename is not yours to choose. It is the `runbookUrl` string, character-for-character.

```
runbookUrl: "runbooks/<name>.md"   ->   file lives at   docs/runbooks/<name>.md
```

**Underscores, not hyphens.** List the exact names the alerts demand:

```bash
cd /home/runner/workspace && grep -oE 'runbooks/[a-z_]+\.md' lib/observability/src/alertRules.ts | sort -u
```

Copy from that output. Do not type a name from memory, and do not copy from the README table.

### The trap: `docs/runbooks/README.md` is hyphenated and wrong

The README's required-runbooks table uses **hyphens**, and names several runbooks that no
alert can ever reach. It is not the filename source. Three separate failure modes:

| Failure mode | Example | Result |
|---|---|---|
| Hyphen vs underscore | README `quorum-loss.md` vs alert `quorum_loss.md` | File never resolves |
| **Different words entirely** | README `suspected-compromised-peer.md` vs alert `compromised_peer.md` | Underscoring it still gives `suspected_compromised_peer.md`, which **also does not resolve** |
| **No alert at all** | README `worker-containment.md`, `state-restore.md`, `secret-leak-suspected.md`, `cross-tenant-access.md`, `audit-chain-break.md`, `storage-exhaustion.md`, `sync-divergence.md`, `kill-switch.md` | No `runbookUrl` points at them; they are unreachable from any alert |

The README lists **14** runbooks; the alert rules demand **15**. The two sets barely overlap:
8 README names have no alert, and 9 alert names (`peer_connectivity`, `sync_lag`, `sync_errors`,
`queue_age`, `duplicate_submissions`, `worker_health`, `log_lag`, `orphan_cleanup`,
`expired_credentials`) have no README row. Treat the README's list as a stale wish-list, not a spec.

### The 15 names the alerts actually demand

Character-exact, with the rule each one hangs off:

| `runbookUrl` | Alert rule `id` | Severity | `condition.metricName` |
|---|---|---|---|
| `runbooks/quorum_loss.md` | `consensus.quorum_loss` | Critical | `consensus.quorum_available` |
| `runbooks/stuck_proposal.md` | `consensus.proposal_stuck` | Warning | `consensus.proposal_age_ms` |
| `runbooks/peer_connectivity.md` | `peer.connectivity_lost` | Warning | `peer.connectivity_status` |
| `runbooks/compromised_peer.md` | `peer.suspected_compromised` | Critical | `peer.anomaly_score` |
| `runbooks/sync_lag.md` | `sync.catchup_lag` | Warning | `sync.catchup_lag` |
| `runbooks/sync_errors.md` | `sync.errors_high` | Warning | `sync.error_rate` |
| `runbooks/queue_age.md` | `run_coordinator.queue_age` | Warning | `run_coordinator.queue_age_ms` |
| `runbooks/stale_lease.md` | `run_coordinator.lease_expiry` | Warning | `run_coordinator.lease_ttl_ms` |
| `runbooks/duplicate_submissions.md` | `run_coordinator.duplicate_submissions` | Info | `run_coordinator.duplicate_submissions` |
| `runbooks/worker_health.md` | `worker.health_degraded` | Warning | `worker.health_status` |
| `runbooks/log_lag.md` | `worker.log_lag` | Warning | `worker.log_lag_ms` |
| `runbooks/orphan_cleanup.md` | `content_store.orphan_cleanup_failed` | Warning | `content_store.orphan_cleanup_errors` |
| `runbooks/key_revocation.md` | `membership.key_revocation` | Critical | `membership.key_revocation_pending` |
| `runbooks/provider_outage.md` | `provider.outage` | Critical | `provider.availability` |
| `runbooks/expired_credentials.md` | `secret_broker.expired_credentials` | Warning | `secret_broker.expired_credentials` |

Counts: **4 Critical, 10 Warning, 1 Info.**

### Severity spelling

`alertRules.ts:1-5` declares:

```ts
export enum AlertSeverity {
  Info = "info",
  Warning = "warning",
  Critical = "critical",
}
```

The **member names** are PascalCase (`AlertSeverity.Critical`); the **string values** are
lowercase (`"critical"`). Both are correct in their place. In TypeScript you write
`AlertSeverity.Critical`; in a runbook's detection section, name the serialized value
`critical`. There is no `High` or `Medium` — the README's table uses both, and both are wrong.

## 2. The seven required sections

Every runbook MUST contain all seven, under these exact headings. A runbook missing any of
them is incomplete. One line each on what goes in it:

1. **`### 1. Detection`** — the alert rule `id` and the exact metric/condition that fired; what the operator actually sees (UI banner, CLI output, log lines); how to confirm the alert is real rather than an instrumentation fault.
2. **`### 2. Blast radius`** — which state is authoritative vs. stale; whether in-flight work is affected and whether it is safe; self-healing vs. requires-intervention; data-loss risk; whether cancelling is safe (RUN-06: retries are at-least-once, side effects are not rolled back).
3. **`### 3. Triage decision tree`** — explicit yes/no branches: local node or peer? recovering on its own, and how long to wait? does the audit trail still verify (DATA-07: it may not)? is secret material involved (escalate elsewhere)?
4. **`### 4. Remediation`** — per action: the exact operator command or API call, the expected outcome, and how to verify it worked. Commands MUST exist — verify before writing.
5. **`### 5. Abort / rollback`** — what to do when a remediation step makes things worse. Every destructive step needs a documented reversal; DATA-04 restore is **not** reversible (it deletes all rows from ten tables including `audit_events`).
6. **`### 6. Escalation`** — SEV level and the criterion that set it (OPS-10); responder role, channel, acknowledgement timer, time-to-mitigate target; when to page vs. ticket; when to convene an incident commander.
7. **`### 7. Post-incident`** — evidence to preserve *before* remediation (OPS-18 audit export, snapshot, node identity material); whether a postmortem is required (OPS-10: SEV1 and SEV2); which `todo.md` follow-ups this validates.

## 3. Authoring landmines — the ones that actually bite

`docs/runbooks/README.md` carries an 18-row landmine table. These are the ones that will
mislead an operator mid-incident if you write around them:

- **Every command you cite must exist.** The repo has already shipped runnable-looking commands
  that do not: `pnpm backup:restore` and `kubectl rollout undo` appear in
  `docs/canary-deployment.md` and **neither exists**. `kubectl` is also wrong for a
  Replit-hosted deployment. Grep for every command before you commit it.
- **Diagnostics lie.** `/healthz` returns a hardcoded `{status:"ok"}`, so it is worthless as a
  liveness signal. `opennode status` and `opennode peer-status` call endpoints that 404.
  `syncStatus` is a hardcoded `"local_only"` and `/membership/status` hardcodes
  `quarantinedNodeId: null`. Do not write a triage step that leans on any of these.
- **Identity is not per-node.** `getLocalNodeId()` returns the literal `"local"`, so every node
  shares one membership and lease identity. Any runbook that says "check the local node ID"
  is wrong.
- **Flags do nothing.** Two disjoint `FeatureFlags` instances mean the kill switch and flag
  endpoints have no effect on execution (CFG-01). Never offer a flag flip as remediation.
- **Root cause is not recorded.** `TransportHealth.lastError` is never assigned, and
  `observeAttempt` has no callers, so no run ever reaches a terminal state.
- **Leases fence at 30 s.** Lease TTL is 30 s against a 24 h max duration, so every run over
  30 s is fenced and re-executed (RUN-03). State this in `stale_lease.md` blast radius.
- **Backups do not round-trip.** Every timestamp renders as `{}` (DATA-03), and
  `restoreFromFile` clones another node's identity (DATA-04/NET-02) — restoring the wrong
  backup duplicates a node identity.
- **Credentials do not delete.** CLI `logout` throws `ReferenceError`, and the CLI claims it
  wrote to the OS credential store when it wrote `~/.opennode/credentials.json` (API-09).
- **No alert will ever fire.** No metric has a producer (OPS-03), so every rule sits permanently
  `pending`. Write the runbook anyway — OPS-09 does not block — but do not describe the alert
  as if it has already paged anyone.
- **Ignore the README's stale `formatMessage` claim.** The Detection section says
  `formatMessage` "currently throws for every alert". That is **wrong** and the README retracts
  it at lines 14-19: `rule` is in scope, and all 15 rules would fire correctly given a metric.
  Do not write that a broken alert path is the blocker.

## 4. Verify the runbook resolves

**There is no CI guard for runbooks.** `scripts/src/ci-checks/index.ts:9` runs exactly three
guards — `checkUnusedSymbols`, `checkBareJoin`, `checkInjectorPassThrough` — and none touches
`docs/runbooks/`. `runbookUrl` has no consumer anywhere in the codebase: `AlertNotification`
and `formatMessage` never read it. So a wrong or missing filename **fails silently and CI stays
green.** OPS-09's mandate ("CI MUST fail when a `runbookUrl` does not resolve") is documented
in `todo.md:1441-1447` and unimplemented.

You must run the check yourself. This one lists what is still missing and exits non-zero:

```bash
cd /home/runner/workspace && missing=0; for rb in $(grep -oE 'runbooks/[a-z_]+\.md' lib/observability/src/alertRules.ts | sort -u); do [ -f "docs/$rb" ] || { echo "MISSING docs/$rb"; missing=$((missing+1)); }; done; [ "$missing" -eq 0 ] || exit 1
```

Single file, while you are still writing it:

```bash
cd /home/runner/workspace && rb=quorum_loss.md; grep -q "runbooks/$rb" lib/observability/src/alertRules.ts && [ -f "docs/runbooks/$rb" ] && echo RESOLVES || { echo "NOT REFERENCED OR MISSING: $rb"; exit 1; }
```

Run the all-15 version before you call the work done. It prints `MISSING docs/runbooks/...`
per absent file and exits `1`. Today it reports all 15 missing — `docs/runbooks/` contains only
`README.md`.

## 5. Metric and label discipline

A runbook tells an operator what to query. If you cite a metric that can never match, the
operator is sent to an empty panel during an incident.

**Use only the five allowed labels.** `lib/observability/src/metricsRegistry.ts:5-11`:

```ts
const ALLOWED_LABELS: ReadonlySet<string> = new Set([
  "nodeId", "clusterId", "status", "reason", "subsystem",
]);
```

Anything else — `runId`, `attemptId`, `requestId`, `clientKey`, `proposalId` — is
**silently dropped** by `filterLabels` (`metricsRegistry.ts:106-117`) and only counted in
`metric_label_dropped_total`. It does not throw and does not warn, so a query filtered by a
forbidden label silently returns nothing.

**Naming is convention only — never "correct" a metric name.** `docs/slos.md` specifies
`<subsystem>.<signal>_<unit>`, but no code enforces it; `increment()`/`set()` accept any
string. Worse, several alert `condition.metricName` values do **not** follow it
(`consensus.quorum_available`, `peer.anomaly_score`, `worker.health_status`,
`run_coordinator.duplicate_submissions`). `evaluate()` matches on exact string equality
(`alertRules.ts:92`). So copy the metric name from the rule verbatim in the table above. If
you "fix" it to the convention in a runbook, the alert stops matching and never fires.

26 SLIs and 17 SLOs are defined in `docs/slos.md`; cite those names for expected values and
thresholds rather than inventing numbers.