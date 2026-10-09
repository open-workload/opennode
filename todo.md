# OpenNode — implementation TODO and enterprise requirements

Status: **planning and partial implementation.** Slices 0–5 contain code, but a
domain-by-domain review found that many `[x]` items below were marked complete on
the basis of source-code reading rather than executable evidence. This document has
been corrected against that review, and every newly identified UX loophole,
limitation, and edge case has been closed with a normative requirement
(`MUST`/`MUST NOT`/`SHOULD`) in the domain sections at the end.

**Verification legend**

- `[x]` — implemented **and** covered by a named, runnable test or CI job.
- `[~]` — code exists, but the requirement is not proven and/or is partially
  implemented. Requires the closures in this document before it may be marked `[x]`.
- `[ ]` — not implemented.

> **Correction notice.** `docs/release-gates.md` previously recorded several gates
> as "✅ Verified". No test runner exists in this repository, so those gates have no
> executable evidence and have been downgraded. See "Gate evidence" below.

### Document index

| Document | Purpose | Status |
|---|---|---|
| `todo.md` | This file — requirements and the source of truth for every closure | 176 requirements |
| `docs/release-gates.md` | Release gate status and the evidence rule | All 5 **NOT MET** |
| `docs/threat-model.md` | 8 threat classes × 54 claimed mitigations | 6 of 54 implemented |
| `docs/selections.md` | Peer-network and consensus selection rationale | Both **NOT SELECTED** |
| `docs/replit-deployment.md` | Deployment target assessment | Replit = UI/client only |
| `docs/canary-deployment.md` | Partition test scenarios | Blocked; scenarios preserved |
| `docs/slos.md` | SLIs, SLOs, alert→SLO mapping | None instrumented |
| `docs/runbooks/README.md` | Required runbooks and template | 14 required, none written |

Requirement IDs (`GOV-`, `NET-`, `SYNC-`, `RUN-`, `EXEC-`, `SEC-`, `API-`, `DATA-`,
`UX-`, `OPS-`) are the shared vocabulary across all documents. Cite them rather
than restating a rule.

### Closure order

Sequenced so that each stage unblocks the next. Stage 1 has no prerequisites;
nothing else in this list can be evidenced until Stage 4 lands.

| Stage | Requirements | Why it goes here |
|---|---|---|
| 1. Signatures and identity | `NET-01`, `NET-02`, `SYNC-13` | Production signing is forgeable from a public NodeId. Until signatures are real, no peer-network or consensus test result is meaningful — and cross-node catch-up cannot succeed against a single-signer log. |
| 2. Authentication and authorization | `API-01`, `API-02` | Clerk now authenticates protected API routes and browser writes are same-origin checked. Authorization is still missing: any signed-in account can invoke operator actions; peer auth is not wired to a route. |
| 3. Durable state | `SYNC-01`, `SYNC-04`, `RUN-13` | Governance, membership history, and coordinator state remain in-memory; some run/log records use the database. Durable consensus and restore evidence are still missing. |
| 4. Evidence pipeline | `OPS-01`, `OPS-02`, `OPS-03` | Root Vitest and CI checks now exist, with unit tests passing locally. Distributed integration evidence, protected-release enforcement, and metrics emission remain open. |
| 5. Isolation | `EXEC-01`, `EXEC-03`, `EXEC-05`, `EXEC-06` | A real isolation boundary. Deferred until 1–4, because it is the largest build. |
| 6. Safety properties | `RUN-03`, `RUN-04`, `RUN-08`, `SYNC-06`, `SYNC-07`, `SEC-02` | Lease renewal, worker fencing, quorum check, snapshot rollback defence, lease-bound secrets. |
| 7. Enterprise surface | `DATA-*`, `API-05`…`API-15`, `UX-*`, `OPS-09`…`OPS-18` | Tenancy, migrations, audit, UX, runbooks, compliance. |

> **Fastest path to a truthful status:** Stage 4 alone. It converts every
> currently-false "✅ Verified" into real evidence, and it is the only stage whose
> output is a capability rather than a behaviour.

---

## Product and architecture decisions

- Each independently deployed OpenNode installation is a peer node with its own persistent identity, local durable state, UI/API, peer networking, and optional execution capacity. A restarted node must retain the same identity; a cloned installation must generate a new identity.
- There is no permanent central controller, shared central database, or single scheduler. Nodes exchange authenticated events and reach cluster decisions through a replicated consensus log.
- Use gossip and Merkle-based anti-entropy for discovery, presence, and transfer of missed state. Use a proven consensus implementation for membership changes, job ownership/leases, and other safety-critical decisions. Do not implement a custom consensus protocol.
- The initial governance model is permissioned: a new node needs approval from admitted peers. This is decentralized membership, not anonymous/permissionless membership.
- Admission votes: freeze eligible membership N when the proposal opens. If N = 1, require one yes vote. If N > 1, require max(2, ceil(0.20 × N)) yes votes. The candidate cannot vote. Offline peers remain in N and do not count as yes votes.
- Eviction votes: freeze N at proposal open; require ceil(0.50 × N) yes votes from members other than the target. The target remains in N and may submit a response, but their ballot does not count. No response is not a yes vote.
- A voluntary leave requires no vote. A leaving node stops accepting new work, drains or relinquishes active work, and publishes a signed leave event. Consensus finality is required to make membership changes consistent across peers.
- A percentage vote determines whether a proposal passes the governance rule. Consensus orders and commits that result; consensus participation is not an additional approval ballot.
- Replit may host a node only if persistent state, stable identity, networking, and process lifetime pass the feasibility spike. Do not assume a Replit deployment can safely execute untrusted containers or accept arbitrary peer protocols. Workload execution uses an isolated worker backend.
- MVP workload execution targets OCI images pinned by digest. udocker may be tested as an execution option inside the isolated worker, but is not treated as the security boundary.

### Decisions required before the corresponding code may ship

These are recorded as open, not assumed. Each one blocks a gate above it.

| # | Decision | Blocks |
|---|---|---|
| D1 | May a voter change a ballot? If yes: revision cap, minimum window before expiry, deterministic last-valid-revision rule. | GOV-06 |
| D2 | Is a NO a veto or a non-yes? Today early rejection makes one NO a permanent veto at N ≤ 3. | GOV-07 |
| D3 | Is `abstain` a first-class ballot choice, and does the read model expose yes/no/abstain/not-responded counts? | GOV-08 |
| D4 | How is the first member of an empty cluster established? Genesis is currently impossible. | GOV-10 |
| D5 | May a node voluntarily leave while an eviction proposal against it is open? | GOV-11 |
| D6 | May an evicted NodeId be re-admitted, and under what cooldown/elevated-threshold/tombstone policy? | GOV-12 |
| D7 | Does a membership change invalidate all open proposals, or only those whose frozen electorate contains the subject? | GOV-05 |
| D8 | What is the authoritative time source for expiry, and the maximum tolerated clock skew? | SYNC-07, GOV-04 |
| D9 | Required quorum for the consensus commit itself, separate from the percentage vote? | SYNC-01 |
| D10 | Which maintained networking stack backs `PeerTransport`? Which consensus engine? | SYNC-01, NET-01 |
| D11 | Are membership certificates issued by a per-cluster authority key or self-signed by the subject? | NET-06 |
| D12 | Is the intended principal model NodeId-only, or is `tenantId`/`principalId` required before any external deployment? | API-02, DATA-04, RUN-11 |
| D13 | Does `retry` create a new run or a new attempt of the same run? | RUN-07 |
| D14 | Is auto-requeue after fencing the intended policy, or does re-execution always require explicit retry? | RUN-06 |
| D15 | Which `secret-broker` implementation is canonical — `src/index.ts` or `src/secret-broker.ts`? | SEC-01 |
| D16 | What is the intended secret source (vault integration vs. envelope encryption)? | SEC-05 |
| D17 | Are per-tenant fairness and priority classes required for the enterprise target? | RUN-11 |
| D18 | Do `addressHints` in presence gossip ever trigger outbound dials? | NET-09 |

---

## System outline

Each node contains these independently replaceable modules:

- Web client: project, cluster, membership, run submission, run history, logs, and node health UI.
- Local API: authenticated local and peer-facing API; validates requests and delegates to domain modules.
- Domain core: pure rules for membership, voting, jobs, attempts, leases, authorization decisions, and state transitions.
- Local state store: durable node-local database and content metadata. No shared database is the cluster source of truth.
- Cluster log: adapter to a proven consensus engine; commits ordered events and supports snapshots and replay.
- Peer network: encrypted authenticated peer streams, discovery, gossip, relays, rate limits, and protocol negotiation.
- Sync engine: snapshot validation, event replay, sequence/vector tracking, Merkle reconciliation, resumable chunk transfer, and schema compatibility.
- Run coordinator: records a run request, obtains an exclusive committed lease, selects a capable peer, handles retries/cancellation, and reconciles worker status.
- Execution provider: interface to an isolated worker runtime; never runs hostile workload code in the UI or node API process.
- Secret broker: references secrets by ID and delivers short-lived job-scoped values only to an authorized worker; secret values are not replicated in cluster metadata.
- Content store: encrypted, checksummed log/artifact chunks with explicit replication and retention policy.

Deep-module rule: callers depend on small stable interfaces, not on storage, transport, consensus, or runtime internals. Keep peer protocol and provider-specific types out of the domain core. Validate every boundary input. API, CLI, and UI are thin clients of the same domain/API contracts.

---

## Vertical slice 0 — feasibility and architecture gate

- [~] Write threat model: hostile workload, malicious peer, compromised node, lost key, network partition, stale peer, replayed message, and resource exhaustion. *(`docs/threat-model.md` is written and covers all 8 classes, but it is a **gap register**: of 54 claimed mitigations only **6 are actually implemented**. 48 exist as requirements in this document, not as code. The model is only complete when those requirements close — see "Closure order" below.)*
- [ ] Select candidate peer-network and consensus implementations. Record why they fit the language/runtime and membership model; require a maintained, reviewed implementation rather than custom consensus. *(`docs/selections.md` records both as **NOT SELECTED**. Peer network is an interface with no transport behind it; consensus is a bespoke single-writer append whose adapter interface cannot express consensus. This item stays open until D9/D10 are decided. See NET-01, SYNC-01.)*
- [ ] Prototype peer-to-peer connectivity between two independently deployed nodes, including encrypted handshake, node identity, protocol version negotiation, reconnect, and outbound-only/NAT cases.
- [ ] Verify Replit deployment behavior: persistent state across restart, stable public identity, inbound and outbound connectivity, long-lived streams, process lifetime, and storage durability.
- [ ] Prototype an isolated worker outside the node API process; test OCI pull by digest, required udocker behavior, CPU/memory/PID/disk/time limits, network deny-by-default, cancellation, logs, and cleanup.
- [ ] Document worker operator, supported image registries, network egress policy, secret source, log/artifact retention, and initial resource quotas.

Exit criteria:
- [ ] Two peers can authenticate and exchange a signed test message after reconnect without a central authority. *(A libp2p transport now exists but is never instantiated; the signature scheme is forgeable from a public NodeId; `authorizePeerAccess` is never called. See NET-01, NET-06.)*
- [ ] Node identity survives the target deployment's restart model and cloned identity is detected or prevented. *(Today identity is an env var with a hardcoded default and is never collision-checked. See NET-02.)*
- [ ] No user workload executes in the Replit web/API process; worker isolation controls have test evidence. *(The only worker backend spawns no process and enforces no limit. See EXEC-01, EXEC-03.)*
- [x] If Replit cannot host a durable peer, document Replit as a UI/client deployment only and identify the supported full-node deployment target before proceeding. *(Feasibility spike executed 2026-10-09: 8/16 critical tests failed — no container runtime, no autoscale keep-alive, SQLite unverified, inbound/outbound peer connectivity not verified. See `docs/replit-deployment.md` for full results.)*

## Vertical slice 1 — one durable OpenNode node

Goal: a single installation can create a project, submit a safe sample test run, view logs and history, and restart without losing state.

- [x] Define versioned schemas for NodeId, ClusterId, JobSpec, Run, Attempt, LogChunk, ArtifactRef, MembershipProposal, Vote, and ClusterEvent.
- [~] Implement NodeIdentity: generate a signing key once, store it via the node keystore interface, expose only a public NodeId, support key backup/rotation procedures, and refuse to start on an accidental identity collision. *(The keystore implementation exists but is unused; the runtime reads an env var with a hardcoded default, and the identity table is never written. See NET-02, OPS-08.)*
- [~] Implement a local durable store behind NodeStore. Define migrations, transaction boundaries, checksums, indexes, backup, and restore. Store no plaintext secrets in job records. *(No migration artifacts exist; schema is applied by destructive `push`. Backups destroy every timestamp. See DATA-01..DATA-03, DATA-06.)*
- [~] Implement domain state machines for job and attempt states, including queued, starting, running, cancel-requested, succeeded, failed, cancelled, timed-out, and infrastructure-error/lost. *(Four divergent state vocabularies exist and the domain transition tables have no callers. `lost` is collapsed to `infrastructure_error` before it reaches the user. See RUN-09.)*
- [~] Implement a local fake ExecutionProvider for development and contract tests; make the production API asynchronous and return a durable run ID before work finishes. *(The worker path never reaches a terminal state; results are discarded. See EXEC-17.)*
- [~] Build the first UI path: create a test run with a built-in no-network sample, preflight it, submit, display live status/logs, cancel it, and revisit history after reload. *(Preflight checks ~1 of 7 required dimensions yet renders a green verdict; history is capped at 50 with no pagination. See UX-01, UX-14.)*
- [ ] Add request idempotency: repeated submission with the same idempotency key and same payload returns the same run; same key with a different payload returns conflict. *(Key namespace is global rather than per-actor; no header contract, TTL, or binding. See API-05.)*
- [~] Add initial audit events and structured logs with request/run/attempt correlation IDs and secret redaction. *(Redaction is dead code; audit rows are not hash-linked and have no read endpoint. Correlation IDs do not cross the peer boundary. See SEC-06, DATA-09, OPS-11.)*

Exit criteria:
- [ ] A node restart preserves identity, run history, and terminal attempt results. *(Committed log, run ledger, membership log, and all governance state are in-memory only. See SYNC-01, RUN-13.)*
- [ ] UI submission, API submission, and later CLI submission will share the same API/schema path. *(The UI retries via raw `fetch` to an undocumented endpoint; 11 endpoints are absent from the OpenAPI document. See API-08, UX-04.)*
- [x] UI displays a clear distinction between preflight validation and actual execution. *(Cosmetic only — preflight and submit do not share an admission evaluation. See UX-01.)*

## Vertical slice 2 — secure peer join and state synchronization

Goal: an admitted second node can join, verify cluster identity, synchronize state, and show as healthy without becoming a workload coordinator.

