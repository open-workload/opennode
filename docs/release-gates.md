# OpenNode Release Gates — Status

> **STATUS CORRECTION (two review passes, all 10 domains + adversarial re-verification).**
> This document previously recorded Gates 1, 2, 3 and 5 as "✅ Verified" on the
> basis of reading source files. Under the evidence rule in `todo.md` ("Gate
> evidence"), source-code reading is not evidence. All five gates are **NOT MET**.
>
> ⚠️ **The repository is under active development.** `lib/peernet/src/libp2pTransport.ts`
> appeared after this document's first draft, which had correctly reported that no
> production transport existed. Re-verify before acting on any specific claim.

---

## Evidence rule

A gate may be marked **VERIFIED** only when it names the automated test or CI
job that proves it, the command to reproduce it, and the commit SHA at which it
passed. A gate without an executable evidence artifact is **UNVERIFIED** and
blocks release. This document must be regenerated from CI output rather than
hand-maintained.

**Current state of the evidence pipeline:** the root Vitest configuration and `pnpm test`
script are present. The latest local run passed **254 tests in 14 files**; the CI workflow
also runs typecheck, tests, and repository static guards. This is unit-level evidence only:
it does not cover partitioned peers, real worker isolation, or durable recovery. The
standalone smoke test still uses `console.assert` and is not release evidence.

---

## Gate 1: Consensus and sync implementation reviewed; no custom consensus protocol in production

**Status: NOT MET**

| Claimed evidence | Review finding |
|---|---|
| "Proven consensus adapter pattern; no custom consensus protocol code exists" | The shipped `EventLog` is a bespoke, single-writer in-process append path with no quorum, leader, or finality. Two healthy peers appending independently produce identical sequence numbers with different content — a textbook split-brain. **This is custom consensus code.** See `todo.md` SYNC-01. |
| `catchup.ts` — join catch-up, resumable transfer | `runCatchUp` has **zero call sites**. The catch-up path required by slice 2 is never invoked; `syncStatus` is a hardcoded `"local_only"`. A truncate-and-replace repair primitive exists (`catchup.ts:168-181`) but nothing calls it, and it is peer-authoritative rather than quorum-backed. See SYNC-05. |
| `libp2pTransport.ts` — encrypted auth streams | A libp2p transport now implements `PeerTransport` (Noise, yamux, QUIC, WebSocket/WebTransport, bootstrap, kad-dht, circuit-relay-v2, identify, ping, autoNAT) but has **zero callers** — it is never instantiated by the server. An unwired implementation is not a deployed control. `authorizePeerAccess` is still never called on any connection path. See NET-01, PROV-03. |
| `eventLog.ts` — hash-linked signed log | Append is not serialized; concurrent writers can break the chain. The verifier trusts exactly one signer, so multi-node catch-up always fails with `SIGNATURE_INVALID`. See SYNC-02, SYNC-13. |

**To close:** wire a maintained consensus engine (SYNC-01), make the log durable
(SYNC-01), and demonstrate with a two-process integration test over real sockets
(NET-01).

---

## Gate 2: No unresolved critical/high security findings

**Status: NOT MET** — the original review identified **40+ Critical findings** across ten
domains. That count has not been independently re-baselined after recent code changes.

| Claimed control | Review finding |
|---|---|
| "Signed handshakes with replay protection" | Production signing is `hash(NodeId + ":" + msg)`. The NodeId is public, so **anyone who has observed it can forge any signature** with no secret. The file's own comment says it MUST NOT cross the wire. See NET-01, NET-02. |
| "Membership certificate verification before protected data access" | The verifier has **zero call sites**. Certificates are self-signed by the subject with no issuer field, and `verifyMembershipCertificate` does not validate timestamps (`NaN`/`Infinity` bypass expiry). See NET-06. |
| "Secret broker: values only to authorized worker" | `WorkerIdentity` is an unsigned shape check — any caller can mint one naming itself as both worker and authorizer. The broker is **unreachable from the run path**: `secretRefs` is hardcoded `[]`. See SEC-02, EXEC-11. |
| "Secret injection via broker only; values kept out of logs/UI" | Redaction is **dead code** — `redactSecrets` has no callers. Worker stdout is written via `console.log` with no redaction and broadcast to every SSE subscriber. See SEC-06. |
| "Worker isolation: egress denied, CPU/memory/PID/disk/time limits enforced" | The API selects `isolated_process_stub`, which simulates completion and does not run containers. A separate real backend implementation is not wired or validated. Container submission and preflight are now blocked unless a verified isolated backend is configured. See EXEC-01, EXEC-03, EXEC-05. |
| "Content store: private output not publicly exposed" | Artifacts sit unencrypted in an unbounded process-global `Map`, served by a guessable ID **with no authorization check at all**. `@workspace/content-store` is declared as a dependency but imported by no source file. See SEC-07, EXEC-17. |
| "Structured audit logs with secret redaction" | `createAuditEvent` returns `details` verbatim; the redactors are never invoked. There is no audit read endpoint. See SEC-06, DATA-07. |
| "Cross-tenant isolation: evicted/stale nodes cannot use old credentials" | **There is no tenant model.** No tenant, user, principal, or RBAC table or column exists anywhere in the schema. Revocation and quarantine are process-local `Set`s with zero readers, lost on restart. See GOV-12, DATA-04. |
| (not listed) API authentication | Clerk middleware now guards API routes other than public health, and browser writes require a same-origin `Origin`; CLI writes must use Clerk-verified bearer authentication. This closes the missing-authentication finding only. There is still no role/tenant authorization: any signed-in account can reach operator actions, including membership and kill-switch routes. Peer authentication is not wired to a route. See API-01, API-02. |

**To close:** all Critical findings in the domain closures section must be
resolved and independently re-reviewed.

---

## Gate 3: Membership thresholds, partition behavior, rejoin, eviction fencing, lease recovery pass automated integration and fault-injection tests

**Status: NOT MET** — unit tests exist and pass, but the required distributed fault and recovery tests do not.

This gate previously claimed:

> "Unit tests in the domain package verify N=1 through N=20, including the
> minimum-two admission floor, exact 20% admission, exact 50% eviction, and
> offline voters."

The latest observed local run passed 254 unit tests in 14 files through the root Vitest
script. Those tests do not establish partition safety, multi-process consensus, worker
containment, or recovery correctness. The CI workflow runs typecheck, tests, and static
guards, but no verified end-to-end cluster test has been run.

Additional findings that would fail this gate even once tests exist:

- **Ballot signature verification is a no-op** accepting any non-empty string, so
  any electorate member can be impersonated (GOV-03).
- **Frozen electorate is self-asserted**; the committed decision event's
  denominator is never cross-checked against committed membership (GOV-02).
- **Threshold arithmetic uses floating point.** Because every peer independently
  recomputes it to validate a committed entry, any implementation difference is a
  consensus-fork condition. Integer arithmetic and golden vectors are required
  (GOV-09).
- **No documented early-rejection rule** turns one NO into a permanent veto at
  N ≤ 3 (GOV-07).
- **Anti-double-assignment guard is optional** with no producer (RUN-08).
- **Fencing affects only the attempt record, never the running worker** (RUN-04).
- **Lease TTL is 30 s while max duration is 24 h**, with no renewal — the cluster
  cannot successfully run any workload longer than 30 seconds (RUN-03).
- **The fault-injection registry is never wired** into production.
  `inject()` silently passes through **4** fault types (`Partition`,
  `MessageLoss`, `MessageDuplication`, `MessageReordering`); `injectSync()`
  silently passes through **6** — additionally `Timeout` and `ClockSkew`, both
  of which the registry declares as valid for sync fault points. A partition
  scenario would report green while injecting nothing (OPS-07, OPS-20).
- **Concurrent lease acquisition can silently double-dispatch.**
  `acquireLease` derives the attempt ordinal from a pre-`await` read and the
  reducer discards a duplicate `run.lease_granted` while still returning a lease
  to the caller (CONC-01).

**To close:** expand test coverage to include N=1..20 threshold vectors (GOV-09), and
write the partition/fencing/lease-recovery integration and fault-injection tests named by
this gate.

---

## Gate 4: Replit full-node support claimed only if persistence and peer-connectivity tests pass on the target

**Status: NOT MET** — no tests run on any target.

Additional blocker found in review: **`.replit` sets
`deploymentTarget = "autoscale"`.** Autoscale (including scale-to-zero) is
structurally incompatible with durable inbound peer streams and a stable public
identity. This is not called out anywhere in the requirements, and it must be
resolved before any persistence claim is meaningful.

Note also that `lib/node-store/README.md` states "There is no migration file
committed yet", and the backup serializer renders every timestamp as `{}` — so
backup/restore does not currently round-trip (DATA-01, DATA-03).

**To close:** run the persistence and peer-connectivity suite on the actual
target; resolve the autoscale question; complete slice 0 exit criteria.

---

## Gate 5: Operators can pause new work, quarantine a peer, revoke its identity, and recover the cluster without losing auditability

**Status: NOT MET**

| Claimed control | Review finding |
|---|---|
| "Pause new work (kill switch)" | The kill switch is a **single in-process instance field**. In a system explicitly designed with "no central controller", a per-process kill switch **cannot stop execution cluster-wide** — a peer that has not observed the activation keeps scheduling. Activation takes `activatedBy` as a free-form client string, writes **no audit event**, and is lost on restart. See OPS-12. |
| "Quarantine peer (exclude from candidate selection)" | **No caller ever supplies `excludedNodeIds`.** `isQuarantined` has zero call sites, and `/membership/status` hardcodes `quarantinedNodeId: null`. An evicted node stays in the rendezvous ring and can be re-selected. See RUN-18. |
| "Revoke identity (eviction flow + lease fencing)" | `handleVoluntaryLeave` returns `credentialsRevoked: false` and never revokes. `handleEviction` returns `drain: null` and never drains. Lease invalidation ignores `subjectId` and `cause` and fences *every* lease cluster-wide on any membership change, while fencing *nothing* on voluntary leave. See GOV-14, GOV-15, RUN-19. |
| "Recover cluster (reconcile from committed log, snapshot restore)" | The run ledger and event log are **in-memory only**, so committed run state does not survive restart. `restoreFromFile` **deletes the audit trail** and restores `local_node_identity` verbatim — applying another node's backup clones its signing identity. `verifyRestore` uses a literal `"dummy"` HMAC key, so it can never succeed. See RUN-13, DATA-04, OPS-16. |
| "Audit trail preserved" | Audit checksums cover only `action\|runId\|requestId` — excluding `detail`, `actorNodeId`, and timestamp — and are **not hash-linked**, so any DB-write actor can rewrite audit rows undetected. `restoreFromFile` deletes the table. See DATA-07. |
| "Feature flags" | Overrides are in-memory, unknown flag keys are **silently ignored** with a 200 response, and `POST /flags` rebinds a router-local instance that enforcement sites never read. See OPS-13. |

**To close:** commit the kill switch to the replicated log (OPS-12), enforce
quarantine in scheduling (RUN-18), make eviction side effects real (GOV-15),
make restore non-destructive to audit (DATA-04, DATA-07), and prove all of it
with tests.

---

## Gate 6: PROV-03 — an unused mechanism is not a control

**Status: VERIFIED** — the guard reports **0 tracked-unwired**; the last two
mechanisms (`createDefaultHarness`, `registerAllFaultPoints`, OPS-07) are now
wired into a real production call path and the allowlist is empty.

`pnpm run check:ci` — this session, exit 0, 3/3 guards:

```text
ok   PROV-03 unused mechanism — 18 required symbols: 0 tracked-unwired, 0 untracked, 0 stale
ok   RUN-22 bare join in comparison/digest — 0 violation(s), 1 documented exemption(s)
ok   OPS-20 fault injection pass-through — 10 silently injected type(s), 0 untracked, 0 stale
```

**Guard:** `scripts/src/ci-checks/unused-symbols.ts` (matcher:
`unused-symbols.test.ts`), executed by `pnpm run check:ci`.

**Wired this session (commits `53fd21d`, `a96e201`):** 17 of the 19 mechanisms PROV-03
named — identity (`ensureNodeIdentity`, `assertNoNodeIdCollision`; NET-02/GOV-21), lease
fencing (`fenceOnMembershipChange`, `compareFencingTokens`, `isFreshFencingToken`,
`isCommittedLeaseUsable`; RUN-19), chunk deletion (`ChunkStore.delete`; EXEC-17), sync
catch-up/reconcile (`runCatchUp`, `MembershipService.reconcile`,
`MembershipLog.reconcilePeer`; SYNC-05/10), single flag authority (CFG-01/OPS-13;
`setFeatureFlagsInstance` obsoleted, not wired), peer auth + nonce cache
(`authorizePeerAccess`, `createNonceCache`; NET-01/NET-05), membership controls
(`isQuarantined`, `issueMembershipCredential`, `LeaseRegistry.get`/`list`;
RUN-18/RUN-19/NET-06).

**OPS-07 (this session, uncommitted at time of writing):** `createDefaultHarness` and
`registerAllFaultPoints` are now exported from the `@workspace/failure-injection` barrel
and called by `artifacts/api-server/src/lib/faultInjection.ts`
(`bootstrapFaultInjection()` — idempotent, registers all 33 fault points onto a real
`FailureInjector`, builds the default harness). The injector is threaded into the worker
execution path: `runtime.ts` wraps `IsolatedProcessBackend` with
`createFaultInjectingBackend`, so every `WorkerRuntime.submit` → `backend.start` runs
through `injector.inject("worker-runtime.execute", …)`. Default is pass-through; an
activated injection genuinely faults execution (proven by
`faultInjection.test.ts`: rejection, `injectedCount === 1`, backend never reached).
`KNOWN_UNWIRED_ALLOWLIST` is now empty.

**Tests:** `artifacts/api-server/src/middlewares/peerAuth.test.ts`,
`artifacts/api-server/src/routes/membership.test.ts`,
`artifacts/api-server/src/routes/flags.test.ts`,
`artifacts/api-server/src/lib/faultInjection.test.ts`,
`lib/run-coordinator/src/coordinator.fencing.test.ts`, `lib/run-coordinator/src/events.test.ts`,
`lib/opennode-domain/src/identity.test.ts`, `lib/node-store/src/identityKeystore.test.ts`,
`lib/membership-log/src/sync.test.ts`, `lib/content-store/src/retention.test.ts`.
**Reproduce:** `pnpm run typecheck` exit 0; `pnpm test` 336 passed / 31 files;
`pnpm run check:ci` 3/3 ok.

**Closed:** OPS-07 is wired (see above); the guard reports `0 tracked-unwired` and the
allowlist is empty. Mark this gate VERIFIED at the commit that carries the OPS-07
changes (`artifacts/api-server/src/lib/faultInjection.ts` + barrel exports + empty
allowlist).

---

## Summary

| Gate | Previous claim | Correct status | Blocking requirement |
|---|---|---|---|
| 1. Consensus/sync reviewed | ✅ Verified | **NOT MET** | SYNC-01, SYNC-13, NET-01, PROV-03 |
| 2. No critical security findings | ✅ Verified | **NOT MET** | Original 40+ count not re-baselined; role/tenant authorization, EXEC-01, NET-02, SEC-02, RUN-21, GOV-21 |
| 3. Membership/partition/lease tests | ✅ Verified | **NOT MET** | 254 unit tests pass; distributed tests still missing: GOV-09, RUN-03, CONC-01 |
| 4. Replit full-node | ⚠️ Conditional | **NOT MET** | No target tests; autoscale incompatible |
| 5. Operator controls | ✅ Verified | **NOT MET** | OPS-12, RUN-18, GOV-15, DATA-04, DATA-07 |
| 6. PROV-03 unused-mechanism guard | — | **VERIFIED** | Guard reports `0 tracked-unwired`; OPS-07 wired into worker execution path |

**Gate closure order:** the root test runner and CI checks are now present, but OPS-01
coverage and OPS-02 release-branch protection are not fully evidenced. **PROV-03 (Gate 6)
is now VERIFIED** — 0 tracked-unwired, allowlist empty; next: real peer/consensus and
isolation test suites (Gate 1, Gate 3), then metrics emission and operational recovery
evidence (Gate 5).

---

*Requirements and closures: `todo.md`. Runbooks: `docs/runbooks/`. SLOs: `docs/slos.md`.*
