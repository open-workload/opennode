# Canary Deployment Test Plan

> ⚠️ **The repository is under active development.** Several claims in this
> document went stale within hours of being written — `lib/peernet/src/libp2pTransport.ts`
> appeared after the first draft had correctly reported that no production transport
> existed. Every factual claim below was verified against source on **2026-10-09**; treat
> unverified specifics as suspect and re-check before relying on them.

> **STATUS (domain review): this plan cannot currently be executed, and several of
> its assertions assert guarantees the system explicitly disclaims.**
>
> Specific defects found:
>
> 1. **The automation snippet does not compile.** It imports `NetworkPartition`
>    from `@workspace/failure-injection`; that export does not exist. It calls a
>    two-argument `inject()` with a shape the real `inject()` does not accept.
> 2. **`pnpm test:canary` does not exist**, and neither does `.github/workflows/`.
> 3. **`pnpm backup:restore` does not exist**; neither does `kubectl`, which is
>    inconsistent with a Replit-hosted deployment (`.replit` sets
>    `deploymentTarget = "autoscale"`).
> 4. **All five metrics in the monitoring table are invented.** None appears
>    anywhere outside that table, and all five use a naming convention
>    (`run_lease_fenced_total`) that differs from the alert rules
>    (`run_coordinator.lease_expiry`).
> 5. **Scenario 4b asserts "at-most-once semantics (no duplicate execution)"**,
>    which `todo.md` RUN-06 explicitly disclaims — retries are at-least-once.
> 6. **No test runner exists anywhere in the repository**, so none of these
>    scenarios has an executable harness.
>
> The scenarios themselves are well-chosen and worth keeping. They are preserved
> below with defects annotated, and each now names the requirement that must be
> satisfied before it can run.

**Prerequisite: OPS-01 (test runner) → OPS-02 (CI) → SYNC-01 (real consensus).**
Until a real consensus engine is wired, scenario 4d (split brain) cannot pass for
the right reason, and 4c (leader minority) has no leader to partition.

---

## Test Environment

- **Cluster size:** 5 nodes minimum (3 for quorum, 2 for partition scenarios).
- **Network partition tool:** `tc` / `iptables`.
- **Orchestration:** `@workspace/failure-injection` — ⚠️ **the registry is never
  wired into production**, and four fault types (`Partition`, `MessageLoss`,
  `MessageDuplication`, `MessageReordering`) fall through to a **silent
  pass-through**. Scenarios 1–5 configure exactly those types, so they would
  report **green while injecting nothing**. Fix: **OPS-07, OPS-20**.
- **Metrics:** `@workspace/observability` — ⚠️ **no metrics are emitted anywhere**;
  the production exporter is a no-op. Fix: **OPS-03**. Canonical names:
  `docs/slos.md`.

## Cross-cutting test doubles

Three things must exist before any scenario below is meaningful:

| Requirement | Needed for | Status |
|---|---|---|
| Deterministic consensus simulator (SYNC-01) | 4c, 4d — there is no leader to partition without one | ❌ |
| Injected `Clock` (OPS-15) | Lease expiry, proposal TTL, cooldown windows — currently `RUN_LEASE_TTL_MS = 30_000` and `PROPOSAL_TTL_MS = 24h`, so tests would sleep for real | ❌ |
| Wire-format test vectors (SYNC-11) | Every scenario — `stableStringify` is not JSON-round-trip stable, so cross-node comparison fails on optional fields | ❌ |

---

## Test Scenarios

### 1. Node Join Under Partition

**Objective:** A new node joins while partitions exist; it either succeeds or is
safely rejected without corrupting state.

1. Start 3-node cluster, verify quorum.
2. Partition candidate D from leader A via `tc qdisc … netem loss 100%`.
3. Submit admission proposal for D from B.
4. Vote from B and C.
5. Verify D either joins cleanly or the proposal expires cleanly.
6. Heal partition, verify D's membership converges.

**Success criteria:** no split-brain membership; no duplicate NodeIds; existing
cluster unaffected.

**Known blockers — this scenario cannot pass today:**