- [~] Implement PeerTransport interface: connect, authenticate, open versioned streams, publish/subscribe, close, and report transport health. *(`lib/peernet/src/libp2pTransport.ts` now implements `PeerTransport` over libp2p, but it has **zero callers** — it is never instantiated by the server. The only transport actually reachable is the in-memory one. `transportHealth().lastError` is never assigned. See NET-01, NET-14.)*
- [~] Use signed node handshakes with cluster ID, NodeId, protocol range, nonce, timestamp/expiry, and replay protection. Rate-limit handshake and discovery endpoints. *(Handshake TTL is unbounded; rate limiting keys on the attacker-supplied NodeId before verification; connections open before authentication. See NET-03..NET-05.)*
- [~] Implement multiple bootstrap peer addresses. Treat them as discovery hints only; they must not own governance or authoritative state. Add optional encrypted relay transport for NAT-restricted peers. *(No bootstrap configuration surface exists anywhere. Relay has no authentication, quota, or accounting. See NET-11, NET-12.)*
- [ ] Implement membership certificate verification before a peer can request protected cluster data or advertise execution capacity. *(Verifier exists but is never called; certificates are self-signed with no issuer and no revocation. See NET-06.)*
- [~] Store committed ClusterEvents as a hash-linked, signed log with monotonic sequence/epoch identifiers. Define event schema versioning and deterministic validation. *(Append is not serialized — concurrent writers can break the chain. Signature verification trusts exactly one signer, so multi-node catch-up always fails. See SYNC-02, SYNC-13.)*
- [~] Implement snapshot generation and verification. *(Snapshots carry no state, carry no quorum approval, and adoption is an unconditional `replace()` that can roll the node back. See SYNC-06..SYNC-08.)*
- [~] Implement join catch-up: verify snapshot, replay events after snapshot height, request missing ranges, compare Merkle roots, exchange only differing chunks, and resume after interruption. *(`runCatchUp` is dead code — no caller, no checkpoint store, no peer log source. Resume is not implemented. See SYNC-05.)*
- [ ] Implement gossip for low-risk presence/capacity signals and periodic anti-entropy repair. *(Messages are unsigned and `originId` is unbound to `rumorId`, so capacity and presence can be forged. Anti-entropy computes a Merkle root it never compares. See NET-07, NET-08.)*
- [ ] Add local read models that can be rebuilt from committed events; expose stale/syncing/healthy states to the UI. *(Projections switch on event kinds that are never committed, so every `apply()` falls through and projects nothing. `syncStatus` is a hardcoded `"local_only"`. See SYNC-12, UX-07.)*

Exit criteria:
- [ ] A peer cannot join a cluster or read protected data with a forged, expired, or wrong-cluster identity. *(Production signing is still forgeable from public identity data. The local API now has Clerk authentication, but role/tenant authorization is absent and peer auth is not wired. See NET-01, API-01, API-02.)*
- [ ] A newly admitted node reaches the same committed membership and job history as existing nodes after catch-up. *(Catch-up is never invoked; catch-up from a lagging peer always fails hard; divergence has no recovery path.)*
- [ ] Duplicate, delayed, reordered, and replayed events do not corrupt state; interrupted snapshot transfer resumes safely. *(Unit tests exist, but no distributed replay, partition, or resumable-snapshot tests exist. See OPS-01.)*

## Vertical slice 3 — decentralized membership governance

Goal: users can propose, vote on, synchronize, and audit node admission, voluntary leave, and eviction.

- [~] Implement MembershipService as a deep module with proposeAdmission, castVote, proposeEviction, requestLeave, commitDecision, and reconcile methods. UI/API must not implement threshold math independently. *(A second, stricter governance engine is exported from the same package root. The API computes `noVotes` from a route-local map; the UI restates the threshold formulas client-side. See GOV-01.)*
- [ ] Freeze an electorate snapshot and membership epoch when each proposal opens. Store its denominator so later joins/leaves cannot change the threshold mid-vote. *(Frozen values are self-asserted in the committed event and never cross-checked against committed membership. Epoch binding kills all concurrent proposals. See GOV-02, GOV-05.)*
- [~] Implement admission rule: N = eligible members at proposal open, excluding candidate; require one yes vote when N = 1; otherwise max(2, ceil(0.20 × N)) unique signed yes votes. *(Threshold arithmetic uses floats; no golden vectors. See GOV-09.)*
- [ ] Implement eviction rule. *(At N=2 a single peer can unilaterally evict the other. Undocumented. See GOV-09.)*
- [ ] Bind votes to proposal ID, cluster ID, voter NodeId, membership epoch, ballot choice, and expiry. Reject duplicate/replayed or stale-epoch ballots. Persist every accepted ballot and decision for audit. *(Signature verification is a no-op that accepts any non-empty string. Ballots are in-memory and never enter the log. See GOV-03, SYNC-09.)*
- [~] Implement proposal expiry and deterministic tie/timeout behavior. *(Reads pass `now: undefined` so expired proposals report `pending` forever. An undocumented early-rejection rule turns one NO into a permanent veto. See GOV-04, GOV-07.)*
- [ ] Commit a passed decision through the consensus log. *(The domain is mutated before the log append; a failure advances local state with no rollback and permanently strands the proposal. See GOV-13.)*
- [ ] On admission, issue a membership credential/certificate only after commit, then allow state sync and capability registration. *(`issueMembershipCredential` has no callers. See NET-06.)*
- [~] On voluntary leave, immediately stop new assignments locally, drain/relinquish work, and publish a signed leave event. *(Drain is simulated; credentials are not revoked; a single global boolean gate is never re-enabled. See GOV-14, RUN-15.)*
- [ ] On eviction, stop new assignments, revoke membership credentials, invalidate leases/fencing tokens, stop or quarantine execution capacity, and apply documented data-retention rules after commit. *(Revocation and quarantine are process-local sets with zero readers; lease invalidation ignores subject and cause. See GOV-15, RUN-15.)*
- [~] Add UI and CLI proposal/vote flows. *(The CLI registers no propose/vote/leave command at all. The UI gates on a local map, ignores expiry and self-targeting, and restates threshold math. See UX-02, GOV-01.)*

Exit criteria:
- [ ] Threshold tests pass for N=1 through N=20, including exact 20%, minimum-two admission floor, exact 50% eviction, and offline voters. *(The root Vitest runner exists, but this required threshold vector suite is not present. See OPS-01.)*
- [ ] Conflicting or stale vote sets cannot produce different committed membership histories across peers. *(Proposals and ballots are never replicated; reconciliation has no callers.)*
- [ ] An evicted or voluntarily departed peer cannot receive new work or use old credentials after the committed epoch advances. *(Restarts re-seed a one-member epoch-0 cluster; eviction side effects are write-only.)*

## Vertical slice 4 — replicated run submission and safe scheduling

Goal: a user can submit through any peer; the cluster records one run and grants one exclusive execution lease.

- [~] Implement RunCoordinator behind a stable interface. *(Committed run state is in-memory only.)*
- [ ] Use a deterministic run/idempotency identity derived from cluster, authenticated submitter, and client key. *(Domain derivation uses a 32-bit FNV-1a hash; the DB uses a global unique index on `clientRequestId` alone; the store assigns a random UUID as primary key. See RUN-02, DATA-05.)*
- [~] Add deterministic candidate selection, but require a committed lease/fencing token before execution. *(Fencing token is the global event-log height, is guessable, and worker reports are unauthenticated. See RUN-04.)*
- [ ] Bind leases to run ID, attempt number, worker NodeId, membership epoch, and expiry. *(Lease TTL is 30 s while max duration is 24 h; there is no renewal, so every run over 30 s is fenced and re-executed. The worker never receives the lease and never re-validates it. See RUN-03, EXEC-16.)*
- [ ] Define partition behavior. *(The anti-double-assignment guard is an optional argument with no producer. `reconcile` has one caller — an unauthenticated HTTP endpoint that accepts caller-supplied clock and worker lists. See RUN-08.)*
- [ ] Treat retries as at-least-once execution. *(A fenced attempt is silently auto-requeued with no declared side-effect class. See RUN-06.)*
- [ ] Add quotas and admission checks. *(Quota ignores queued runs; `retry` bypasses it entirely; the model is a flat cluster-wide singleton with no tenancy. See RUN-10, RUN-11.)*
- [~] Add run state reconciliation. *(`cancel_requested` is a dead end — nothing can advance it. Retry is offered in states where it always 409s. See RUN-12, UX-05.)*

Exit criteria:
- [ ] Concurrent identical submissions via two peers create one logical run. *(Depends on GOV/SYNC replication that does not exist.)*
- [ ] Partitions and stale workers cannot obtain conflicting committed leases. *(Fencing affects only the attempt record, never the running worker.)*
- [ ] UI and CLI see the same committed run/attempt states from different healthy peers. *(No endpoint returns committed state; both read the local DB mirror.)*

## Vertical slice 5 — real isolated execution, logs, and artifacts

Goal: a committed run executes in a disposable isolated worker, with durable history and logs available through any authorized peer.

- [~] Implement ExecutionProvider adapter for the selected worker backend. *(The wired provider hardcodes `executionMode: "built_in_diagnostic"` and never executes a container.)*
- [ ] Run one job per disposable isolation boundary. Deny network egress by default, block metadata/control-plane/other-tenant endpoints, and enforce CPU, memory, PID, disk, wall-clock, and output limits outside the workload. *(No cgroup, quota, tmpfs, rlimit, or netfilter code exists. Hostname-string matching only, with no enforcement point. See EXEC-03, EXEC-05.)*
- [ ] Pin OCI image by immutable digest; record digest and policy result per attempt. *(No pull, resolution, or verification code exists. `imageDigest` is written as `null` and never updated. Pinning is disabled in production config and is a substring test. See EXEC-02, EXEC-04.)*
- [ ] Inject only referenced job-scoped secrets through a broker. *(The broker is unreachable from the run path — `secretRefs` is hardcoded `[]`. Worker identity is unsigned and unbound to the lease. See SEC-01, SEC-02, EXEC-11.)*
- [~] Stream sequenced bounded log chunks with follow, cursor resume, pagination, ordering, and duplicate chunk handling. *(Streaming uses a wall-clock sequence and paging uses a per-run counter — two incompatible sequence spaces, so resume never works. See UX-09.)*
- [ ] Store larger logs/artifacts as encrypted content-addressed chunks with explicit replication/retention metadata. Do not publicly expose private workload output. *(Artifacts sit unencrypted in an unbounded process-global `Map`, served by guessable ID with no authorization. Content store is never imported. See SEC-07, SEC-08, EXEC-20.)*
- [~] Implement cancellation and teardown for success, failure, timeout, eviction, worker disappearance, and control-plane outage. *(A failing cancel leaks the run permanently. Cleanup reports are emitted then discarded. Scratch is untracked across restart. See EXEC-13, EXEC-14, EXEC-15.)*
- [~] Add UI Test Run guided form and advanced spec editor; run preflight; submit only on explicit user action. *(Preflight is not wired to submit and reports success unconditionally. Spec fields including `command`, secrets, and output budget are silently discarded. See UX-01, EXEC-19.)*
- [~] Add run details/history, reconnectable logs, cancellation, attempt history, artifacts, and actionable worker/policy errors. *(Attempt history is not in the API contract at all; artifacts render a hardcoded empty state; "View logs" is an inert button. See UX-03, UX-10, UX-11.)*
- [~] Add CLI login/logout/status, preflight, submit, list, show, logs, cancel, retry, cluster/peer status. *(Credential handling misreports storage; `status` and `peer-status` call endpoints that return 404. No propose/vote/leave commands. See API-09, UX-13.)*

Exit criteria:
- [x] No workload executes in the UI or node API process. *(Vacuously true — no workload executes anywhere.)*
- [ ] Hostile workload tests cannot access host, control-plane credentials, metadata, another job, or another tenant. *(No test runner exists; there is no tenant model to isolate.)*
- [ ] Logs/artifacts are ordered, bounded, authorized, resumable, checksummed, and subject to retention. *(No collector, no retention enforcement, checksums are bypassable.)*

## Vertical slice 6 — production hardening and staged rollout

- [~] Select and configure a single test runner for every workspace package; add a root `test` script that fans out. *(Root Vitest is configured; the latest local run passed 254 tests in 14 files. Most packages and distributed failure paths remain untested. See OPS-01.)*
- [ ] Add tests for hostile peers, message floods, malformed events, signature failures, replay, stale snapshots, key rotation, duplicate node identities, and protocol downgrade.
- [ ] Add failure injection for peer partitions, control-plane restart, consensus quorum loss, worker restart, object-store outage, full disk, provider timeout, expired credentials, and failed cleanup. *(Registry is declared but never wired; `inject()` silently passes through 4 fault types and `injectSync()` silently passes through 6 — including `Timeout` and `ClockSkew`, which the registry declares as valid for sync fault points.)*
- [ ] Add observability for consensus health, peer connectivity, catch-up height/lag, sync errors, queue age, lease expiry, duplicate submissions, worker health, log lag, and orphan cleanup. *(All 15 alert rules reference metrics that no code emits; `metricsExporter.ts` has no instrumentation library and its only implementation is a no-op. See OPS-07.)*
- [ ] Add alerts and runbooks for quorum loss, suspected compromised peer, key revocation, worker containment, provider outage, stuck proposal, stale lease, and state restore. *(No runbooks exist. `durationMs` and `cooldownMs` are declared but never read by the evaluator, so every rule fires on a single sample. See OPS-09, OPS-10.)*
- [ ] Test backup/restore and rejoin from snapshots; reconcile restored state with current consensus height before the node advertises capacity. *(Restore deletes the audit trail and restores another node's identity. See DATA-04, DATA-07.)*
- [ ] Add feature flags and a kill switch that stops new execution while preserving cancellation, cleanup, and membership revocation paths. *(Kill switch is per-process and not replicated, so it cannot be cluster-wide in a system with no central controller. See OPS-12.)*
- [ ] Deploy a small canary cluster, test join/leave/eviction and workloads under representative partitions, then expand only after launch gates pass.

Release gates:
- [ ] Consensus and sync implementation is reviewed; no custom consensus protocol is in production. *(The shipped log is a bespoke single-writer append path. **Gate NOT MET.** See SYNC-01.)*
- [ ] No unresolved critical/high security findings, cross-tenant access, host escape, or secret leakage. *(The initial review found 40+ Critical findings; authentication and same-origin checks have since been added, but authorization, identity, isolation, and other findings remain. **Gate NOT MET.**)*
- [ ] Membership thresholds, partition behavior, rejoin, eviction fencing, and lease recovery pass automated integration and fault-injection tests. *(Unit tests pass; the required distributed/fault-injection tests are missing. **Gate NOT MET.**)*
- [ ] Replit full-node support is claimed only if persistence and peer-connectivity tests pass on the actual deployment target. *(Not tested; autoscale deployment target is structurally incompatible. **Gate NOT MET.**)*
- [ ] Operators can pause new work, quarantine a peer, revoke its identity, and recover the cluster without losing auditability. *(Kill switch is per-process; revocation is write-only; restore deletes the audit trail. **Gate NOT MET.**)*

### Gate evidence

No release gate may be recorded as verified on the basis of source-code reading.
Each gate must name the automated test or CI job that proves it, with the command to
reproduce and the commit SHA at which it passed. A gate without an executable
evidence artifact is marked **UNVERIFIED** and blocks release.

---

## Shared technical contracts

- Domain modules expose typed commands/results and domain errors; API/CLI map them into stable versioned error responses.
- Every mutation carries authenticated actor, cluster ID, request ID, idempotency key where applicable, and expected membership/state epoch.
- Every replicated event is schema-versioned, signed by its origin where appropriate, validated deterministically, and safe to replay more than once.
- Every peer-facing endpoint enforces size limits, authentication, replay protection, rate limits, and authorization before reading protected state.
- Secrets, private keys, access tokens, raw credentials, and unredacted sensitive workload output never enter the replicated event log.
- Metrics and logs use correlation IDs and bounded cardinality; never emit secret values or private key material.

---

# Domain requirement closures

The following sections close the UX loopholes, limitations, and edge cases found by
the domain review. Each requirement is normative and MUST be satisfied before the
corresponding slice item or release gate can be marked complete.

---

## GOV — Membership governance

**GOV-01 — One governance implementation, no independent tally math.** Exactly one
admission/eviction/ballot/decision rule implementation MUST exist and MUST be the only
public entry point. A second engine exported from the same package MUST be deleted or
proven equivalent by shared tests. All vote tallies — including NO counts and
abstentions — MUST be computed by the domain from the authoritative accepted-ballot
set. The API MUST NOT maintain or derive any tally from state outside the domain. The UI
MUST NOT restate the threshold formula; threshold text, denominator, required votes, and
remaining time MUST be supplied by the API.

**GOV-02 — Frozen electorate must be independently re-verifiable.** A committed
membership decision event MUST carry the denominator, the threshold, and the counted
yes-voter NodeIds. On replay every peer MUST recompute `threshold = f(denominator)` and
verify that the denominator equals the size of the committed membership set at the
proposal's frozen epoch (excluding the candidate for admission, including the target for
eviction). An entry failing either check MUST be rejected as invalid, not applied.

