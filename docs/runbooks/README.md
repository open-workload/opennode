# OpenNode Runbooks — Index

Every alert rule in `lib/observability/src/alertRules.ts` sets `runbookUrl` to
`runbooks/<name>.md`. **That directory did not exist.** This file defines the
required set and the required structure.

Per **OPS-09**, CI MUST fail when a `runbookUrl` does not resolve to a committed
file, and every `critical`-severity rule MUST have one.

> **Status: NOT WRITTEN.** All eight runbooks required by slice 6 are missing. Two
> of them (`worker-containment`, `state-restore`) have **no corresponding alert rule
> at all**, so they would never be surfaced to an operator even if written.

> ⚠️ **Correction.** An earlier draft stated that `formatMessage` throws a
> `ReferenceError` and therefore *no alert can fire*, concluding "fix OPS-04 first."
> **That was wrong** — `formatMessage` reads `rule.condition.*` and `rule` is in
> scope; all 15 rules would fire correctly given a metric. The real blocker is
> simpler: **no metric has a producer**, so every rule sits permanently `pending`.
> See OPS-03. Nothing blocks writing these runbooks today.

---

## Required runbooks

| # | Runbook | Required by | Alert rule | Severity | Exists |
|---|---|---|---|---|---|
| 1 | `quorum-loss.md` | slice 6, todo.md | `consensus.quorum_loss` | Critical | ❌ |
| 2 | `suspected-compromised-peer.md` | slice 6, todo.md | `peer.suspected_compromised` | Critical | ❌ |
| 3 | `key-revocation.md` | slice 6, todo.md | `key.revocation_pending` | Critical | ❌ |
| 4 | `worker-containment.md` | slice 6, todo.md | **(none exists)** | Critical | ❌ |
| 5 | `provider-outage.md` | slice 6, todo.md | `provider.availability` | High | ❌ |
| 6 | `stuck-proposal.md` | slice 6, todo.md | **(none exists)** | Medium | ❌ |
| 7 | `stale-lease.md` | slice 6, todo.md | `run_coordinator.lease_ttl_ms` | High | ❌ |
| 8 | `state-restore.md` | slice 6, todo.md | **(none exists)** | Critical | ❌ |

## Additional runbooks required by review findings

| # | Runbook | Required by | Exists |
|---|---|---|---|
| 9 | `secret-leak-suspected.md` | SEC-06, SEC-07 (redaction is dead code; secrets reach stdout and backups) | ❌ |
| 10 | `cross-tenant-access.md` | DATA-04, API-02 (no tenant model exists) | ❌ |
| 11 | `audit-chain-break.md` | DATA-07 (checksums are not hash-linked; restore deletes audit) | ❌ |
| 12 | `storage-exhaustion.md` | SYNC-08, OPS-13 (no compaction, no quotas, disk fill looks like a sync failure) | ❌ |
| 13 | `sync-divergence.md` | SYNC-06, SYNC-10 (divergence currently has no recovery path) | ❌ |
| 14 | `kill-switch.md` | OPS-12 (per-process, unaudited, cannot stop a cluster) | ❌ |

---

## Required structure

Each runbook MUST contain all seven sections. A runbook missing any of them is
incomplete and CI MUST fail.

### 1. Detection

- **Alert rule ID** and the exact metric/condition that fired.
- **What the operator sees** — the UI banner, CLI output, and log lines.
- **How to confirm** the alert is real rather than an instrumentation fault.
  *(Required because `formatMessage` currently throws for every alert, and
  `peer.anomaly_score` has no scorer at all — an operator cannot currently
  distinguish "the condition is true" from "the alert path is broken.")*

### 2. Blast radius

- Which state is authoritative and which is stale.
- Whether work in flight is affected, and whether it is safe or unsafe.
- Whether the condition is **self-healing** (quorum loss during a rolling restart)
  or requires intervention (suspected compromise).
- Data-loss risk: is anything being written that will need to be reconciled?
- **Whether cancelling is safe** — per RUN-06, retries are at-least-once and
  already-performed side effects are not rolled back.

### 3. Triage decision tree

Explicit branches with yes/no criteria. At minimum:

- Is this the local node or a peer?
- Is the condition recovering on its own? (how long to wait before acting)
- Does the audit trail still verify? (per DATA-07 it may not)
- Is secret material possibly involved? (escalate to a different runbook)

### 4. Remediation