| Assertion | Why it fails | Requirement |
|---|---|---|
| "Submit admission proposal for D" and "vote from B and C" | **Ballots cannot be cast by any peer other than the local node.** `voterId` is hardcoded to `g.localNodeId`; there is no peer ballot relay. For N ≥ 2 the admission threshold is ≥ 2, so **no proposal can ever pass**. | GOV-17, RUN-08 |
| "verify gossip propagates membership changes" | Gossip messages are unsigned and `rumorId` is unbound to `originId`. Membership is not gossiped. | NET-07 |
| "no duplicate node IDs" | Collision detection has zero callers; the identity table is never written. | NET-02 |
| "verify quorum established" | There is no quorum check — `reconcilePeer` has zero callers. | SYNC-10 |

### 2. Voluntary Leave Under Partition

**Objective:** A node leaves during a partition without data loss or inconsistency.

1. 4-node cluster (A, B, C, D); submit workloads to create active runs.
2. Partition D from B, C (D ↔ A connected).
3. On D, invoke `POST /membership/leave`.
4. Verify D stops accepting new assignments.
5. Verify D drains active runs.
6. Verify the leave is committed by quorum.

**Known blockers:**

| Assertion | Why it fails | Requirement |
|---|---|---|
| "verify D stops accepting new assignments" | A **single global process-wide boolean** is flipped. Nothing ever sets it back — after a voluntary leave the node is permanently closed, and `acceptsNewAssignments()` keeps reporting state that cannot be reversed. | GOV-14, GOV-15 |
| "verify D drains active runs" | The injected drainer **counts rows and returns without stopping anything**; it reports `relinquished: 0`. The count reads only the first 100 rows. | GOV-14 |
| "verify the leave is committed by quorum" | The domain mutates **before** the log append. The leave also advances the epoch, killing every other open proposal. | GOV-13, GOV-05 |
| (implied) credentials revoked | `handleVoluntaryLeave` returns `credentialsRevoked: false` and never revokes. | GOV-14 |

### 3. Eviction Under Partition

**Objective:** An isolated node is evicted; the cluster remains consistent.

**Known blockers:**

| Assertion | Why it fails | Requirement |
|---|---|---|
| "verify eviction response recorded" | The target's response is stored in memory only, is **never returned by any endpoint**, is absent from the committed payload, and is invisible in the UI. | GOV-18 |
| "verify eviction commits or is invalidated cleanly" | An **undocumented early-rejection rule** makes one NO a permanent veto at N ≤ 3. | GOV-07 |
| "verify target's leases fenced" | Lease invalidation ignores subject and cause, and **voluntary leave fences nothing**. | RUN-19 |
| "verify quarantine applied" | `isQuarantined` has zero callers; `/membership/status` hardcodes `quarantinedNodeId: null`. | RUN-18, GOV-12 |
| "verify target cannot receive new work" | `excludedNodeIds` has no producer — an evicted node stays in the rendezvous ring. | RUN-18 |

### 4. Run Submission and Scheduling Under Partition

#### 4a. Client Partitioned from Leader
Submit via B; verify acceptance, forwarding, lease grant, and execution start.

**Blockers:** there is no leader. `EventLog.appendEvent` is a single-writer local
append with no forwarding. **RUN-01, SYNC-01**

#### 4b. Worker Partitioned During Execution

> ⚠️ **CORRECTED ASSERTION.** The previous plan asserted *"Verify at-most-once
> semantics (no duplicate execution)."* This contradicts `todo.md` RUN-06, which
> requires retries to be treated as **at-least-once** and explicitly forbids
> promising exactly-once external side effects. Asserting at-most-once here would
> make the canary fail on correct behaviour.

**Corrected:** verify the partitioned worker is **fenced**, that a new attempt is
scheduled, and that the duplicate is **detected, attributed, and surfaced** — not
that it is impossible.

**Blockers:**

| Assertion | Why it fails | Requirement |
|---|---|---|
| "reconciliation detects lost worker (after lease TTL)" | `reconcile()` has **one caller: an unauthenticated HTTP endpoint**. Nothing schedules it. Detection never happens on its own. | RUN-08, OPS-01 |
| "verify run is fenced and rescheduled" | Fencing updates the **record only** — the container keeps running and keeps emitting output under the same run ID. | RUN-04 |
| "after lease TTL" | TTL is **30 s** while max duration is 24 h, with no renewal. Any partition over 30 s orphans the workload. | RUN-03 |
| duplicate detection | The fencing token is the **global log height** and worker reports are **unauthenticated** — a guessed token can mark an attempt succeeded. | RUN-05 |

#### 4c. Leader Partitioned (Minority)