**GOV-03 — Ballot signature must actually verify.** A ballot MUST be accepted only when
its signature verifies under the key bound to `ballot.voterId` over a domain-separated,
length-prefixed canonical encoding of
`(proposalId, clusterId, voterId, epoch, choice, expiresAt, revision)`. The domain MUST
receive a keyring-backed verifier. A verifier that cannot resolve `voterId` to a key MUST
be treated as *verification unavailable* and MUST reject — never accept.

**GOV-04 — Expiry must be evaluated on every read, with a defined time source.** Any read
of a proposal MUST evaluate its state against the current time and MUST report `expired`
or `rejected` deterministically once the deadline passes or the threshold becomes
unreachable, without requiring a mutation to occur first. The read model MUST NOT report
`pending` for a proposal that can no longer receive a counted ballot. Expiry MUST use a
single defined time source (committed log time where available), with a documented maximum
tolerated clock skew and a defined behaviour when it is exceeded. A ballot's expiry MUST
be clamped to the proposal's expiry and MUST NOT be minted by the voter.

**GOV-05 — A later membership change must not kill unrelated proposals.** A membership
change MUST NOT alter the frozen denominator, threshold, or ballot validity of a proposal
whose frozen electorate does not contain the affected subject. A proposal whose frozen
electorate contains the affected subject MUST be deterministically invalidated and
surfaced as `invalidated`. Ballots MUST be accepted against the proposal's frozen epoch,
not the node's current epoch. See D7.

**GOV-06 — Bounded, durable ballot revision.** If ballot changes are permitted, each
revision MUST carry a monotonically increasing number derived from durable
accepted-ballot state (not process memory), the number of permitted revisions MUST be
bounded, a change MUST NOT be permitted after the proposal's remaining time falls below
a documented window, and every superseded revision MUST be retained for audit. A vote
request MUST carry an idempotency key so a retried identical request is rejected as a
replay rather than recorded as a new revision. See D1.

**GOV-07 — No undocumented early rejection.** A proposal MUST NOT be terminally rejected
before its expiry on the basis of ballots cast so far. Until the deadline, a proposal
whose threshold is not met MUST remain open and continue to accept ballots. The domain
MUST distinguish `pending`, `passed`, `expired`, and `rejected-by-rule`, and the exact
deterministic condition for each MUST be documented. See D2.

**GOV-08 — Abstention and non-response must be distinguishable.** The ballot choice set
MUST be defined explicitly (at minimum yes/no, plus abstain if adopted). Abstain and
non-response MUST both be treated as non-yes and MUST NOT be treated as a veto. The
public proposal read model MUST expose received yes, no, and abstain counts plus the
number of eligible voters who have not responded. See D3.

**GOV-09 — Publish the threshold table and use integer arithmetic.** The specification
MUST publish the closed-form threshold for N = 1..20 for both rules, MUST state explicitly
that the minimum-two floor applies to admission only, MUST state the consequence for N=2
(unanimous admission, single-vote eviction), and MUST state that eviction at N=1 is not
expressible. Threshold computation MUST use integer arithmetic only — `ceil(20·N/100)` and
`ceil(50·N/100)` — and MUST NOT use floating-point multiplication. Golden vectors for
N = 1..20 MUST exist and every implementation MUST match them.

**GOV-10 — Genesis must be defined.** The specification MUST define how the first member
of an empty cluster is established (bootstrap token, genesis configuration, or explicit
operator action). A node MUST be permitted to open an admission proposal naming itself;
it MUST NOT be permitted to open an eviction proposal against itself.

**GOV-11 — Voluntary leave must be governed.** A voluntary leave MUST be rejected while
any open proposal names the leaving node as subject. A leave MUST deterministically
resolve every proposal whose frozen electorate contains the leaving node before the epoch
advances, and the resolution MUST be visible in the audit trail. See D5.

**GOV-12 — Removal history and revocation must be durable and effective.** A removed
NodeId MUST be recorded in durable removal history. Re-admission of a previously removed
identity MUST require a documented policy (at minimum a cooling-off period and a threshold
not lower than the original). Revocation and quarantine state MUST be consulted by
admission, credential issuance, and candidate selection, MUST be rebuilt from committed
events on boot, and MUST be surfaced in the membership read model. See D6.

**GOV-13 — Commit before effect, with rollback.** A membership change MUST NOT become
effective in local domain state until the corresponding decision event is durably
committed. If the append or commit fails, the domain MUST roll back and the proposal MUST
return to a retryable state. A committed decision event MUST be the single source of truth
for local membership and epoch.

**GOV-14 — Leave must actually drain and revoke.** The leave path MUST report the exact
number of non-terminal runs requiring drain using a counting query, MUST durably record a
drain obligation, MUST revoke the departing node's membership credential and job-scoped
credentials in the same committed step as the leave event, and MUST complete and reconcile
the drain before or after the leave is reported final.

**GOV-15 — Eviction side effects must be enforced, not recorded.** Stopping new
assignments MUST be scoped per subject and per cause. Eviction of a remote peer MUST
revoke that peer's credentials, quarantine its capacity, and fence its leases and fencing
tokens WITHOUT disabling the local node. Any assignment gate MUST have a documented,
authorized re-enable path.

**GOV-16 — Governance DoS must be bounded.** Proposal creation MUST be idempotent on a
caller-supplied key, MUST be rate limited per authenticated actor and per node identity,
and MUST reject a second open proposal with the same `(kind, subject, epoch)` tuple. Open
proposals per cluster and per subject MUST be bounded.

**GOV-17 — Proposals and ballots must be replicated.** Proposals and signed ballots MUST
be replicated to all eligible voters and collected through an authenticated peer channel
before a decision is computed. A node MUST NOT finalize a proposal from only its own local
ballot unless the frozen threshold is satisfiable by that single ballot. The system MUST
expose, per proposal, which eligible voters have and have not reported a ballot.

**GOV-18 — Reason and target response must be replicated and visible.** The proposal
reason MUST be part of the proposal record and MUST be included in the committed decision
event so every peer and auditor sees identical text. An eviction target's response MUST
be part of the proposal record, MUST be in audit details, MUST be returned by the proposal
read API, and MUST be visible in the UI and CLI. The reason MUST be length-bounded, free of
control characters, and rate limited per actor.

**GOV-19 — Every proposal must reach exactly one terminal outcome.** A node MUST have a
deterministic finalization path driving every proposal to exactly one of
`committed_admitted`, `committed_evicted`, `committed_rejected`, or `expired`, regardless
of whether a local vote triggered it. Terminal outcomes MUST be committed to the decision
log and MUST be idempotent under repeated finalization attempts.

**GOV-20 — Leave events must be unforgeable.** A leave event MUST be rejected unless
`signerNodeId === subjectId` and the signature verifies under that node's registered key.
Signature verification of membership events MUST be mandatory in every build; a
deployment that cannot verify MUST refuse to apply the event rather than skip verification.
Leave signatures MUST bind cluster ID, subject, previous epoch, new epoch, proposal ID, an
issued-at timestamp, and a nonce, and MUST be single-use.

**GOV-21 — Error taxonomy must be unambiguous.** The domain error taxonomy MUST map
authorization failures to a distinct authorization code and HTTP status, threshold/decision
failures to a decision code, and input-validation failures to a validation code. Every
error code MUST correspond to exactly one condition and MUST NOT be reused.

---

## SYNC — Consensus log, snapshots, catch-up

**SYNC-01 — A proven consensus engine, durably stored.** The cluster log MUST be an
adapter over a maintained, reviewed consensus implementation, gated behind a build flag
that disables run submission. A single-writer in-process append path MUST NOT be used in
production. The log MUST be backed by a durable, crash-consistent store whose write path is
atomic with derived read models. In-memory `EventLogStore`/`MembershipLogStore`
implementations MUST be marked test-only and MUST NOT be constructible from production
wiring. Until an engine is wired, the product MUST NOT claim replicated consensus. See D9, D10.

**SYNC-02 — Appends must be serialized.** Appends MUST pass through a single-writer
critical section keyed by cluster ID. The store MUST reject an append whose
`(height, prevHash)` no longer matches the durable tip (compare-and-set), surfacing
`SEQUENCE_GAP` rather than silently concatenating. Committed height and tip hash MUST be
read from the same atomic read used for append.

**SYNC-03 — Validate before append; truncate on failure.** Every commit path MUST validate
against the current applied state *before* appending, or MUST truncate back to the
pre-append height when post-append application fails. A node MUST refuse to become healthy
while `reconcile()` throws.

**SYNC-04 — Epoch and membership must be monotonic and persisted.** The membership epoch
MUST be monotonically persisted and restored on boot. A node whose local epoch is lower
than a peer's advertised epoch MUST refuse to serve protected state and MUST report `stale`.
Bootstrapping at epoch 0 MUST be permitted exactly once, on a node with no prior committed
state, and MUST be rejected on any node that has previously committed a membership event.

**SYNC-05 — Catch-up must be wired, resumable, and bounded.** `runCatchUp` MUST be invoked
by a background sync worker at startup and on every peer-connection lifecycle event, and the
reported `syncStatus` MUST be derived from that worker's actual applied/target height.
Catch-up MUST resume from the last durable checkpoint height, MUST re-verify the checkpoint
tip hash against the local log before trusting it, and MUST skip chunks below the
checkpoint without re-fetching.

**SYNC-06 — Snapshot adoption must reject rollback.** A snapshot MUST be adopted only when
its height is strictly greater than the local height AND its membership epoch is greater
than or equal to the locally committed epoch; otherwise it MUST be ignored as stale.
Adoption MUST reset all derived read models through a mandatory rollback hook before the new
prefix is installed, and a node MUST refuse to serve protected state while a rollback is in
progress. A `BROKEN_HASH_LINK` or `MERKLE_ROOT_MISMATCH` at a chunk boundary MUST trigger a
defined divergence-resolution path: re-offer an approved snapshot, or mark the node
`diverged`, refuse protected traffic, and require an operator reset.

**SYNC-07 — Snapshots must carry state and quorum approval.** A `ClusterSnapshot` MUST carry
a self-contained, schema-versioned state image (membership set, epoch, read-model
projections) sufficient to reach a usable node without the prefix. It MUST be approved by a
quorum of distinct admitted members at the snapshot's membership epoch, or by the consensus
engine's commit certificate, and the approving signer set MUST be carried and verified
before adoption. `snapshot.membershipEpoch` MUST equal the epoch of the event at
`height - 1` (or 0 when height is 0) and MUST be verified after the prefix is fetched.

**SYNC-08 — Compaction and retention must be defined.** Compaction MUST publish a snapshot
*before* pruning, and a node MUST record the retained floor so peers can detect they need
history this node no longer has. A node MUST reject catch-up from a peer whose retained
history starts after the locally required sequence, with an explicit "history unavailable"
error surfaced to the user. Log, run, attempt, log-entry, and audit tables MUST have a
documented compaction policy with storage quotas and an alert before exhaustion.

**SYNC-09 — Ballots must be committed, not just counted.** Each committed membership
decision MUST embed the frozen electorate, the accepted ballot digests (signatures, voter
IDs, revisions, expiries), and the resulting threshold, and replay MUST re-verify that the
embedded ballots independently satisfy the threshold. Ballots and proposals MUST be durable
and rebuildable from the log.

**SYNC-10 — Reconciliation must be scheduled and honest.** Peer claims MUST be reconciled on
a schedule and on every membership event. `MembershipService.reconcile` MUST be invoked from
the same path that applies committed membership. Peer reconciliation MUST distinguish
`behind`, `ahead`, and `diverged` using both committed epoch and log height/tip hash. Any
same-epoch, same-height membership difference MUST be reported as divergence and MUST raise
an operator-visible alert. Catching up from a lagging peer MUST return `local-ahead` rather
than an error whose message states the opposite condition.

**SYNC-11 — Canonical hashing must be transport-stable.** Canonical hashing MUST define an
explicit encoding for absent values (omit the key entirely) and MUST be implemented by a
single shared canonicalizer used by the log, snapshots, gossip, and idempotency
fingerprints. The canonicalizer MUST have test vectors that round-trip through JSON before
and after transport. Merkle leaves MUST be domain-separated by index and the tree size MUST
be folded into the root, so distinct `(leaves, length)` inputs MUST NOT collide. Every root
exchange MUST compare `(height, root)` pairs.

**SYNC-12 — Event kinds and projections must be reconciled.** Event kinds MUST be defined
once in a shared registry, and projections MUST be written against that registry; the build
MUST fail if a projection references an unregistered kind. Every committed kind MUST have
either a projection or an explicit documented "metadata only" declaration. The sync engine
MUST persist applied height, target height, last progress timestamp, and error class, and
`syncStatus` MUST be derived from them on every read — never a constant.

**SYNC-13 — Signatures must be asymmetric and resolvable.** Log, snapshot, and membership
certificate signatures MUST use a non-symmetric algorithm bound to the node's persistent
identity key. The verifier MUST resolve signers from the committed membership key set for
the entry's epoch. Production startup MUST fail hard when the cluster ID or signing secret is
missing or equals a documented default. Key rotation MUST be additive with a verification
key set, and historical entries MUST remain verifiable after rotation.

**SYNC-14 — Schema versions must be ranges, not equality.** Every replicated type MUST
declare a version and the engine MUST support a documented inclusive range with per-kind
readers that skip unknown kinds. A node MUST advertise its supported range during handshake,
MUST refuse only the specific entries it cannot parse, and MUST report incompatibility as an
actionable operator error.

**SYNC-15 — Peer-advertised values must be bounded.** The sync engine MUST enforce configured
ceilings on advertised peer height, entries per request, bytes per entry, and total bytes
per catch-up session. Exceeding any ceiling MUST abort with a typed error and MUST NOT be
retried against the same peer without operator action.

**SYNC-16 — Truncation must notify derived state.** Any log truncation MUST be accompanied
by a mandatory rollback signal to every derived projection before new entries are replayed,
and the sync engine MUST require a rebuild from sequence 0 whenever a truncation is applied.
Truncation MUST be recorded as a distinct audit event with the heights involved.

**SYNC-17 — Restore must be reconciled before advertising.** A restore MUST record the log
height and membership epoch it was taken at. A restored node MUST report
`restoring`/`stale` and MUST complete catch-up and prove its height against a quorum of peers
before advertising capacity or accepting work.

**SYNC-18 — Applied sequence must be validated against log height.** `appliedSequence` MUST
be validated against the durable log height at load time. If the log is shorter than the
recorded applied sequence, the node MUST discard derived state, rebuild from sequence 0, and
report `rebuilding` until it completes.

---

## NET — Peer network, handshake, gossip, relay

**NET-01 — A wired production transport.** The repository MUST contain exactly one
production `PeerTransport` implementation backed by a maintained networking stack,
and it MUST be reachable from the node's runtime bootstrap.
`InMemoryPeerTransport` MUST be exported from a separate `testing` entrypoint that
production bundles MUST NOT import. Release gates MUST cite a passing two-process
integration test over real sockets, and MUST NOT accept an interface definition as
evidence of connectivity.
*Status: `lib/peernet/src/libp2pTransport.ts` now implements `PeerTransport` over libp2p
(Noise, yamux, QUIC, WebSocket/WebTransport, bootstrap, kad-dht, circuit-relay-v2, identify,
ping, autoNAT). It has **zero callers** — it is implemented but never instantiated — and
`authorizePeerAccess` is still never called on any connection path. Unused code is not a
deployed control.*