For each action: the **exact** operator command or API call, the expected
outcome, and how to verify it worked.

All commands MUST exist. Verify before writing — `docs/canary-deployment.md`
currently references `pnpm backup:restore` and `kubectl rollout undo`, **neither of
which exists in this repository**, and `kubectl` is inconsistent with a
Replit-hosted deployment.

### 5. Abort / rollback

What to do if a remediation step makes things worse. Every destructive step MUST
have a documented reversal. Note per DATA-04 that **restore is not reversible in
the current implementation**: it deletes all rows from ten tables including
`audit_events`, and it restores `local_node_identity` verbatim. Operators must be
told this before running it.

### 6. Escalation

- **SEV level** and the criterion that set it (per OPS-10).
- Responder role, channel, acknowledgement timer, time-to-mitigate target.
- When to page vs. open a ticket.
- When to declare an incident and convene an incident commander.

### 7. Post-incident

- What evidence to preserve **before** remediation (audit export per OPS-18,
  snapshot, node identity material).
- Whether a postmortem is required (OPS-10: SEV1 and SEV2).
- Which follow-up requirements in `todo.md` this incident validates.

---

## On-call readiness (OPS-10)

A runbook set is not sufficient. Readiness additionally requires:

- An incident severity scale (SEV1–SEV5) with explicit criteria.
- A page-or-ticket mapping for every alert severity.
- Acknowledgement and escalation timers per severity.
- Named responder role, channel, and time-to-mitigate target per severity.
- **At least one completed game-day exercising the SEV1 (quorum loss) path end to
  end**, recorded as release-gate evidence.

Note that `AlertSeverity` currently has only three values (`info`, `warning`,
`critical`). Three levels cannot express a real rotation: quorum loss and suspected
compromise are both `critical`, but the first is a known recoverable state with a
documented recovery path while the second may indicate active exfiltration and
requires isolation and evidence preservation — **not** a restart.

---

## Runbook authoring notes for this codebase

These are landmines an author must account for; each has been observed in review.

| Trap | Consequence | Requirement |
|---|---|---|
| An unused mechanism is not a control | ~20 security functions have zero callers; the observability package is not even a declared dependency of the server | PROV-03 |
| Peer-facing error messages echo the expected cluster ID | Turns the node into a cluster-join oracle | NET-16 |
| `/healthz` returns a hardcoded `{status:"ok"}` | Cannot be used as a liveness signal for any decision | API-13 |
| `opennode status` and `opennode peer-status` call endpoints that return 404 | Every diagnostic command fails | API-08, UX-13 |
| Two disjoint `FeatureFlags` instances | Kill switch and flag endpoints have no effect on execution | CFG-01 |
| `TransportHealth.lastError` is never assigned | The field designed to carry the root cause is never populated | NET-14 |
| `syncStatus` is a hardcoded `"local_only"` | Sync state is invisible everywhere | SYNC-12 |
| `/membership/status` hardcodes `quarantinedNodeId: null` | Quarantine is invisible | GOV-12 |
| `getLocalNodeId()` returns the literal `"local"` | Every node has the same membership and lease identity | GOV-21 |
| `observeAttempt` has no callers | No run ever reaches a terminal state; 9th submission permanently 429s | RUN-21 |
| CLI `logout` throws `ReferenceError` (`require` in ESM) | Credentials are never actually removed | API-09 |
| CLI reports "Token stored in OS credential store" | False — it writes `~/.opennode/credentials.json` | API-09 |
| `.replit` sets `deploymentTarget = "autoscale"` | Scale-to-zero is incompatible with durable inbound peer streams and graceful shutdown | LIFE-02, Gate 4 |
| `PORT` is required but undocumented | The documented run command throws on a clean checkout | LIFE-01 |
| Backups render every timestamp as `{}` | Restore does not round-trip; log/proposal/lease ordering is destroyed | DATA-03 |
| `restoreFromFile` clones another node's identity | Restoring the wrong backup duplicates a node identity | DATA-04, NET-02 |
| Lease TTL is 30 s, max duration is 24 h | Every run over 30 s is fenced and re-executed | RUN-03 |
| No metric has a producer | Every alert sits permanently `pending` | OPS-03 |

---

*Requirements: `todo.md` (OPS-04, OPS-09, OPS-10). Gates: `docs/release-gates.md`.
SLOs: `docs/slos.md`.*