**Blockers:** no leader exists to partition, and the anti-double-assignment guard
is an **optional `peerClaim` argument with no producer**. A not-yet-caught-up
minority mints a conflicting lease. **RUN-08, SYNC-01**

#### 4d. Split Brain Prevention

Create `{A,B}` vs `{C,D}`; verify neither side grants leases; heal and converge.

**Blockers:** **this is the scenario the bespoke log fails outright.** Two peers
each append locally at the same sequence with different content. Additionally,
`BROKEN_HASH_LINK` at a chunk boundary has **no defined recovery path** — the node
requires manual database surgery. **SYNC-01, SYNC-02, SYNC-06**

**Flag note:** `execution.new_runs_enabled (both false)` and
`execution.max_concurrent_runs` — ⚠️ `POST /flags` **rebinds a router-local
instance that enforcement sites never read**, so setting a flag here has no effect
on behaviour. **OPS-13**

---

### 5. Combined Scenarios

**5a. Leave during workload execution.** Verify runs are drained before leave
commits. ❌ Drain is simulated; nothing is relinquished. **RUN-19, GOV-14**

**5b. Eviction during partition healing.** Verify eviction commits or invalidates
cleanly. ❌ No finalization sweep exists — a proposal that passes via another route
is never committed, and one that expires is never closed. **GOV-19**

**5c. Kill switch during partition.**

> ⚠️ **This scenario asserts a guarantee the architecture cannot provide.** The
> kill switch is a **single in-process instance field**, and OpenNode is explicitly
> built with "no permanent central controller". A peer that has not observed the
> activation **keeps scheduling**. Activation also takes `activatedBy` as a
> free-form client string and writes **no audit event**. **OPS-12**

---

## Automation — corrected

The previous snippet did not compile. The real API is
`injector.inject(faultPointName, operation)`, and `NetworkPartition` does not exist.

> ⚠️ **No runnable harness exists yet.** The snippet below shows the *intended* shape and
> is annotated with what is currently missing. It is illustrative, not executable — do not
> copy it expecting it to run.

```typescript
// ⚠️ The package barrel exports only:
//   FailureInjector, FaultType, FaultConfig, FaultInjection,
//   FailureInjectionHarness, HarnessConfig, HarnessScenario,
//   registerFaultPoints, getRegisteredFaultPoints, clearFaultPoints
// registerAllFaultPoints and createDefaultHarness exist in their modules but are NOT
// re-exported, so importing them from the package fails with TS2305.
import { FailureInjector, FaultType, registerFaultPoints } from "@workspace/failure-injection";

registerFaultPoints(/* ... */);          // ⚠️ zero production call sites today
const injector = new FailureInjector();

// ⚠️ inject() silently passes through 4 unimplemented fault types (Partition,
// MessageLoss, MessageDuplication, MessageReordering); injectSync() passes through 6
// (those plus Timeout and ClockSkew). Both use `default: return operation()`.
// A scenario built on one of them reports GREEN while injecting nothing.
// Fix: OPS-07 (reject unimplemented FaultType at configuration time) and
//      OPS-20 (assert every fault point has a real call site).

// Scenario 4b, corrected for at-least-once semantics.
// ⚠️ Use a fault point name that is actually registered in
// lib/failure-injection/src/registry.ts, e.g. "run-coordinator.acquire_lease".
// An unregistered name returns false from shouldInject() and SILENTLY NO-OPS.
await injector.inject("run-coordinator.acquire_lease", async () => {
  const runId = await submitRun({ image: DIGEST_PINNED_SAMPLE });
  await waitForLease(runId);
  await clock.advance(LEASE_TTL_MS * 1.5);   // injected Clock, OPS-15/TIME-01

  const state = await coordinator.getState();
  const attempt = state.attempts.find((a) => a.runId === runId);
  expect(attempt?.fencedReason).toBe("lease_expired");
  // ⚠️ Today: reconcile() is reachable only via an unauthenticated route that accepts
  // caller-supplied `now`; fencing touches the record only, never the worker.
  // See RUN-04, RUN-08, TIME-02.
});
```

**Three ways this silently reports success without testing anything** — all must be
closed by OPS-07 and OPS-20 before any canary result is trustworthy: an unimplemented
`FaultType`, an unregistered fault-point name, and a producer that emits a metric name
no collector receives.

## CI integration — corrected