**NET-02 — Identity must be keystore-backed and fail closed.** A node MUST refuse to start
unless a persistent, keystore-backed identity exists or is created exactly once, and MUST
never fall back to a constant or environment-derived default. `local_node_identity` MUST be
populated during bootstrap; a derived NodeId that does not match it MUST abort startup with
`IDENTITY_COLLISION`. Deployment manifests MUST NOT supply a signing key via environment
variable. The signing key MUST NOT be exposed on any runtime object, API response, or log.

**NET-03 — Peer messages must be authenticated envelopes.** Every message crossing the peer
transport MUST be an authenticated envelope carrying cluster ID, sender NodeId, membership
epoch, protocol version, monotonic per-sender sequence, and a signature verifiable against
the sender's NodeId key. Receivers MUST reject unsigned messages, messages whose sender is
not a committed member at the claimed epoch, and messages whose sequence regresses, and MUST
drop the connection on violation. Topic names MUST come from a fixed allowlist.

**NET-04 — Authenticate before connecting.** A peer connection MUST NOT reach the
authenticated state until a membership certificate for the current committed epoch has been
verified. Membership MUST be re-checked on every epoch advance, and non-members MUST be
disconnected within one epoch-refresh interval.

**NET-05 — Rate limiting must resist Sybil.** Handshake rate limiting MUST be applied on
connection-level identity (remote address or authenticated transport peer ID) *and* on
NodeId, in that order, before any per-request work. Buckets MUST be swept or LRU-evicted, and
total bucket count MUST be capped, with rejection at the cap.

**NET-06 — Certificates must be issuer-signed with durable revocation.** Membership
certificates MUST be issued by a cluster authority key distinct from the subject key, MUST
name the issuer, and MUST be verified against that issuer's key. The node MUST maintain a
durable, replicated revocation set (keyed by NodeId and key epoch) derived from committed
events, and MUST reject any certificate whose subject is on it regardless of epoch. Revocation
MUST be applied to in-memory connection state within one heartbeat interval of the committing
event being observed. Certificate `issuedAt`/`expiresAt` MUST be validated as non-negative
safe integers, and `expiresAt - issuedAt` MUST be within a documented maximum, before any
comparison to `now`.

**NET-07 — Gossip must be signed and self-consistent.** Every gossip message MUST be signed
by the origin NodeId and verified against that NodeId's committed membership key before
ingestion. A verifier MUST reject any message whose `rumorId` is not the canonical
`category:originId` derivation, whose `originId` is not a member of the frozen committed
epoch, or whose `version` regresses for that origin. Signatures and `rumorId` MUST be included
in the anti-entropy hash. See SYNC-11.

**NET-08 — Gossip validation must be symmetric.** The receive-path validator MUST enforce the
same TTL ceiling as construction and MUST reject messages whose `issuedAt` is in the future
beyond a documented clock-skew allowance. Validation logic MUST be shared so the two paths
cannot diverge. Anti-entropy MUST compare Merkle roots first and exchange only differing
subtrees; digest size MUST be bounded; reconciliation MUST be capped per round and MUST NOT
send more than a configured per-peer byte budget per interval.

**NET-09 — Address hints must be constrained.** `presence.addressHints` MUST be limited to a
small fixed maximum count and length, MUST parse to an allowlisted multiaddr scheme set, and
MUST be rejected if it contains link-local, loopback, private-only, or metadata ranges
unless the operator has explicitly enabled them. Hint ingestion MUST be rate limited per
origin and MUST NOT trigger immediate dialing — discovery MUST be deferred behind backoff.
See D18.

**NET-10 — Reconnect must back off.** All outbound connection and anti-entropy attempts MUST
use exponential backoff with full jitter, a per-peer attempt counter, and a circuit breaker.
Reconnect phases MUST be randomized per node and per peer. The transport MUST expose a
monotonic `nextEligibleConnectAt(peer)` that callers MUST consult before dialing.

**NET-11 — Transport limits and bootstrap validation.** Each peer MUST be subject to hard caps
on concurrent inbound streams, total open streams, per-stream buffered bytes, message size,
and subscriptions; exceeding any cap MUST close the offending stream or drop the peer and
MUST increment a counter. The transport MUST apply per-peer and global backpressure. Bootstrap
addresses MUST be parsed into a typed multiaddr and rejected unless they match the
operator's allowed scheme/host/port policy; the list MUST be bounded and deduplicated by
parsed form, and validated at startup.

**NET-12 — Relay trust must be explicit.** A relay MUST be authenticated as a known relay
identity and MUST never be trusted for availability, ordering, or membership. Relayed
envelopes MUST carry an end-to-end signature, a per-session monotonic counter, and an expiry,
so replay and reorder are detectable by the receiver. Each relay MUST enforce per-peer and
per-node quotas and surface relay-specific errors distinct from peer errors. The threat model
MUST state exactly what a malicious relay can and cannot learn.

**NET-13 — Handshake TTL and protocol floor must be bounded.** Handshake validity MUST be
clamped to a documented `MAX_HANDSHAKE_TTL_MS`, and the nonce cache MUST be populated with
`min(handshake.expiresAt, now + MAX_HANDSHAKE_TTL_MS)`. The selected protocol version MUST be
`max` of the two minima, bounded above by `min` of the two maxima, and MUST NOT be lower than
a cluster-configured `MINIMUM_SUPPORTED_PROTOCOL_VERSION` raised only by committed event. The
negotiated version MUST be bound into the authenticated session and `openStream` MUST reject
any other version.

**NET-14 — Transport health must be real.** Every `PeerTransport` MUST record the last
connection error, last successful handshake time, per-peer state, negotiated protocol version,
and counters for rejected/failed attempts, and MUST surface them through a non-nullable
diagnostic snapshot. The node MUST register health checks for peer connectivity, gossip
freshness, anti-entropy lag, and consensus reachability, and `/healthz` MUST reflect real
state.

**NET-15 — Canonical signed encodings must be injective.** Signed message construction MUST
use an unambiguous length-prefixed canonical encoding beginning with a distinct
domain-separation tag per message type. Identifier types MUST be validated against a fixed
format at construction, and a property test MUST assert injectivity.

**NET-16 — Peer-facing errors must not leak.** Peer-facing error responses MUST return a
stable documented code and a generic message, and MUST NOT echo the expected cluster ID, the
local NodeId, or membership contents. Detailed diagnostics MUST go to the local log with
correlation IDs only.

**NET-17 — Every declared error code must be reachable.** Every code in `PeerNetErrorCode` and
`GossipErrorCode` MUST be raised by at least one code path and covered by a test asserting
the code, or it MUST be removed from the union in the same change.

---

## RUN — Run coordination, leases, scheduling

**RUN-01 — Commit before scheduling.** Once the accepted-run event is committed, the API MUST
return `202` with the durable run identifier and MUST NOT report submission failure. A mirror
failure MUST be surfaced as a degraded-health signal, not a client error. Worker assignment
MUST be driven by committed state (a scheduler reacting to `run.submitted`), not by the
request that originated the submission, so any replay is idempotent and still results in
exactly one lease.

**RUN-02 — Collision-resistant, tenant-scoped run identity.** Run identity MUST be derived
with a collision-resistant digest (SHA-256 truncated to at least 128 bits) over a canonical,
length-delimited encoding that includes `clusterId`, `tenantId`, and `principalId`.
Identifier derivation MUST be versioned so a future algorithm change does not alias existing
identifiers. The DB uniqueness constraint MUST be scoped to
`(cluster_id, submitted_by, client_request_id)`, and the durable primary key MUST be the
deterministic run ID so the store and the committed log agree without an in-memory side map.

**RUN-03 — Leases must be renewable and reach the worker.** Leases MUST be renewable by the
assigned worker via a committed `run.lease_renewed` event, on a configurable fraction of the
lease TTL. The configured TTL MUST be validated at startup to be at least 2× the renewal
interval and MUST exceed the maximum observation-report gap. The lease TTL MUST be at least the
maximum workload wall-clock duration plus a safety margin. `ExecutionProvider.startRun` MUST
receive and enforce the lease ID, fencing token, and expiry.

**RUN-04 — Fencing must stop the worker, not just the record.** The worker MUST re-validate its
committed lease before every state advance and at an interval shorter than the lease TTL, and
MUST tear down the workload and revoke job-scoped credentials when validation fails. Any
attempt whose report arrives after its lease expiry MUST be recorded as an orphaned execution
and MUST trigger an operator-visible alert.

**RUN-05 — Fencing tokens must be per-resource and reports authenticated.** The fencing token
MUST be a per-`(runId, attempt)` value assigned by the consensus layer and opaque to clients.
Attempt reports MUST be signed by the reporting worker and validated against the committed
lease (node ID, epoch, token, non-terminal attempt) before being applied. Peer-facing report
endpoints MUST enforce replay protection via a monotonic per-attempt report nonce and MUST
rate-limit submissions.

**RUN-06 — Retry must respect side-effect class.** `RunSpec` MUST include a declared
side-effect class, validated against it. The coordinator MUST NOT auto-requeue a fenced
attempt whose declared class is non-idempotent; such runs MUST transition to a distinct
`interrupted`/`needs-attention` state requiring an explicit retry that acknowledges possible
duplicate side effects. Attempt history MUST be preserved in full and shown alongside any
retry confirmation. See D14.

**RUN-07 — Retry must not be replayable or double-executing.** Every non-idempotent mutation
MUST honour an `Idempotency-Key`. `retry` MUST require that every prior attempt is terminal
as committed by the coordinator, and MUST refuse with a stable code while any attempt is
non-terminal or its lease is unexpired. Provider-side `duplicate_run` MUST be a reconcilable
condition, not an ignorable error, and MUST escalate to an operator alert. See D13.

**RUN-08 — Partition behaviour must fail closed.** `acquireLease` MUST refuse to grant a
lease unless the node has a current committed membership epoch, positive quorum/liveness proof
for that epoch, and a local committed-log height at or ahead of the highest claim observed
from any peer. The peer-claim comparison MUST NOT be optional; absent a claim within a bounded
interval the node MUST fail closed with `PARTITION_NO_QUORUM`. Reconciliation MUST run on an
internal scheduler using node-local time and observed worker health; it MUST NOT accept
caller-supplied `now` or caller-supplied worker-lost sets over the public API.

**RUN-09 — One canonical run/attempt state machine.** Exactly one run/attempt state
vocabulary MUST be defined in the domain core and shared by the coordinator, store, API
contract, DB enum, and CLI; the parallel definitions MUST be removed. The domain transition
functions MUST be the only path by which a run or attempt state changes, and replay MUST
validate each transition against them. States such as `lost` MUST be surfaced, not collapsed.
Adding a state MUST require updating the OpenAPI enum, DB enum, and UI status map in one
change, with a CI check that regenerates clients and fails on drift.

**RUN-10 — Quotas must count queued work and apply to retry.** Quota evaluation MUST be a
single shared admission function invoked by `submit`, `retry`, and reconcile-driven requeue,
and it MUST count `queued` runs. Admission MUST additionally enforce a bounded queue depth
and aggregate CPU/memory/disk/output reservations per tenant. Quota decisions MUST be
re-evaluated at lease grant, and `validate` and `submit` MUST use the same evaluation context.
A test MUST assert retries cannot raise concurrency above the limit.

**RUN-11 — Quotas must be hierarchical and fair.** The quota model MUST be tenant-scoped:
cluster → project/team → principal, each able to set tighter limits. Every run MUST carry
`tenantId`/`projectId` and MUST be authorized against it. Scheduling MUST account for
per-node load and per-tenant in-flight work, and the cluster MUST implement a documented
fairness policy with a priority class that cannot starve lower classes. The UI MUST expose
per-tenant and per-project consumption and remaining quota. See D12, D17.

**RUN-12 — Cancel must have a deadline and an escalation path.** Every cancel request MUST
record a committed `cancelDeadline`. A reconciler MUST force-fence any attempt that has not
reported within that deadline and MUST drive the run to a terminal state. While a cancel is
pending the API MUST expose the pending cancel, its deadline, and the last heartbeat age, and
the UI MUST offer escalation. See UX-04.

**RUN-13 — Committed run state must be durable.** The run ledger and committed cluster event
log MUST be backed by durable node-local storage with defined transaction boundaries and MUST
be fully rebuildable by replay. A node MUST NOT advertise execution capacity or serve run
reads as authoritative until its replayed state reaches the current committed height. After
restart the system MUST reconcile durable run records against replayed committed state and
MUST mark unreconciled records for operator action rather than silently ignoring them.

**RUN-14 — Preflight must share admission logic.** Preflight MUST be a thin wrapper over the
same non-mutating admission evaluation used by `submit`, MUST report image policy, quota,
secret authorization, network-policy feasibility, worker availability, and permission checks,
and MUST NOT report execution availability optimistically. Submission MUST re-evaluate
admission authoritatively. Admission MUST reject a run whose requested network policy cannot
be satisfied by cluster egress policy, with a stable code, before any run or lease event is
committed.

**RUN-15 — The submitted spec must survive end to end.** The API contract, `RunSpec`, the
committed `run.submitted` payload, and the durable run record MUST all carry the command,
declared output budget, secret references, and required capabilities, and the provider MUST
execute exactly what was committed. Any field the cluster cannot honour MUST be rejected at
admission with a stable error rather than silently defaulted. A round-trip test MUST assert a
submitted spec is byte-identical after commit, replay, and mirror.

**RUN-16 — Provider limits must derive from the committed spec.** All isolation limits MUST be
derived from the committed run spec, and the quota policy MUST define every enforced
dimension including PID limit, output bytes, and queue depth. The provider MUST refuse to
start a run whose limits it cannot enforce rather than substituting its own defaults. Per-node
quotas MUST be derived from measured host capacity and enforced as a reservation at
admission, with aggregate reserved CPU/memory/disk not exceeding a configured fraction of host
capacity.

**RUN-17 — Digest pinning must be enforced and recorded.** Admission MUST require
digest-pinned references per cluster policy, and the resolved digest and policy result MUST be
recorded on the run and on every attempt before execution. The pinning check MUST parse the
reference, require `<registry>/<repo>@sha256:<64 lowercase hex>`, and verify the digest equals
the digest resolved from the registry. The registry allowlist MUST default to a non-empty,
operator-supplied set; an empty set MUST be treated as deny-all.

**RUN-18 — Capacity view must be authoritative.** Scheduling MUST consult a single
authoritative capacity view reflecting committed membership, committed quarantine/eviction,
drain state, and observed health. `selectCandidate` MUST NOT accept an `excludedNodeIds`
parameter a caller may forget; exclusions MUST be derived inside the coordinator. A regression
test MUST assert a node quarantined via the eviction flow receives zero new leases.

**RUN-19 — Lease revocation must be committed.** Lease revocation MUST be a committed event
(`run.lease_revoked`) carrying lease ID, run ID, attempt, worker NodeId, membership epoch,
and fencing token. Every peer MUST apply revocation on replay, and lease records MUST retain
the fencing token so revocation can be verified rather than assumed. Membership change MUST
NOT invalidate a lease whose worker is unaffected.

**RUN-20 — The API must expose committed state.** Run list and run detail responses MUST be
derived from committed run state, with the local mirror presented only as supplementary
detail. Each attempt MUST expose lease ID, fencing token, membership epoch, worker NodeId,
fence reason, and last report time, and the response MUST indicate whether the serving node is
fully caught up. Duplicate-report and conflicting-submission counters MUST be exported as
metrics with bounded cardinality.

---

## EXEC — Worker isolation and execution

**EXEC-01 — A real isolation boundary.** A worker backend MUST execute the workload in a real
OCI runtime sandbox that is a process separate from the node API/UI process, and the backend
MUST be identified by an immutable `kind` string with no `*_stub` suffix in any non-test
build. The repository MUST contain the actual runtime invocation and a checked-in end-to-end
test that starts a hostile image and demonstrates it cannot see the host.