⚠️ **None of this exists.** No `.github/`, `.gitlab-ci.yml`, or `.circleci/`. The
only automation is a Replit `[postMerge]` hook running `pnpm install` and
`pnpm --filter db push` — which runs *after* merge, with **no typecheck, no test,
and no build gate**, and mutates live schemas without a migration lock.

Required workflow (`todo.md` OPS-02):

```yaml
name: Canary Deployment Tests
on:
  schedule: [{ cron: '0 2 * * *' }]   # daily
  workflow_dispatch:
jobs:
  canary-tests:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm -r test          # does not exist yet — OPS-01
      - run: pnpm build
      - run: pnpm test:canary       # does not exist yet
        env:
          OPENNODE_CLUSTER_ID: canary-test
          # ⚠️ Deployment manifests must NOT supply signing keys via env (NET-02).
          # Signing material comes from the keystore.
```

## Rollback — corrected

| # | Previous command | Status |
|---|---|---|
| 1 | `curl -X POST /api/flags/kill-switch/activate -d '{"reason":…,"activatedBy":"oncall"}'` | ⚠️ Reachable but **unauthenticated and unroled**; `activatedBy` is attacker-controlled; **no audit event**; **per-process only**. **API-04, OPS-12** |
| 2 | `kubectl rollout undo deployment/opennode-api` | ❌ No Kubernetes manifests exist; `.replit` uses `deploymentTarget = "autoscale"`. |
| 3 | `pnpm backup:restore --backup-path … --verify` | ❌ **No such script.** `scripts/package.json` defines only `hello` and `typecheck`. The real path is `scripts/backup.ts`, whose `verifyRestore` uses a literal `"dummy"` HMAC key and **can never succeed**. **OPS-16** |

> ⚠️ **Rollback destroys audit history.** `restoreFromFile` deletes all rows from
> ten tables including `audit_events`, then re-inserts from the backup — so any
> audit written after the backup point is **permanently lost**. It also restores
> `local_node_identity` **verbatim**, so restoring the wrong backup **clones a node
> identity**. Operators must be told this before running it. **DATA-04, DATA-07**

## Metrics to monitor — corrected

⚠️ **All five names below are invented.** None appears outside this table, and all
five use a different convention from `lib/observability/src/alertRules.ts`. **None
has a producing call site.** Canonical names: `docs/slos.md`. Requirement: **OPS-03, OPS-05**.

| Previous name (invented) | Nearest **existing** rule metric | Has a producer? |
|---|---|---|
| `cluster_membership_epoch` | *(no rule metric)* | ❌ |
| `run_lease_fenced_total` | `run_coordinator.lease_ttl_ms` | ❌ |
| `run_submission_rejected_total` | `run_coordinator.duplicate_submissions` | ❌ |
| `gossip_message_dropped_total` | *(no rule metric)* | ❌ |
| `feature_flag_kill_switch_active` | *(no rule — does not exist)* | ❌ |

> ⚠️ **Do not treat the middle column as a rename plan.** Those are the metrics the
> *existing* 15 alert rules reference; several do not measure what the original canary
> names were after, and two original names have no counterpart at all. The naming
> convention in `docs/slos.md` has **not** been applied to the code, and `docs/slos.md`
> deliberately does not invent replacement names for unimplemented signals. Adopting the
> convention is part of OPS-03; until then, every metric above has no producer.

> ⚠️ **`peer.anomaly_score` has no scorer anywhere in the codebase**, so
> `peer.suspected_compromised` can never fire — the compromised-peer canary has no
> signal. **NET-07, OPS-03**

## Exit criteria for this plan

The canary plan may be marked executed only when:

1. Every scenario above has an executable test that **fails** today (OPS-01, OPS-02).
2. Every blocker's requirement is closed.
3. Scenario 4b asserts at-least-once semantics with duplicate **detection**, not
   the current at-most-once claim.
4. Scenario 5c proves the kill switch blocks execution on **all** peers including
   across a partition (OPS-12).
5. Scenario 4d proves no split brain against a **real** consensus engine (SYNC-01).
6. Every metric in the monitoring table has a producing call site, or CI fails
   (OPS-03).
7. The rollback procedure names commands that exist, and restore is non-destructive
   to audit (OPS-16, DATA-07).

---

*Requirements: `todo.md`. Gates: `docs/release-gates.md`. SLOs: `docs/slos.md`.*