**EXEC-02 — Digest resolution and verification.** The worker MUST resolve the submitted
reference to an immutable `sha256` manifest digest inside the isolation boundary, MUST verify
the pulled manifest against that digest before execution, and MUST persist the resolved digest
and image policy decision durably per attempt. Registry endpoints MUST be constrained to an
operator-configured allowlist and layer/blob sizes MUST be capped.

**EXEC-03 — Limits must be enforced by the isolation mechanism.** CPU, memory, PID, disk,
wall-clock, and output limits MUST be applied by the isolation mechanism itself (for example
cgroup v2 controllers and a size-bounded scratch filesystem), not by the workload or by
in-process bookkeeping, and the backend MUST read back the applied limits before reporting the
workload as `running`. `pidLimit` MUST be derived from the validated run spec and bounded by an
operator maximum.

**EXEC-04 — Digest pinning must not be a substring test.** Digest pinning MUST be enabled by
default and MUST NOT be configurable off without an explicit, audited operator override.

**EXEC-05 — Egress must be enforced at the isolation boundary.** Egress enforcement MUST be
performed by the isolation mechanism (network namespace with no default route plus an explicit
allowlist, or an intercepting proxy that resolves and pins IPs), and MUST operate on resolved
addresses rather than submitted hostnames. Metadata and control-plane ranges MUST be blocked by
address at the enforcement point and re-checked after every DNS resolution. The policy engine
MUST fail closed when the egress enforcement layer cannot be established.

**EXEC-06 — A hardening contract must exist and be mandatory.** `WorkerSpec` MUST carry an
explicit, non-optional hardening profile every backend MUST apply: non-root uid/gid,
`no_new_privileges`, an empty dropped capability set, a default-deny seccomp profile, an
AppArmor or SELinux profile, a read-only root filesystem with an explicit writable scratch
path, and private PID/IPC/network namespaces. Backends MUST refuse to start a workload for
which they cannot apply the full profile.

**EXEC-07 — Worker identity must be signed and lease-bound.** A worker identity presented to
the secret broker MUST be a signed assertion bound to cluster ID, membership epoch, run ID,
attempt ID, lease ID, and fencing token, and the broker MUST verify that signature against the
admitted-membership key set before returning any value. The broker MUST additionally require
that the lease and fencing token are still valid for the committed attempt. Unauthenticated or
shape-only-valid identities MUST be rejected and audited.

**EXEC-08 — Secrets must reach the worker only through a scoped channel.** The environment
schema MUST be populated from the run's authorized secret references by the broker at dispatch
time. The worker MUST receive values only through a scoped injection mechanism (file
descriptor, tmpfs, or agent socket) — never argv, process environment, image layers, or the
scratch filesystem. Literal environment values and command arguments MUST be length-capped and
rejected when they match a secret-value or credential pattern. Temporary credential material
MUST be written outside any directory the workload can read and shredded on teardown.

**EXEC-09 — Wall-clock enforcement must be external and cover pull.** The wall-clock deadline
MUST be computed at admission time and passed into the backend with pull, unpack, and start
inside the budget. The enforcement mechanism MUST be external to the node process (a monotonic
deadline enforced by the isolation runtime). Timer-based soft cancellation MAY exist but MUST
NOT be the sole enforcement path.

**EXEC-10 — Cancellation must always reach teardown.** `cancel` MUST be idempotent and MUST
always reach teardown: it MUST wrap the backend call in a bounded timeout with a forced-kill
escalation, and teardown MUST run in a `finally` block regardless of backend outcome. A run
MUST NOT be removed from the runtime's active set until its cleanup report has been recorded.
Repeated cancels for an already-cancelled run MUST still be acknowledged with the current
teardown state.

**EXEC-11 — Cleanup failure must be visible and retryable.** A cleanup report of
`{scratchRemoved:false}` or `{tempCredsRevoked:false}` MUST record the attempt as
`infrastructure_error`, increment an orphan-cleanup counter, and be retried with backoff until
it succeeds or the operator quarantines the worker. The runtime MUST persist scratch locations
durably before execution so orphans are recoverable after a crash.

**EXEC-12 — Worker state must survive restart.** The runtime MUST durably record every active
attempt (run ID, backend run ID, scratch path, worker identity, start time) before the
workload starts, and MUST reconcile that record against live workers at startup. Startup MUST
sweep scratch directories with no owning attempt and reclaim or quarantine them.
`listActiveRunIds` MUST be exposed through the health endpoint.

**EXEC-13 — Terminal reasons must be structured.** Terminal worker results MUST carry a
structured `terminationReason` enum covering at minimum `image_pull_failed`, `policy_denied`,
`wall_clock_timeout`, `memory_limit`, `cpu_limit`, `pid_limit`, `disk_limit`, `output_limit`,
`seccomp_violation`, `startup_failure`, `application_exit`, `cancelled`, and
`infrastructure_error`, and that reason MUST be committed per attempt and surfaced in API,
CLI, and UI. A run killed by an enforced limit MUST be visually and programmatically
distinguishable from a run that failed on its own.

**EXEC-14 — Dispatch failure must not reach the user as a silent success.** The submission path
MUST synchronously validate the full execution spec, including image pinning and network
policy, before returning `202`, and MUST return `400`/`422` with a structured policy code when
validation fails. Any asynchronous dispatch failure MUST be recorded as an attempt with
`infrastructure_error` and a terminal reason, visible in run history.

**EXEC-15 — Worker results must reach the coordinator.** The execution provider MUST translate
every terminal `WorkerResult` into exactly one committed attempt observation carrying the
fencing token, and the node store MUST be updated from that observation. A run MUST NOT remain
non-terminal after the worker reports a terminal result, and a watchdog MUST reconcile any run
non-terminal beyond lease plus grace period.

**EXEC-16 — Scratch paths must not be caller-supplied.** `scratchDir` MUST NOT be settable by
submitters. A backend MUST allocate its own scratch path under an operator-configured root,
create it with restrictive permissions, and verify via `realpath` that the resolved path is a
fresh directory inside that root before use, failing closed on symlink or traversal. Cleanup
MUST verify the resolved path is still inside the root and MUST refuse to follow symlinks.

**EXEC-17 — Workload output must not sit in process memory.** Artifacts MUST be stored
through the content store as encrypted, checksummed, content-addressed chunks with explicit
classification, replication, and retention metadata, and MUST NOT be held in an unbounded
process-global map. Every artifact read MUST be authorized against the requesting principal's
access to the owning run and attempt, and a download MUST reject any chunk whose recorded
owner does not match the authorized run. Response filenames MUST be constructed from
validated values, never from raw route parameters.
*Current: artifacts are held in a module-level `Map` that grows until OOM. `storeArtifact`
has no caller so the write path is latent, but the read endpoints are live, unauthenticated,
and `/runs/artifacts/:chunkId` does not even confirm the run exists. See SEC-11.*

**EXEC-18 — Log streaming must be bounded and resumable.** The SSE log endpoint MUST require
an authorized principal and MUST be scoped to a specific run and attempt. It MUST enforce a
per-attempt cumulative byte cap and a per-run chunk cap derived from the attempt's
`outputBytes` limit, MUST truncate with an explicit `truncated` marker rather than throwing,
and MUST enforce a maximum number of concurrent followers per run. Connections MUST carry
heartbeats and be closed on idle timeout. Reaching the cap MUST stop the workload, not
silently discard output.
*Current: the endpoint is unauthenticated, registers subscribers into an unbounded set with
no cap, heartbeat, idle timeout, or backpressure, and `run_log_entries.message` has no byte
or row limit — so a flooding workload can exhaust API memory and disk.*

**EXEC-19 — Artifact and chunk reads must be attempt-scoped and authenticated.** A read
stream MUST reject any chunk whose authenticated attempt or stream type does not equal the
requested attempt, and cursors MUST be authenticated so they cannot be forged or replayed
across attempts or clusters. Address knowledge MUST NOT be sufficient for access; the
authorization decision MUST be made by the domain core, not the storage adapter. See SEC-10,
SEC-11.

---

## SEC — Secrets and content store

**SEC-01 — One secret broker implementation.** The package MUST expose exactly one module
entrypoint; any alternate or legacy implementation MUST be deleted rather than retained
alongside it. A single `SecretBroker` interface MUST key every secret by
`(clusterId, jobId, attemptId, secretId)` and MUST reject any read whose scope tuple does not
match exactly. The broker MUST be reachable from run submission to worker start such that no
caller can construct a secret store directly. See D15.

**SEC-02 — Worker identity must be cryptographically bound to the lease.** Every secret read
MUST present a capability cryptographically bound to the committed lease (run ID, attempt
ordinal, `workerNodeId`, membership epoch, fencing token, expiry) and signed by the issuing
node. `issuedAt`/`expiresAt` alone MUST NOT be treated as authorization. Maximum worker
credential lifetime MUST be bounded by the lease TTL.

**SEC-03 — Expiry must be enforced by the broker.** Expiry MUST be enforced by the broker, not
delegated to the store; `get` MUST reject any record lacking a defined, unexpired `expiresAt`.
The persisted record MUST include `createdAt`/`expiresAt` and the store adapter MUST persist
them verbatim. `ttlMs` MUST be validated against an explicit minimum and maximum and MUST
reject non-positive values. Expiry MUST be evaluated against a monotonic clock not subject to
wall-clock rollback.

**SEC-04 — Revocation must destroy, not mark.** Revocation MUST destroy the stored value, not
merely mark it unreadable, and MUST be idempotent. The broker MUST run a bounded reaper that
destroys records past `expiresAt` and MUST expose the count and age of the oldest live record
as a metric.

**SEC-05 — Secrets must have a durable, non-plaintext model.** The schema MUST define a
`secrets` table storing only `(secretId, clusterId, jobId, attemptId, workerNodeId, version,
createdAt, expiresAt, revokedAt, vault-pointer-or-ciphertext)`. Run and attempt records MUST
persist the ordered list of authorized `SecretRef` identifiers and the authorization decision,
with no secret values. Neither table MUST contain a plaintext secret value. See D16.

**SEC-06 — Redaction must be mandatory and value-aware.** `createAuditEvent` MUST apply
redaction before returning; redaction MUST NOT be a separate opt-in step. Redaction MUST
operate on both key names and values, covering base64, JSON-nested, and concatenated forms,
and MUST cover the message, stack, and correlation fields of every log sink. All workload
stdout, stderr, and backend error text MUST pass through the same redaction pipeline before
persistence, before SSE broadcast, and before any log sink.

**SEC-07 — Content-store keys must be scoped and metadata authenticated.** Chunk encryption
MUST use per-tenant or per-classification data-encryption keys, each with a key ID stored in
chunk metadata, and MUST pass `attemptId`, `streamType`, and content address as AEAD additional
authenticated data. Key compromise MUST be scoped to a single tenant and recoverable by
re-wrapping a new DEK without re-encrypting all ciphertext.

**SEC-08 — Addressing must not leak content equality.** Chunk addressing MUST be deterministic
per logical content (e.g. HMAC of plaintext under a per-tenant dedup key) so dedup is
functional without exposing cross-tenant equality. The plaintext checksum MUST NOT appear in
any replicated or peer-visible metadata; peers MUST verify integrity using the AEAD tag plus a
keyed MAC. Reconciliation MUST be idempotent.

**SEC-09 — Integrity verification must be mandatory.** `verifyRef` MUST require the expected
digest; a caller MUST NOT be able to obtain a passing verification without a reference digest.
Every read path MUST re-derive the address from the ciphertext and compare it to the requested
address, MUST verify the AEAD tag, and MUST fail closed on any mismatch.

**SEC-10 — Chunk reads must be authorized and attempt-scoped.** Every chunk read MUST be
authorized against committed ownership (cluster, run, attempt) and classification before bytes
are returned, and the authorization decision MUST be made by the domain core, not the storage
adapter. `readStream` MUST reject any chunk ref whose authenticated `attemptId`/`streamType`
does not equal the requested attempt, and MUST verify the cursor's embedded attempt against
the request. Cursors MUST be authenticated (HMAC or AEAD).

**SEC-11 — Artifact URLs must be signed and expiring.** `ArtifactRef` MUST carry an expiry, a
single-use or scoped nonce, the requesting principal, and a signature over
`(clusterId, runId, attemptId, contentAddress, expiry, principal)`. Download URLs MUST be
signed, MUST expire within a configured maximum, and MUST be verified at download time. The
download handler MUST authorize the caller against the run owner, MUST verify the checksum, and
MUST set `Cache-Control: no-store`.

**SEC-12 — Retention metadata must be attached and enforced.** Retention metadata MUST be
written atomically with the chunk and MUST be queryable without decrypting. Every stored chunk
MUST carry a retention policy; `size` and `none` MUST be rejected for confidential/restricted
classifications. Count-based retention MUST evict least-recently-accessed content, never
most-accessed. A scheduled, observable retention sweeper MUST delete expired content and emit
metrics for bytes and objects reclaimed.

**SEC-13 — An orphan-chunk collector must exist.** The content store MUST maintain a durable
owner reference for every chunk and MUST provide a garbage collector that deletes chunks
unreferenced after a configurable grace period. Deleting a run, attempt, or membership MUST
enqueue the affected chunks for collection. Retention rules declared as configuration MUST be
executable.

**SEC-14 — Non-production crypto must not be reachable.** Non-production encryptors MUST NOT be
exported from a package entrypoint. `createChunker` MUST refuse to run with an algorithm
outside the approved production allowlist and MUST reject a zero or repeated IV. Each chunk
MUST record the algorithm and key ID used, and readers MUST reject chunks whose algorithm is
not in the local allowlist. Checksum and MAC verification MUST use `crypto.timingSafeEqual`
over fixed-length buffers with an explicit length check performed before the comparison.

**SEC-15 — Empty secret allowlist is a configuration error.** An empty secret-reference
allowlist MUST be treated as a configuration error and MUST refuse secret-bearing runs.
References MUST be resolvable vault identifiers, and authorization MUST verify the resolved
secret belongs to the requesting principal's project and tenant. Production secrets MUST
require approval from at least two distinct principals, recorded in the audit trail before the
value is issued. Rotation MUST assign a monotonically increasing version and MUST NOT change
the value of a version already handed to an in-flight attempt without a recorded re-issue.

**SEC-16 — Every secret read must be audited.** Every secret issue, read, denied read,
rotation, and revocation MUST produce an append-only audit record containing secret ID,
cluster, job, attempt, worker NodeId, decision, and correlation IDs, written before the value
is returned. Audit records MUST be hash-linked per secret and per principal so tampering is
detectable, and IDs MUST come from a CSPRNG or a durable monotonic counter. Audit storage MUST
be indexed by secret ID and worker NodeId.

**SEC-17 — Four-eyes and scan gates.** A secret marked production MUST require approval from
two distinct principals. CI MUST run a secret scanner over the repository and fail the build
on any match outside an approved test-fixture path.

---

## API — Contracts, authN/authZ, versioning

**API-01 — Authentication must fail closed.** The local API MUST reject every request that does
not present a valid, unexpired, non-revoked credential before any route handler runs; the only
exceptions are the liveness probe and endpoints explicitly declared `security: []`. The server
MUST derive an `actor` (subject, tenant/organization, roles) from the credential and MUST NOT
accept an actor identifier from the request body, query, or path. A deployment MUST fail closed
at startup if authentication cannot be configured. CORS MUST be an explicit allowlist;
`Access-Control-Allow-Credentials` MUST be set only for allowlisted origins.

**API-02 — Authorization must be evaluated before protected reads.** The API MUST define and
enforce a role model with at least `viewer`, `operator`, and `admin`, and MUST map every OpenAPI
operation to exactly one required role via an explicit authorization policy that is
unit-tested against the spec. Authorization MUST be evaluated before any protected state is
read, and a denial MUST return 403 with a stable machine-readable code. Every durable record
MUST carry a non-null `tenantId`, and every query MUST be scoped by it at the data-access
layer. See D12.

**API-03 — Node identity must not authenticate users.** The API MUST NOT hold or use the node's
signing key to authenticate a user action. A ballot MUST be constructed only from a
credential-bound actor identity the server derives itself. Where a node signature is required,
it MUST cover the authenticated actor, the actor's role, and the request ID, and the audit
record MUST retain both identities. Casting a vote MUST require at minimum the `operator` role.

**API-04 — Destructive governance actions need explicit authorization.** Voluntary leave,
eviction, kill-switch activation, flag mutation, and reconciliation MUST require an
authenticated `admin`/`operator` actor as appropriate, MUST be audited with the derived actor
identifier (not a client-supplied string), and MUST be idempotent under a supplied
`Idempotency-Key`.

**API-05 — Idempotency must be per-actor, header-based, and bounded.** Every non-idempotent
operation MUST accept idempotency via the `Idempotency-Key` request header, with documented
maximum length, lifetime, and retention. The key MUST be bound to the authenticated actor, the
operation, and a hash of the canonical request body. Replaying the same key with the same
payload MUST return the original response; with a different payload MUST return 409 including
actor-visible conflict metadata only. A cross-tenant key collision MUST reveal no run
metadata. Body-supplied `clientRequestId` SHOULD be deprecated and retained for backward
compatibility for one release.

**API-06 — Every mutation carries its preconditions.** Retry, cancel, vote, and reconcile MUST
carry an expected state or membership-epoch precondition and MUST return 409 when the
precondition fails.

**API-07 — Rate limits must be enforced per route.** Every route MUST have an explicit
per-actor rate limit enforced by middleware before the handler runs, keyed from the
authenticated actor rather than client-controlled values. Expensive/streaming operations (log
follow, catch-up, reconciliation, artifact transfer, preflight, submit) MUST have materially
tighter limits. Exceeding a limit MUST return 429 with `Retry-After`.

**API-08 — The OpenAPI document is the source of truth.** Every reachable operation MUST be
declared in the versioned OpenAPI contract with its security requirement, request schema, and
all response/failure statuses. CI MUST fail if the implemented Express route table and the
document's `paths` differ in either direction. A generated request/response contract test
suite MUST run against the server. Request objects MUST declare `additionalProperties: false`.
Cross-field constraints MUST be expressed in the document and enforced by the generated schema.
Every request MUST be validated by a generated schema and every response serialized through a
generated response schema; route code MUST NOT cast `req.body`/`req.query`/`req.params`.

**API-09 — CLI credentials must use the OS store.** The CLI MUST store credentials in the OS
credential store when available and MUST fall back to an encrypted file only after explicit
user acknowledgement, and MUST NOT print a storage claim it did not perform. Tokens MUST be
issued by the server with a bounded lifetime and MUST support revocation. The CLI MUST accept
tokens only via prompt or environment variable, never as a command-line argument (which leaks
into shell history and process arguments).

**API-10 — Terminal error handling must be uniform.** A single terminal error middleware MUST
be registered last and MUST convert every failure — including body-parse errors and unhandled
async rejections — into the versioned `ErrorResponse` envelope with a stable machine-readable
`code`. It MUST NOT include stack traces, SQL, file paths, peer addresses, or internal
identifiers in the response body; detail MUST be logged server-side under the request ID only.
The `code` MUST be drawn from a closed, versioned enumeration declared in the OpenAPI
document, each mapping deterministically to one HTTP status. Authorization failures, decision
failures, and validation failures MUST have distinct codes. New codes MUST be additive-only
within a major version.

**API-11 — Pagination must be stable and bounded.** All collection endpoints MUST use opaque,
base64url-encoded cursors over a total ordering with a unique tiebreaker, and MUST return 400
with a stable `INVALID_CURSOR` code for an undecodable, expired, or tampered cursor. A `limit`
MUST be required on every collection endpoint and bounded by the spec.

**API-12 — API versioning and deprecation.** The HTTP API MUST be versioned in the path, MUST
advertise the supported range, and MUST reject unsupported versions with a stable code and a
documented upgrade path. Breaking changes MUST require a new major version; removals MUST be
preceded by a documented deprecation window with `Deprecation` and `Sunset` headers.

**API-13 — Health and readiness must be real.** The API MUST expose `/livez` (process only),
`/readyz` (503 when a critical dependency or quorum is unavailable), and a versioned,
tenant-safe `/healthz` returning per-subsystem status with an overall state and no internal
detail. A machine-readable `/metrics` endpoint MUST be access-controlled and expose the
observability signals with bounded label cardinality.

**API-14 — Correlation IDs must be server-generated.** Correlation identifiers MUST be
server-generated opaque values. An inbound correlation header MAY be propagated only after
validation against a strict character/length pattern. The identifier MUST be returned in the
response and echoed into logs and audit rows identically. Metrics and logs MUST NOT use
unbounded request-supplied values as label dimensions.

**API-15 — The audit trail must be queryable and correlatable.** Every state-changing operation
MUST write an audit event carrying the derived actor identifier, acting role, cluster ID,
request ID, idempotency key where applicable, and expected/observed membership epoch. Audit
events MUST be queryable through a paginated, tenant-scoped endpoint restricted to an
authorized role, and MUST be append-only. The `detail` payload MUST pass through a shared
redaction filter before being written to either the audit table or logs.

---

## DATA — Schema, migrations, tenancy, backup

**DATA-01 — Versioned migrations, no destructive push.** Every schema change MUST be
accompanied by a committed, reviewed SQL migration and a `migrate` deploy path; `push` MUST be
restricted to ephemeral local development databases and MUST NOT run against a node's durable
store. A `schema_migrations` ledger MUST record the applied version, and a node MUST refuse to
advertise capacity when its binary's schema version is newer than the ledger. Destructive DDL
MUST NOT be issued by an automated post-merge step.

**DATA-02 — Migrations must be safe on a mixed-version fleet.** Database deployment MUST be a
separate, explicitly invoked operator step that acquires a migration advisory lock, emits and
archives the SQL it intends to run, and aborts if any node in the cluster reports a schema
version outside the declared compatibility window. A versioned upgrade document MUST define the
supported mixed-version window and the exact node upgrade ordering for a rolling upgrade.

**DATA-03 — Backups must round-trip.** The backup encoder MUST serialize `Date` values to
explicit ISO-8601 UTC strings and reject any other non-JSON type before canonicalization. A
round-trip test MUST assert every column value after backup→restore is deep-equal to the value
before backup, including all timestamps, and MUST run in CI as a release gate.

**DATA-04 — Restore must be verified before it is destructive.** A restore MUST verify the
backup's signature, cluster ID, schema version, and consensus height/epoch against the live
cluster BEFORE any destructive statement, and MUST abort with the node untouched on any
mismatch. `local_node_identity` MUST be excluded from restorable payloads and re-derived
locally; a restore that would change `cluster_id` MUST be refused. Restore MUST run only
against a quiesced node not advertising capacity. `verifyRestore` MUST verify against the real
cluster key material, never a placeholder.

**DATA-05 — Run identity must be unique per scope.** The idempotency uniqueness constraint MUST
be scoped to `(cluster_id, submitted_by, client_request_id)` and MUST match the deterministic
run identity the coordinator derives. The persisted run primary key MUST be the deterministic
run ID. `workload_runs` MUST carry a NOT NULL `cluster_id`.

**DATA-06 — State transitions must be serialized and validated.** Every run/attempt state
transition MUST take a row lock (`SELECT … FOR UPDATE`) or use a conditional update whose
`WHERE` clause asserts the expected prior state (zero affected rows = conflict). Terminal states
MUST be immutable at the database layer. `markRunTerminal`/`setRunRunning` MUST validate every
transition against the domain state machine before writing.

**DATA-07 — Audit must be tamper-evident and survive restore.** Audit event checksums MUST cover
the complete canonical row content — including `actorNodeId`, `attemptId`, `idempotencyKey`,
`detail`, and a UTC timestamp — and MUST be chained to the previous row's hash so insertion,
modification, reordering, and deletion are all detectable. A scheduled `verifyAuditChain` MUST
alert on any mismatch. Restore MUST be additive/merge-only for append-only tables and MUST NOT
delete or roll back audit rows. Audit rows MUST additionally be anchored off-node (hash-chained
export) at a cadence no coarser than the documented RPO. Attempt checksums MUST cover the full
attempt row; log-entry checksums MUST be hash-chained to the previous sequence.

**DATA-08 — Backup must be signed, encrypted, and consistent.** Backup artifacts MUST be signed
with the node identity key, encrypted at rest with a separate backup key, and written to a
`0600` file via fsync-and-rename. Backup MUST read all tables inside a single `REPEATABLE READ`
transaction. The manifest MUST record cluster ID, membership epoch, consensus height, schema
version, and the exact relative path/length/checksum of every artifact. Restore MUST reject a
backup whose recorded cluster ID differs from the local cluster. RPO/RTO MUST be documented and
a restore drill MUST be scheduled.

**DATA-09 — Redaction must reach durable storage.** The durable store MUST reject any run
command or log line matching a configured secret-pattern denylist and MUST run every audit
`detail` object through the domain redactor before insert. Job records MUST reference secrets by
`SecretRef` only.

**DATA-10 — Attempt counters must have a single writer.** `attempt_count` MUST be maintained by
exactly one code path and MUST equal `count(*)` from attempts for that run. Attempt ordinals MUST
be allocated under a row lock and passed explicitly to the mirror; the store MUST NOT derive
ordinals independently. A reconciliation job MUST assert the invariant and alert on divergence.

**DATA-11 — The durable store must encode invariants.** Every jsonb column modelling a domain
value MUST have a CHECK constraint enforcing presence, types, and ranges. Every
user-influenced text column MUST carry an explicit length bound enforced by the database.
Foreign keys MUST be added on denormalized node/run/attempt identifiers, and the frozen
electorate MUST be normalized into a table with a foreign key so voter eligibility is
checkable. `cluster_nodes.name` MUST be unique within the cluster.

**DATA-12 — Retention must be machine-enforced.** Every retained class of record MUST carry an
explicit retention-deadline column with an index, and a scheduled, resumable retention sweeper
MUST enforce the documented windows and emit metrics/audit events for each deletion. Retention
policy MUST be machine-readable configuration validated at startup, not prose.

**DATA-13 — Deletion must not destroy audit or attempts.** Deleting a run MUST NOT cascade to
attempts or log entries; those MUST be retained until their own deadline and carry a
`deleted_at` tombstone on the parent. Audit rows MUST reference runs/attempts with
`ON DELETE SET NULL` plus a retained denormalised ID so audit history survives erasure.
`membership_votes` MUST use `ON DELETE RESTRICT`; ballots MUST NOT be cascaded away.

**DATA-14 — Enum drift must fail the build.** A single canonical state vocabulary MUST be the
source for the Drizzle `pgEnum` definitions, OpenAPI schemas, and generated client types, with
a CI check that regenerates clients and fails if the output differs from what is committed.
Every domain state MUST be representable in the database; adding a state without a matching
column MUST fail the build. Information-losing mappings (e.g. `lost` →
`infrastructure_error`) MUST be forbidden.

**DATA-15 — Restore rehearsal must be possible without touching production.** `NodeStore` MUST
accept an injected database handle so backup/restore can target a named, isolated target. A
restore MUST support a `--dry-run` mode that performs every validation and reports the plan
without writing, and MUST be rehearsed against a scratch database in CI before any release.

**DATA-16 — Audit MUST be atomic with, or durably queued ahead of, the effect.** Where the
effect and its audit row share a transaction, the audit MUST be written in that transaction.
Where they cannot, the audit record MUST be durably acknowledged **before** the effect is
reported successful, and a failed audit write MUST fail the operation closed or enqueue to a
durable retry queue with a visible backlog metric. A fire-and-forget sink
(`void … .catch(() => undefined)`) MUST NOT be used on any audit path; CI MUST fail on it.
Every swallowed audit error MUST increment `audit_write_failed_total` and raise an alert.
*Current: both the run-coordinator and governance audit sinks discard failures silently, so
state transitions can occur with no audit record and no signal that one is missing.*

---

## UX — User experience, accessibility, design system

**UX-01 — Preflight must be honest.** Preflight MUST share the admission evaluation with submit
and MUST cover image, permissions, quota, network policy, secrets, and worker health. It MUST
NOT render an affirmative verdict when any required dimension is unchecked, and it MUST carry a
`generatedAt` with a defined staleness window. A preflight verdict MUST be invalidated by any
payload change. See RUN-14.

**UX-02 — Voting must be role- and state-aware.** The UI MUST derive vote eligibility from
server-provided decision state — including expiry and whether the viewer is the candidate or
eviction target — and MUST NOT restate the threshold formula. Threshold text, denominator,
required votes, and remaining time MUST come from the API. Voting on an expired proposal MUST
be impossible, and the reason MUST be shown on the disabled control, not as a post-click error.

**UX-03 — Error states must be actionable and specific.** The shared error state MUST branch by
failure class: transport failure, 401 (offer re-auth, preserve route), 403 (name the missing
capability, disable actions), 404 (name the resource and ID), 429 (render `Retry-After`,
disable retry until it elapses), and 5xx. Every branch MUST display a copyable support
identifier from the `x-request-id` response header.

**UX-04 — Destructive actions need confirmation with blast radius.** Voluntary leave, eviction,
and cancel MUST open an in-app modal dialog (not a native `confirm`) naming the target, its
status, and the consequence. Eviction MUST state that it stops new assignments, revokes
credentials, and fences leases/fencing tokens, and MUST require typing the target's short ID to
enable confirm. Voluntary leave MUST list the active runs that will drain and require typing
`LEAVE`. Cancel MUST state that it is a request and that already-performed side effects are not
rolled back. Dialogs MUST be keyboard-operable with a focus trap, initial focus on the safe
control, and focus restored on close.

**UX-05 — Retry/cancel availability must come from the server.** The UI MUST derive retry and
cancel availability from an explicit server-provided capability flag (e.g. `retryable` +
`retryBlockedReason`), NOT from a client-side status list, and MUST NOT render a control the API
will reject. When a control is unavailable the UI MUST render it disabled with the server's
reason.

**UX-06 — Cancellation must be tracked.** After a cancel is accepted the UI MUST render a
persistent, non-dismissible `cancel_requested` banner until the run reaches a terminal state,
and MUST offer escalation and manual refresh.

**UX-07 — Empty vs not-found must be distinct.** Empty state and not-found MUST be distinct
states. A 404 MUST render a not-found view naming the requested identifier and offering a link
back to the collection. A genuinely empty collection MUST render an empty state with a single
primary next action. Neither may reuse copy implying data will "appear later."

**UX-08 — Degraded/partial states must be explicit.** Per-peer sync state (`synced`, `syncing`,
`degraded`, `stale`, `unreachable`) and numeric catch-up lag MUST be in the `Node` schema and
rendered per peer. The cluster summary MUST render a partial-accessibility banner whenever any
admitted member is not synced. Quorum loss MUST render a dedicated panel stating how many of
how many members are reachable, what halts (new assignments, membership commits), what may
still complete (existing unexpired leases), and a link to the quorum-loss runbook.

**UX-09 — Log viewing must be correct and reconnectable.** A single monotonically increasing
per-run log sequence MUST be used identically by the store, the paginated endpoint, and the SSE
stream, and the stream MUST set the SSE `id:` to that sequence. Follow mode MUST use a single
long-lived subscription whose identity depends only on the run ID, MUST reconnect with bounded
backoff, and MUST resume from the last `(attempt, sequence)` cursor. The client MUST
deduplicate merged live+stored entries keyed by `(attempt, sequence)`, render an explicit gap
marker on discontinuity, and show a truncation notice at the byte cap. A dropped stream MUST
render a distinct "reconnecting"/"disconnected" state, never `LIVE` with no stream open. See
RUN/RUN-13.

**UX-10 — Attempt history must be real and per-attempt.** The run detail API MUST return the
full attempt array including ordinal, status, worker NodeId, lease/fencing token, timestamps,
and a redacted error reason. The attempt history's "View logs" MUST navigate to an attempt-
filtered log view; `GET /runs/logs` MUST accept an optional `attempt` filter. Until
implemented, the control MUST be removed rather than rendered as an enabled button.

**UX-11 — Artifacts must be reachable and honest.** The artifacts panel MUST call the real API
and MUST NOT render a hardcoded empty state when artifacts exist. Artifact listing and download
MUST be scoped and authorized (see SEC-11). Response filenames MUST be constructed from
validated values, never raw route parameters.

**UX-12 — Submission must be reviewable and single-shot.** The submit control MUST be preceded
by a review step showing the resolved image, digest status, argv, network policy, and each
resource limit against remaining cluster capacity, invalidated by any payload change.
Double-submit MUST be prevented (disable in-flight; idempotency key stable per payload, not
per keystroke). The 409-idempotency-conflict recovery path MUST offer "generate a new key and
resubmit" — never an action that re-triggers the conflict. Schema errors MUST map to fields.

**UX-13 — Keyboard and accessibility floor.** Every interactive control MUST expose a
`:focus-visible` indicator meeting the 3:1 non-text contrast requirement; no control may set
`outline: none` without a visible replacement. All body/secondary/metadata text MUST meet
4.5:1 contrast with a 12px floor for identifiers/counts/status. Status MUST be conveyed by text
label AND a non-colour glyph, not colour alone; distinct lifecycle states MUST NOT share a
colour token. Mobile navigation MUST trap focus, handle Escape, move focus into the panel on
open, and mark the background `inert`. Contrast and focus checks MUST run in CI. Log live
regions MUST NOT use a high-frequency `aria-live` that floods screen readers; they MUST use an
opt-in, throttled live region.

**UX-14 — History and lists must scale.** Run history MUST paginate or virtualize (currently
capped at 50 with a dead-end cursor notice). Membership proposals and peers MUST paginate and
filter by status. Large tables MUST be virtualized. Deep-linked resource views MUST fetch by ID,
not filter a list. Filter/view state SHOULD live in the URL so views are shareable and
Back-preserving. Log rendering MUST be bounded/virtualized.

**UX-15 — Freshness must be visible.** Every data view MUST display the age of its data
("updated Xs ago") and MUST render a persistent staleness warning past a threshold. Failed
background refreshes MUST NOT silently leave last-good values; a degraded banner with retry MUST
appear. Polling SHOULD back off when the tab is hidden and MUST stop for terminal runs.

**UX-16 — Offline and health must be truthful.** The global connectivity indicator MUST be bound
to a real health query (API liveness, database, consensus) and MUST render live, degraded
(component named), and unreachable (with last-check age) states. It MUST NOT be a hardcoded
healthy indicator. The app MUST register `online`/`offline` listeners, render a persistent
offline banner that disables mutating controls, and distinguish transport failure from server
rejection in all mutation feedback.

**UX-17 — Capability gating in the UI.** The API MUST return the caller's effective capability
set, and the UI MUST gate every mutating control on it. In limited sessions the control MUST
render disabled with the specific missing capability named inline, not rely on a post-request
403.

---

## OPS — Observability, testing, release, compliance

**OPS-01 — Configure and adopt a test runner.** A single test runner MUST be configured
for every workspace package, with a root `test` script that fans out via `pnpm -r`.
Every package MUST expose a `test` script and CI MUST run it on every pull request. The
hostile-input classes in slice 6 MUST each have at least one automated test that fails
without the corresponding validation branch, and the release gate MUST require the full
suite green on the merge commit. Every assertion mechanism MUST fail the process with a
non-zero exit code; `console.assert` MUST NOT be used for test assertions.
*Status: the root Vitest config and `pnpm test` script are present; the latest local run
passed 254 tests in 14 files. A CI workflow runs typecheck, tests, and static guards.
The requirement remains partial because not every package has coverage and the hostile
peer, partition, replay, and recovery suites are still absent. The standalone smoke test
still uses `console.assert` and is not release evidence.*

**OPS-02 — CI must gate every release gate.** A CI provider MUST run install, typecheck, full
test suite, and build as required status checks on a protected release branch, so no release
tag can be cut without a green required-check run on that exact commit. Any release gate that
cannot be automated MUST be recorded as a signed, dated approval artifact rather than asserted
in prose.

**OPS-03 — Observability must be emission, not declaration.** Slice 6's observability item MUST
state that the deliverable is *emission*: each named signal MUST have a named instrumented call
site in the owning module. An exporter MUST be selected and configured, `/metrics` MUST be
mounted with access control, and a CI check MUST fail when any metric referenced by a registered
alert rule has no producing call site. The production binding MUST NOT be a no-op exporter.

**OPS-04 — Alerts must actually fire and must not fatigue.** Notification construction
MUST be wrapped so a failure to format or deliver still produces an observable
outcome; evaluation failures MUST be counted and logged at error level with bounded
cardinality rather than swallowed by an empty `catch {}`. `durationMs` MUST be a
sustained-condition window and `cooldownMs` MUST suppress re-fire for the stated
interval, both enforced by the evaluator — currently neither is read by `evaluate()`,
so a single-sample excursion pages. Handler and provider errors MUST increment an
`alert_delivery_failed_total` counter. A test MUST assert each rule transitions to
`firing` when its metric crosses threshold, and that a single-sample excursion does not
page.

**OPS-05 — Bounded metric cardinality.** A reserved-label convention MUST be defined and
enforced at the metric-recording API: labels from a fixed low-cardinality allowlist
(`nodeId`, `clusterId`, `status`, `reason`, `subsystem`) are permitted, and any high-
cardinality label (`runId`, `attemptId`, `requestId`, `clientKey`, `proposalId`) MUST be
rejected or dropped with a counted `metric_label_dropped_total` increment. Alert dedup keys
MUST derive only from the rule ID and declared match labels. CI MUST scan for high-cardinality
identifiers in label positions.

**OPS-06 — SLIs and SLOs must be defined.** `docs/slos.md` defines the SLIs. Each SLO MUST name
its alert rule and error-budget burn-rate thresholds, every alert threshold MUST cite the SLO it
protects, and a release MUST be blocked when any SLO's burn rate exceeds its budget.

**OPS-07 — Fault injection must be wired.** Every fault point in the registry MUST correspond to
an actual guarded call site in production code, and a test MUST demonstrate that activating it
changes observable behaviour. The injector MUST reject any configured `FaultType` it does not
implement, throwing at configuration time rather than defaulting to pass-through. Each of the
nine slice-6 scenarios MUST have an executable assertion.

**OPS-08 — Domain modules must emit structured logs.** Every `lib/*` module MUST accept an
injected logger and emit structured events for every state transition a release gate depends
on. The API layer MUST bridge pino into the shared `LogCorrelator` so correlation context is
the single carrier. CI MUST fail when a `lib/*` package calls `console.*` directly.

**OPS-09 — Runbooks must exist and resolve.** Every alert rule with severity Critical MUST
reference a runbook that exists in the repository; CI MUST fail when a `runbookUrl` does not
resolve to a committed file. Each runbook MUST contain detection signal, a triage decision tree,
exact operator commands per remediation, blast radius and side effects of each action, an
abort/rollback step, and an escalation path. Runbooks MUST cover the eight named topics
(quorum loss, suspected compromised peer, key revocation, worker containment, provider outage,
stuck proposal, stale lease, state restore). See `docs/runbooks/`.

**OPS-10 — On-call readiness.** An on-call readiness document MUST define an incident severity
scale (SEV1–SEV5) with explicit criteria, map every alert severity to a page-or-ticket
decision, and define acknowledgement and escalation timers per severity. Each severity MUST name
a responder role, channel, and time-to-mitigate target. A postmortem process MUST be defined for
SEV1/SEV2. On-call readiness MUST be a release gate requiring at least one completed game-day
exercising the SEV1 path.

**OPS-11 — Tracing must cross the peer boundary.** A single `CorrelationContext` type MUST be
defined once and reused by the domain, observability, and API layers. Peer-facing messages MUST
carry W3C `traceparent` plus the originating `requestId`/`runId`/`attemptId`, and
`PeerTransport.publish`/`openStream` MUST accept and propagate them. CI MUST fail when a
peer-facing message type omits trace context.
*Status: `CorrelationContext` is correctly defined as an alias of `CorrelationIds` at
`lib/observability/src/logCorrelation.ts:34` and re-exported by the barrel — there is no
dangling export. The gap is that `CorrelationIds` is declared separately in both
`lib/opennode-domain/src/audit.ts` and `lib/observability/src/logCorrelation.ts` with
incompatible optionality, and `PeerMessage` carries no trace context at all.*

**OPS-12 — The kill switch must be cluster-wide.** The kill switch MUST be committed to the
replicated log so every peer observes it within a bounded interval, and each node MUST enforce it
locally at lease acquisition and dispatch. Activation/deactivation MUST each write an immutable
audit event recording actor, reason, timestamp, and the committed log height at which it took
effect. A test MUST demonstrate that activating on one peer blocks new execution on all peers,
including across a partition, and that cancellation, cleanup, and membership-revocation paths
continue to function while active.

**OPS-13 — Feature flags must be single-authority, durable, and strict.** Feature flags and the
kill switch MUST have exactly one process-wide authority that every enforcement site reads.
Flag overrides MUST be persisted durably and replicated through the cluster log so all peers
agree, and MUST survive node restart. `POST /flags` MUST reject unknown flag keys with an
explicit 400 naming the unknown key; silently ignoring an unrecognized override MUST NOT be
permitted. Every flag mutation MUST write an immutable audit event (actor, previous value, new
value, reason), and the API MUST expose effective-vs-default diff.

**OPS-14 — Upgrade and rollback must be documented.** A versioned upgrade document MUST define
the supported mixed-version window, exact node upgrade ordering, and compatibility rules for both
`SCHEMA_VERSION` and peer protocol ranges, with each change classified backward/forward/neither
compatible. Rollback MUST NOT destroy audit history (see DATA-07) and MUST reconcile restored
state against the current committed consensus height before the node advertises capacity
(see SYNC-17). The rollback procedure MUST name a mechanism that exists in the target
deployment environment.

**OPS-15 — Clock injection for determinism.** Every time-dependent module MUST accept an
injected `Clock` exposing `now(): number` and MUST NOT call `Date.now()`/`new Date()`
directly. Time-dependent behavior (proposal/ballot/lease/credential/secret/nonce/retention/
health/alert windows) MUST be testable by advancing a fake clock with zero wall-clock delay.
Global monkey-patching of `Date.now` MUST NOT be used as a test mechanism. CI MUST fail when a
time-dependent module that should inject a clock calls `Date.now()` directly.

**OPS-16 — Backup/restore must be tested.** `todo.md` slice 6's backup/restore item MUST remain
unchecked until an automated test performs a full backup → destructive mutation → restore →
reconcile cycle and asserts the node reaches the same committed height and epoch, with both the
matching-key success path and the tampered-snapshot failure path covered.

**OPS-17 — Supply chain and provenance.** An SBOM MUST be generated for every release artifact in
a standard format and published alongside it. Builds MUST be signed and carry provenance
attestations linking artifact to source commit. A dependency-licence policy with an explicit
allow/deny list MUST be enforced in CI, and any commercially licensed dependency MUST be
recorded with its obligations. Worker quota policy MUST require digest-pinned images by default.

**OPS-18 — Data residency and audit export.** A data-residency policy MUST state which classes of
data (run specs, logs, artifacts, audit, secret references) may be stored in which
jurisdictions and MUST be enforced at configuration time. The audit log MUST be exportable in a
documented machine-readable format via both an authenticated API and a CLI command, and the
export itself MUST be audited.

**OPS-19 — Dependency typing must be complete.** Every workspace package MUST be listed in the
root `tsconfig.json` `references` and MUST be reachable from `pnpm typecheck`; CI MUST fail if
any package under `lib/` is missing from the reference graph. Barrel exports MUST be verified by
the build.
*Status: the root `tsconfig.json` carries 16 references and correctly includes `observability`,
`failure-injection`, and `feature-flags`. Two packages are absent: `./lib/peernet` (reachable only
transitively via `artifacts/api-server/tsconfig.json`, so the package with the most unresolved type
surface is the least checked) and `./lib/api-spec`, which has no `tsconfig.json` at all so its
`orval.config.ts` is never typechecked. `pnpm typecheck` also uses `--if-present`, so any package
without a `typecheck` script is silently skipped.*

**OPS-20 — Failure injection must not mask behavior.** A CI check MUST assert that every
registered fault-point name appears in the source tree, failing CI when one is orphaned. Any
subsystem with no fault points MUST be declared out of scope with written justification.

---

## Deferred unless required for MVP

- Open/permissionless membership, token economics, public reputation, and Sybil resistance. *(Note: Sybil resistance is already load-bearing for the MVP handshake path — handshake rate limiting is keyed on a self-asserted NodeId and membership is never checked at connect. See NET-05, NET-04.)*
- Multi-cloud worker provisioning, GPUs, persistent workload volumes, unrestricted internet egress, and multi-region policy.
- Exactly-once workload side effects, arbitrary Kubernetes manifests, privileged containers, or user-controlled host mounts. *(Note: privileged containers and user-controlled host mounts are load-bearing escapes for the MVP execution path — the hardening contract is mandatory, not deferred. See EXEC-06, EXEC-16.)*
- Replicating every private artifact to every peer; data replication must follow explicit authorization, encryption, and retention policy.

---

## CONC — Concurrency and atomicity

A separate review pass looked specifically for races and found a class of defect the
other requirements do not cover: existing requirements serialize *log appends*
(SYNC-02) and *database rows* (DATA-06), but nothing serializes the *allocation* of
values derived from a prior read.

**CONC-01 — Derived-identifier allocation MUST be atomic with its commit.** Attempt
ordinals, membership epochs, event IDs, per-run log sequence numbers, idempotency-key
records, and quota counters MUST be allocated inside the same serialized critical section
(advisory lock, `SELECT … FOR UPDATE`, or compare-and-set) that commits the corresponding
event, and MUST be derived from durable state, never from a snapshot read before an
`await`. Concurrent execution of two identical submissions, two lease acquisitions for one
run, or two membership commits MUST produce exactly one committed effect and a deterministic
conflict for the loser. *Evidence: `RunCoordinator.acquireLease`
(`lib/run-coordinator/src/coordinator.ts:485-501`) reads `state.attempts`, derives
`attempt = count + 1`, then yields at `:502`, `:543` and `:555` with no mutex. The reducer
at `:891-896` silently discards a duplicate `run.lease_granted` for an existing
`(runId, attempt)` while `acquireLease` still returns a fully-formed `CommittedLease`
(`:585-594`) and still writes an audit event — and the caller then dispatches a second
`executionProvider.startRun`. Candidate selection is deterministic, so both callers receive
the **same** worker, not different workers; the defect is a missing conflict check, not
non-deterministic selection.*

**CONC-02 — Catch-up MUST NOT truncate under a live writer.** Log truncation MUST take the
same exclusive lock as local append, and any entry appended between `truncateTo` and
`appendVerified` MUST be re-fetched rather than discarded. Derived projections MUST receive
a rollback signal before replacement (see SYNC-16).

**CONC-03 — The event loop is a safety-critical resource.** No code path reachable from a
request, timer, or stream callback may block the event loop beyond a documented budget;
CPU-bound or sleep waits MUST use `setTimeout` or chunked yielding, and CI MUST fail on
`while (Date.now() …)`-style spins. Every request and outbound operation MUST carry an
`AbortSignal` deadline. Health checks MUST run concurrently with a per-registry timeout and
MUST cache results. Streaming fan-out MUST respect `res.write()` backpressure via `drain`,
MUST cap per-connection buffered bytes, and MUST close a connection that exceeds the cap.
*Evidence: `lib/failure-injection/src/injector.ts` `injectSync` Latency is a synchronous
busy-wait that pins the single Node thread; `lib/observability/src/healthCheck.ts` runs
every check sequentially with a 5s timeout and no caching, so N pollers each pay the full
worst case.*

**CONC-04 — Process-local accumulators MUST be bounded and observable.** Every map keyed by
a cluster-lifetime identifier (leases, worker attempt history, proposals, ballot revisions,
proposal metadata) MUST declare a maximum size and an eviction policy tied to a terminal
state or retention deadline, MUST evict on a schedule, and MUST expose `size` and
`evictions_total` as metrics with an alert above a configured fraction of the bound.
Attempt-history records MUST be immutable once written.
*Evidence: `lib/membership-log/src/leases.ts` grows on every `add()` and entries expire
normally without being removed — with a 30s lease TTL they accumulate until an unrelated
epoch change prunes them.*

**CONC-05 — Lazy singletons MUST memoise the promise.** Any lazy async singleton MUST cache
the in-flight promise, not the resolved value, so concurrent callers await one construction.
No safety authority may be constructed twice.
*Evidence: `getGovernance` (`artifacts/api-server/src/lib/runtime.ts:122-127`) and
`getRunCoordinator` (`:154-183`) both check-then-`await`-then-assign with no memoization and
no startup pre-warm. Two concurrent requests each receive their **own** instance — two
in-memory event logs, two membership logs re-seeded to epoch 0, two run ledgers — and the
per-log `SEQUENCE_GAP` guard cannot detect the split because each believes it is at height 0.*

## CFG — Configuration authority

**CFG-01 — One authority, constructed once.** Every safety authority (kill switch,
assignment gate, quorum policy, credential revoker, feature-flag registry) MUST be
constructed exactly once during bootstrap, injected, and reachable through a single module
handle; startup MUST assert that no second instance exists.
*Evidence: `artifacts/api-server` constructs two disjoint `FeatureFlags` instances —
`runtime.ts:60` (`enableKillSwitch: true`), which is wired into `RunCoordinator` at `:180`
and returned by `getFeatureFlags()` to the membership routes, and the package singleton at
`lib/feature-flags/src/index.ts:132` (default config), which the flags routes mutate.
`POST /flags` and `POST /flags/kill-switch/activate` therefore have **zero** effect on run
execution, and no endpoint can arm the coordinator's kill switch, so the kill-switch guard
is permanently inert and both kill-switch endpoints return 409 unconditionally.*

**CFG-02 — Configuration mutation MUST be a merge and MUST NOT reset safety state.** A flag
update MUST mutate the existing registry in place, MUST preserve every unspecified flag and
all non-flag state, and MUST be rejected with `409` if it would clear a latched safety
control. The kill-switch *capability* flag MUST be immutable configuration, never derived
from runtime engagement state.
*Evidence: `artifacts/api-server/src/routes/flags.ts:61` copies the kill switch's
engagement state into the `enableKillSwitch` capability flag, so any future wiring that
installs a capable-but-idle instance has its capability permanently revoked by the first
`POST /flags`.*

**CFG-03 — Flag overrides MUST be rejected when unknown.** An unrecognized flag key MUST
return an error naming the unknown key and the valid set, never a silent success.

## ENC — Encoding, identifiers, and injection

**ENC-01 — Identifiers MUST have a closed grammar.** `NodeId`, `ClusterId`, proposal ID,
run name, node name, and every value used as a map key or in a signed encoding MUST be
validated against a documented ASCII grammar at construction **and** re-validated at every
persistence boundary. Free-text fields MUST be NFC-normalized, MUST reject C0/C1 control
characters, zero-width characters, bidi overrides, and NUL, and MUST be length-bounded.
The UI and CLI MUST render identifiers direction-isolated and MUST require operators to
confirm destructive actions by a checksum-truncated ID, not by transcription. A property
test MUST assert that no two accepted identifiers are confusable under a homoglyph, bidi, or
zero-width fold.
*Evidence: `validateIdValue` (`lib/opennode-domain/src/schemas.ts:304-308`) is only
`typeof value === "string" && value.trim().length > 0`, and `trim()` strips NBSP/BOM that
Postgres does not. Every DB text column is unbounded. `deriveNodeIdFromSecretKey`
(`lib/opennode-domain/src/identity.ts:92-98`) iterates UTF-16 code units via `charCodeAt`
rather than UTF-8 bytes, so NFC/NFD-equivalent strings hash differently and defeat
idempotency dedup. A homoglyph NodeId renders identically to the operator, which defeats the
typed-confirmation flow UX-04 mandates.*

**ENC-02 — Log and feed records MUST be structurally unforgeable.** Every value rendered
into a line-oriented log sink, audit detail, activity-feed message, or CLI output MUST pass
through a single `sanitizeForLog` filter replacing control characters, bidi overrides, and
ANSI/CSI escapes with escaped equivalents. Sinks MUST emit structured JSON, one record per
line, with no embedded newlines. Workload-derived text MUST be length-capped per record and
per run.
*Evidence: `lib/node-store/src/nodeStore.ts` interpolates user-supplied run names into
activity-feed messages, and `artifacts/api-server/bin/cli.ts` pads them into terminal rows —
a name containing a newline forges a second log record in any line-oriented aggregator.
Redaction does not catch this because the payload contains no secret pattern.*

**ENC-03 — Untrusted keys MUST be own-property lookups.** Every map keyed by a peer-,
message-, or request-supplied identifier MUST be a `Map`, or MUST be read with
`Object.hasOwn`; a lookup that resolves through the prototype chain MUST be treated as *not
found*. No verification, rate-limiting, nonce, or bucket path may throw a non-domain
exception for malformed input. A fuzz test MUST feed `__proto__`, `constructor`,
`prototype`, `toString`, empty, and oversized identifiers into every such lookup and assert a
typed error, never a `TypeError` and never a `500`.
*Evidence: `lib/sync-engine/src/signing.ts:31-33` guards with
`secrets[signerId] !== undefined` on a plain object literal, where `secrets["__proto__"]`
resolves to `Object.prototype` and passes the guard. `signerId` arrives from an untrusted
received entry at `lib/sync-engine/src/eventLog.ts:109`.*

**ENC-04 — Ordering that feeds a digest or cursor MUST be locale-independent.** Any
ordering contributing to a hash, Merkle root, canonical encoding, or pagination cursor MUST
use byte/code-unit comparison and MUST NOT use `localeCompare`, `Intl.Collator`, or
`toLocale*`. A CI matrix job MUST assert identical digests for identical input across at
least two locales.
*Evidence: `lib/gossip/src/rumorSet.ts:126` sorts with `localeCompare` **before** computing
`setHash`, so two healthy nodes with different ICU collation compute different hashes for
identical rumor state and anti-entropy reports a permanent unresolvable difference.*

## TIME — Clock and time semantics

**TIME-01 — Scheduling, throttling, and expiry MUST use a monotonic clock.** Rate-limit
windows, anti-entropy scheduling, lease/attempt expiry, credential expiry, retention
deadlines, and alert windows MUST be computed from an injected monotonic clock. A backward
step MUST NOT reset or extend any allowance; a forward step MUST NOT trigger a bulk mutation.
Each sweeper MUST enforce a per-sweep deletion/fencing budget and MUST alert before exceeding
it. A node MUST detect a wall-clock discontinuity beyond a documented threshold, mark itself
`clock_unstable`, and refuse new lease acquisition until resynchronised.
*Evidence: a backward clock step makes the rate-limit window miss and **refill** the bucket;
anti-entropy's `isDue` returns false until the wall clock catches up, silently stalling
repair; a single forward NTP step past every `expiresAt` fences **every** active lease and
expires **every** retained object at once.*

**TIME-02 — Reconciliation MUST NOT accept caller-supplied time.** Any reconcile entry point
MUST derive its clock from a trusted internal source and MUST NOT accept `now` from a request
body. See RUN-08.

**TIME-03 — Rendered time MUST be unambiguous and server-anchored.** Every API response
carrying a timestamp MUST also carry the server's `now` and UTC offset so clients can
compute skew. The UI MUST render operator-facing timestamps with an explicit zone and MUST
NOT rely on the implicit browser locale/timezone. Expiry, staleness, and "is it still open"
MUST be derived from server-supplied values plus measured skew, never from a client clock.
*Evidence: `artifacts/opennode/src/App.tsx` renders via `toLocaleString(undefined, …)` and
`toLocaleTimeString()`, and decides proposal expiry with a client-side `Date.now()`
comparison — a workstation five minutes fast disables voting on a proposal the server would
still accept.*

## LIFE — Process lifecycle

**LIFE-01 — Startup MUST validate configuration before serving.** All configuration MUST be
read through one versioned, schema-validated module that rejects unknown keys and **fails
startup** on a missing or documented-insecure default (signing key, cluster ID, database URL,
bootstrap addresses, allowlists). A `doctor`/`check-config` command MUST validate without
opening a listener. `/healthz` MUST expose the config schema version and a redacted config
fingerprint. Required environment variables MUST be documented and enforced — `PORT` is
currently mandatory and throws at startup, and `DATABASE_URL` is mandatory in
`lib/db/src/index.ts`, and neither is documented as required together.

**LIFE-02 — Shutdown MUST be graceful.** On `SIGTERM`/`SIGINT` the process MUST stop
accepting new work, fail readiness, drain in-flight requests and active attempts to a bounded
deadline, durably flush the run ledger, lease registry, and pending audit records, then exit
zero; exceeding the deadline MUST exit non-zero with an explicit reason. Bind failures MUST
exit with a clear error rather than an unhandled event. A test MUST assert that a `SIGTERM`
mid-run leaves state recoverable.
*Evidence: `.replit` sets `deploymentTarget = "autoscale"`, a platform that terminates
instances with `SIGTERM`, and `artifacts/api-server/src/index.ts` registers no signal
handler and no `server.on("error")`.*

## PROV — Protocol, retries, and test depth

**PROV-01 — Every network call MUST declare its retry policy.** Every outbound call MUST
declare an operation class (`read` / `idempotent-write` / `non-idempotent-write`), a total
attempt budget with exponential backoff and full jitter, a per-attempt deadline, and a
terminal error. A non-idempotent write MUST NOT be retried without its original
`Idempotency-Key`. `429`/`503` MUST honour `Retry-After`. A timed-out operation MUST cancel
its underlying work rather than abandon it. Truncation/abandonment reasons MUST be preserved
and surfaced, never discarded.
*Evidence: `lib/content-store/src/stream.ts` `truncate(reason)` discards its reason, so a
caller cannot distinguish an operator truncation from a limit breach or a retryable from a
fatal condition.*

**PROV-02 — Testing MUST include property, concurrency, and fuzz layers.** Property-based
tests MUST cover the canonicalizer/hash layer, threshold arithmetic with golden vectors for
N=1..20, every signed-encoding constructor's injectivity, and identifier grammar acceptance.
Concurrency tests MUST run at least 8 interleaved writers against each commit path
(`submit`, `acquireLease`, `retry`, `cancel`, `observeAttempt`, `reconcile`,
`commitAdmission`, `appendLog`, catch-up vs local append) and assert exactly one committed
effect. Every external deserializer (backup, chunk metadata, cursor, digest, peer entry) MUST
validate against a schema and MUST be fuzzed with malformed, oversized, duplicate-key, and
adversarial-Unicode input. Model-based differential tests MUST assert a replayed log produces
the same projection as an incremental one. No deserializer of external data may use a bare
cast, and applying an unrecognized event kind MUST be a typed rejection rather than a silent
`break`. See CONC-01 for the concrete defect this would catch.

---

## Additional closures from the adversarial review

These were surfaced by a verification pass over the first draft of this document and
are not covered by any requirement above.

**GOV-22 — Node identity must never fall back to a constant.** `getLocalNodeId()`
(`lib/node-store/src/nodeStore.ts:323-325`) returns `rows[0]?.nodeId ?? "local"`, and
the `local_node_identity` table has **no write path in normal operation** —
`insertLocalNodeIdentitySchema` and `ensureNodeIdentity`/`assertNoNodeIdCollision` have
zero call sites, and no migrations ship. Every node's **membership and lease identity** is
therefore the literal string `"local"`, which seeds `memberIds`, `MembershipService`
initial members, the sole `capabilities` entry, the `run.submitted` `submitterNodeId`, and
consequently the `deriveRunId` preimage. Two independent nodes cannot be distinguished in
any membership or lease record. *Note this does not affect log signing: `signerNodeId` is
derived from the secret key, so the log identity and the node identity are different
values, and that divergence is itself a defect.* See NET-02.

**RUN-21 — Worker results must reach committed state.** `RunCoordinator.observeAttempt`
(`lib/run-coordinator/src/coordinator.ts:600`) is the sole emitter of
`RUN_ATTEMPT_OBSERVED_KIND` and has **zero call sites**. The wired provider discards the
`AttemptRecord` returned by `WorkerRuntime.submit`
(`lib/worker-runtime/src/executionProvider.ts:37-39`) and the server's `onEvent` handler only
`console.log`s; `FakeExecutionProvider`, the sole implementation that reaches
`markRunTerminal`, is never instantiated. Consequence: **no run can ever reach `succeeded`
or `failed` through execution.** Every dispatched run is frozen at `scheduled` in the
committed log and `queued` in `workload_runs`, `attemptCount` stays 0, no attempt rows are
written, and `retry` returns `RUN_NOT_RETRYABLE` because the run is neither `failed` nor
`queued`. Because `submit` counts `scheduled` runs against the concurrency limit, the
service **permanently rejects the 9th and every subsequent submission** with HTTP 429;
the only escape is per-run cancel. See EXEC-15, RUN-13.

**RUN-22 — Set comparison MUST be injective.** Any comparison of a committed identifier set
(membership, electorate, replica set) MUST use a canonical, injective encoding —
length-prefixed serialization or `JSON.stringify` of the sorted array — and MUST NOT use
bare `Array.prototype.join("")`. A CI check MUST fail on `.join("")` in a comparison or
digest. *Evidence: `MembershipService.reconcile()`
(`lib/opennode-domain/src/membership-service.ts:533`) compares with `join("")`, so
`["ab","c"]` and `["a","bc"]` — and `["abc"]` and `["a","b","c"]` — compare equal, and a
false match silently returns the local member set instead of raising a divergence. Two
mitigating facts: the method has no callers, and deployed NodeIds are fixed-length hex for
which concatenation happens to be injective. It is latent, not live — but it becomes live
the moment an unconstrained `targetNodeId` is admitted and `reconcile` is wired per SYNC-10.*
Contrast `lib/membership-log/src/core.ts:393-394`, which uses `join("\u001f")` correctly.

**PROV-03 — An unused mechanism is not a control.** A security mechanism MUST be reachable
from the deployed code path that depends on it. Every function, guard, or verifier that a
requirement relies on MUST have at least one non-test call site, and CI MUST fail when a
symbol named by a requirement has zero callers.
*This is the single most common failure mode in this codebase and deserves its own rule.
Verified instances: `runCatchUp`, `MembershipService.reconcile`, `MembershipLog.reconcilePeer`,
`authorizePeerAccess`, `isQuarantined`, `isRevoked`, `fenceOnMembershipChange`,
`issueMembershipCredential`, `ensureNodeIdentity`, `assertNoNodeIdCollision`,
`isCommittedLeaseUsable`, `compareFencingTokens`, `isFreshFencingToken`,
`LeaseRegistry.get`/`list`, `ChunkStore.delete`, `createNonceCache`, `createDefaultHarness`,
`registerAllFaultPoints`, `setFeatureFlagsInstance`, `Libp2pPeerTransport`, and
`WorkerExecutionProvider`'s result — plus the entire `observability` and `failure-injection`
packages, which are not even declared as dependencies of the server. A correct mechanism
that nothing calls provides exactly zero protection while reading as a control.*
