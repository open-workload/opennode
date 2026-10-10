# OpenNode

**Enterprise-grade decentralized cluster for running untrusted containerized workloads.**

OpenNode is a peer-to-peer compute platform with **no central controller, no shared
database, and no single scheduler**. Every independently deployed installation is a
*peer node*: it carries its own persistent identity, its own durable local state, its
own UI/API, its own peer networking, and — optionally — its own execution capacity.
Nodes exchange authenticated events and reach cluster decisions through a replicated
consensus log. Governance (who may join, who must leave) is decided by frozen-electorate
votes; work is committed first and scheduled second, under exclusive, renewable,
fenceable leases.

> **Status: planning and partial implementation.** This is an honest, evidence-first
> project. A ten-domain adversarial review found that many earlier "complete" claims
> were based on source-code reading rather than executable evidence, and the documents
> were corrected. **All five release gates are currently NOT MET.** Before you rely on
> any capability claim, read [`docs/release-gates.md`](docs/release-gates.md) and
> [`todo.md`](todo.md). The single most important rule in this repository:
>
> > **An unused mechanism is not a control.** A correct function that nothing calls
> > provides exactly zero protection while reading as a control. — `PROV-03`

---

## Table of contents

1. [Why OpenNode exists](#why-opennode-exists)
2. [How to think about OpenNode (the mental model)](#how-to-think-about-opennode-the-mental-model)
3. [Status: what is real today](#status-what-is-real-today)
4. [Architecture at a glance](#architecture-at-a-glance)
5. [Repository layout](#repository-layout)
6. [Module map (`lib/`)](#module-map-lib)
7. [Tech stack](#tech-stack)
8. [Quick start](#quick-start)
9. [Command reference](#command-reference)
10. [Environment and configuration](#environment-and-configuration)
11. [Testing and verification](#testing-and-verification)
12. [The requirement vocabulary (GOV-01 … PROV-03)](#the-requirement-vocabulary)
13. [Known gaps and gotchas](#known-gaps-and-gotchas)
14. [Roadmap: closure order](#roadmap-closure-order)
15. [Documentation index](#documentation-index)
16. [Contributing conventions](#contributing-conventions)
17. [Glossary](#glossary)

---

## Why OpenNode exists

Running untrusted code — arbitrary containers submitted by users — is a safety and
security problem first, a scheduling problem second. Most platforms solve it by
centralizing: one control plane, one database, one scheduler, one trust domain. That
model has a single point of failure, a single point of compromise, and a hard ceiling
on how much of the platform any one tenant must trust.

OpenNode inverts the model:

- **Every node is a peer.** There is no "leader" installation that owns the cluster.
  A cluster is a set of mutually authenticated peers that agree on a shared history.
- **Agreement is replicated, not centralized.** Membership changes, leases, and run
  state are committed to a consensus log that every peer replays. The local database
  is a *mirror*, never the source of truth.
- **Membership is permissioned and governed.** New nodes need approval from admitted
  peers. Admission and eviction are decided by votes over a frozen electorate, so a
  later join or leave cannot retroactively change the threshold a proposal needed.
- **Work is committed before it is scheduled.** A run is durably recorded first; a
  scheduler reacts to committed state and grants exactly one exclusive lease. This is
  what makes client retries safe: replaying a submission cannot create a second run.
- **Execution is isolated and fenced.** Workloads run in disposable isolation
  boundaries (rootless user namespaces today, OCI runtimes as the target), with
  limits enforced by the isolation mechanism itself — not by in-process bookkeeping.
  Leases carry fencing tokens so a stale or partitioned worker can be stopped, not
  just "marked".

The design intent is documented as normative requirements in `todo.md` (204 numbered
requirements across 16 families) and the architecture decisions are recorded in
[`docs/selections.md`](docs/selections.md).

---

## How to think about OpenNode (the mental model)

A few frames that make the rest of this document — and the codebase — coherent:

### 1. The committed log is the truth; everything else is a projection

Each node keeps a hash-linked, signed, append-only event log. Membership decisions,
run submissions, lease grants, attempt observations, and cancellations are *events*.
The database tables, the UI, and the API responses are *derived read models* that can
be rebuilt by replaying the log. If a table and the log disagree, the log wins.

This is why `todo.md` insists on things like *"commit before effect, with rollback"*
(`GOV-13`) and *"the API must expose committed state"* (`RUN-20`): a system whose
authoritative state lives in process memory cannot survive a restart, and a system
whose API reads a mirror can lie about what the cluster actually agreed to.

### 2. One deep module per domain; UI/API/CLI are thin clients

Threshold math, state machines, and authorization decisions live in the domain core
(`lib/opennode-domain`). The API, CLI, and web client must not restate them. When the
UI re-implements the admission threshold formula client-side, or the API derives a
vote tally from a route-local map, the system has two implementations that will
inevitably diverge (`GOV-01`). The rule: **exactly one implementation, and it lives in
the domain.**

### 3. Submit before you schedule; fence before you trust

A run is committed, then leased, then executed. The lease is renewable, expires, and
carries a fencing token that the worker must re-validate before every state advance.
Fencing that only updates a database row while the container keeps running is the
duplicate-execution hole (`RUN-04`). Retries are **at-least-once** by design — the
system must detect and surface duplicates, not pretend they cannot happen.

### 4. A proposal is data, not a count

A governance proposal freezes its electorate at open time. The committed decision
event carries the denominator, the threshold, and the counted yes-voter NodeIds, so
every peer can independently re-verify the outcome on replay (`GOV-02`, `SYNC-09`).
Ballots are signed, bound to a proposal ID, cluster ID, voter, epoch, choice, and
expiry, and are replicated — a node must never finalize a proposal from only its own
local ballot (`GOV-17`).

### 5. Evidence beats assertion

Completion claims require a **named, runnable test or CI job**, the command to
reproduce it, and the commit SHA at which it passed. Source-code reading is not
evidence. This rule is what turned the project's documentation from optimistic prose
into a gap register — and it is why the release gates are honestly marked **NOT MET**
today.

---

## Status: what is real today

Verified against the working tree on **2026-10-10** (HEAD `9fa733c`):

| Signal | Value |
|---|---|
| Release gates | **All 5 NOT MET** ([`docs/release-gates.md`](docs/release-gates.md)) |
| Threat model | 8 threat classes, 63 claimed mitigations, **4 verified** (structural invariants only — no runtime control deployed) ([`docs/threat-model.md`](docs/threat-model.md)) |
| Peer-network selection | **NOT SELECTED** — libp2p adapter written but never instantiated ([`docs/selections.md`](docs/selections.md)) |
| Consensus selection | **NOT SELECTED** — shipped log is a bespoke single-writer append, not a proven engine (`SYNC-01`) |
| Replit as full node | **Unsupported** — Replit is UI/client only; 8/16 feasibility tests failed ([`docs/replit-deployment.md`](docs/replit-deployment.md)) |
| Tests | **333 tests in 30 files, all passing** (`pnpm test`) |
| Typecheck | **Passing** (`pnpm run typecheck`) |
| CI | `.github/workflows/ci.yml`: install → typecheck → test → `check:ci` |
| Requirements | 204 numbered IDs across 16 families in `todo.md` (its own index line says 176 — stale) |
| Rootless execution | **Implemented and verified in-repo** — `userns` + `udocker` backends ([`docs/rootless-containers.md`](docs/rootless-containers.md)) |

What this means in plain terms:

- The **scaffolding is real and green**: a working Express API, a React web client, a
  Drizzle/Postgres schema, a domain core with unit tests, a rootless execution
  backend with tests, and a CI pipeline that runs typecheck, 333 tests, and static
  guards.
- The **distributed core is not yet real**: there is no wired production peer
  transport, no proven consensus engine, no durable committed log, and no
  authorization model. Most security mechanisms exist as code with **zero call
  sites** — the dominant failure mode in this codebase (`PROV-03`).
- The **documents are the honest record**. `todo.md` uses a strict verification
  legend (`[x]` = implemented *and* covered by a named runnable test, `[~]` = code
  exists but unproven, `[ ]` = not implemented). Read the legend before trusting a
  checkbox.

---

## Architecture at a glance

```
                        ┌────────────────────────────────────────────┐
                        │                 Peer node                   │
                        │                                            │
  ┌──────────┐          │  ┌──────────┐   ┌───────────────────────┐  │
  │ Web UI   │──────────┼─▶│ Local API│──▶│   Domain core         │  │
  │ (React)  │          │  │ (Express)│   │  (pure rules: GOV,    │  │
  └──────────┘          │  └──────────┘   │   RUN, EXEC, SEC, …)  │  │
  ┌──────────┐          │        │        └───────────┬───────────┘  │
  │ CLI      │──────────┼────────┘                    │              │
  └──────────┘          │                             ▼              │
                        │  ┌──────────────────────────────────────┐  │
                        │  │  Run coordinator (leases, fencing,   │  │
                        │  │  quotas, candidate selection)        │  │
                        │  └───────┬──────────────┬───────────────┘  │
                        │          ▼              ▼                  │
                        │  ┌──────────────┐  ┌──────────────────┐   │
                        │  │ Sync engine  │  │ Execution        │   │
                        │  │ (log, snap-  │  │ provider →       │   │
                        │  │  shots,      │  │ isolated worker  │   │
                        │  │  catch-up)   │  │ (userns/udocker) │   │
                        │  └──────┬───────┘  └──────┬───────────┘   │
                        │         │                 │               │
                        │  ┌──────▼───────┐  ┌──────▼───────────┐   │
                        │  │ Cluster log  │  │ Secret broker +  │   │
                        │  │ (consensus   │  │ content store    │   │
                        │  │  adapter)    │  │ (encrypted,      │   │
                        │  └──────┬───────┘  │  content-addressed│  │
                        │         │          └──────────────────┘   │
                        │  ┌──────▼───────┐                         │
                        │  │ Peer network │  ◀── authenticated,     │
                        │  │ (libp2p,     │      signed, versioned  │
                        │  │  gossip,     │      peer streams       │
                        │  │  relay)      │                         │
                        │  └──────────────┘                         │
                        └────────────────────────────────────────────┘
```

The **deep-module rule** (from `todo.md`): callers depend on small stable interfaces,
not on storage, transport, consensus, or runtime internals. Peer-protocol and
provider-specific types never leak into the domain core. Every boundary input is
validated.

---

## Repository layout

```
.
├── todo.md                  # THE requirements document — 204 IDs, source of truth
├── replit.md                # Replit-specific run/operate notes (partly stale — see §13)
├── README.md                # this file
├── docs/                    # release gates, threat model, selections, SLOs, runbooks…
├── lib/                     # 19 workspace packages (the domain + infrastructure)
│   ├── opennode-domain/     #   pure domain rules (governance, runs, identity, audit)
│   ├── sync-engine/         #   signed event log, merkle hashing, snapshots, catch-up
│   ├── raft-log/            #   Raft consensus node (in-memory storage only today)
│   ├── membership-log/      #   committed membership state machine + leases
│   ├── peernet/             #   peer transport, handshake, certs/CRL, signatures
│   ├── gossip/              #   advisory presence/capacity gossip + anti-entropy
│   ├── run-coordinator/     #   run lifecycle, leases, fencing, quotas, scheduling
│   ├── worker-runtime/      #   isolation backends (userns, udocker), cgroups, OCI
│   ├── secret-broker/       #   scoped, expiring, audited secret issuing
│   ├── content-store/       #   encrypted content-addressed chunk storage
│   ├── node-store/          #   Drizzle persistence, identity keystore, backups
│   ├── db/                  #   Postgres schema + Drizzle client (14 tables)
│   ├── node-lifecycle/      #   leave/eviction drain, revocation, retention
│   ├── feature-flags/       #   flag registry + kill switch
│   ├── failure-injection/   #   deterministic fault injection harness
│   ├── observability/       #   metrics, health checks, log correlation, alert rules
│   ├── api-spec/            #   OpenAPI source of truth + Orval codegen
│   ├── api-zod/             #   generated request/response validators
│   └── api-client-react/    #   generated React Query client
├── artifacts/
│   ├── api-server/          # Express 5 HTTP API (routes, auth, runtime wiring)
│   ├── opennode/            # Vite 7 + React 19 operator web console
│   └── mockup-sandbox/      # UI mockup preview scaffold (empty)
├── scripts/                 # dev/ops tooling: CI guards, feasibility, rootless install
├── .github/workflows/ci.yml # install → typecheck → test → check:ci
├── .replit                  # Replit deployment config (autoscale — see §13)
├── pnpm-workspace.yaml      # workspace globs + version catalog
├── vitest.config.ts         # root test runner config
└── tsconfig.json            # project references (18 libs)
```

---

## Module map (`lib/`)

All packages are `@workspace/<name>`, private, ESM, TypeScript sources exported
directly (no per-package build step). Only `opennode-domain` defines its own test
scripts; everything else is tested through the root Vitest config.

| Package | Responsibility | Notable exports | Honest caveats |
|---|---|---|---|
| `opennode-domain` | Pure domain rules: schemas, governance voting, run/attempt state machines, identity derivation, idempotency, audit redaction, membership service | `MembershipService`, `admissionThreshold`/`evictionThreshold`, `createRun`/`transitionRun`, `deriveNodeIdFromSecretKey`, `redactSecrets` | `reconcile()` compares sets with `join("")` (`RUN-22`); `getLocalNodeId()` falls back to `"local"` (`GOV-22`) |
| `sync-engine` | Signed append-only event log, merkle roots, snapshots, catch-up/divergence | `EventLog`, `merkleRoot`, `createClusterSnapshot`, `runCatchUp` | `runCatchUp` has zero call sites; snapshots carry no state and no quorum approval (`SYNC-05…07`) |
| `raft-log` | Raft consensus node for membership replication | `RaftNode`, `RaftEventLogStore` | **In-memory storage only** — `dataDir` is ignored; no durable backend |
| `membership-log` | Committed membership state machine, leases, peer sync | `MembershipLog`, `LeaseRegistry`, `syncMembershipFromPeer` | Leases accumulate without eviction (`CONC-04`); in-memory stores |
| `peernet` | Peer transport, handshake, replay protection, membership certs/CRL, ed25519 | `PeerTransport`, `createHandshake`, `issueMembershipCertificate`, `authorizePeerAccess` | Only `InMemoryPeerTransport` is reachable; `discoverPeers` is a stub; deterministic signature verifier always returns `true` |
| `gossip` | Advisory presence/capacity gossip, rumor sets, anti-entropy, read-model projections | `RumorSet`, `AntiEntropyScheduler`, `ReadModelProjector` | `rumorSet.ts` sorts with `localeCompare` before hashing (`ENC-04`); messages unsigned |
| `run-coordinator` | Run lifecycle, leases/fencing, quotas, candidate selection, event sourcing | `RunCoordinator` (`submit`, `acquireLease`, `observeAttempt`, `reconcile`), `deriveRunId` | `observeAttempt` has zero call sites — **no run can reach a terminal state** (`RUN-21`); lease TTL 30 s vs 24 h max (`RUN-03`) |
| `worker-runtime` | Isolation backends, spec/policy validation, cgroups, nftables, OCI pull, secret/content clients | `WorkerRuntime`, `RootlessBackend`, `IsolatedProcessBackend`, `CgroupManager`, `validateWorkerSpec` | `IsolatedProcessBackend` is a `*_stub`; rootless `userns`/`udocker` are implemented and tested |
| `secret-broker` | Scoped, expiring, audited secret issuing | `createSecretBroker`, `SecretBrokerClient` | Broker unreachable from the run path — `secretRefs` hardcoded `[]` (`SEC-01`) |
| `content-store` | Encrypted content-addressed chunk storage, streaming, retention | `createChunker`, `createBoundedStream`, `pruneExpiredChunks` | `StubEncryptor` (`stub-xor`) exists alongside AES-GCM; never imported by the server |
| `node-store` | Drizzle persistence, identity keystore, backups, diagnostic provider | `DrizzleNodeStore`, `NodeStoreIdentityKeystore`, `backupToFile`/`restoreFromFile` | Backups render every `Date` as `{}` (`DATA-03`); restore deletes the audit trail (`DATA-04`) |
| `db` | Postgres schema + Drizzle client | 14 tables, enums, `insert*Schema` validators | No committed migrations — `push` is destructive (`DATA-01`) |
| `node-lifecycle` | Leave/eviction drain, credential revocation, lease invalidation, retention | `NodeLifecycleController` | Drain is simulated; revocation sets have zero readers (`GOV-14/15`) |
| `feature-flags` | Flag registry, evaluation, kill switch | `FeatureFlags`, `KillSwitch` | Two disjoint instances — flag endpoints mutate one the coordinator never reads (`CFG-01`) |
| `failure-injection` | Deterministic fault injection harness | `FailureInjector`, `registerAllFaultPoints` | `inject()` silently passes through 4 fault types, `injectSync()` 6 (`OPS-20`) |
| `observability` | Metrics registry, health checks, log correlation, alert rules | `MetricsRegistry`, `HealthCheckRegistry`, `createDefaultAlertRules` | No metric has a producing call site; exporter is a no-op (`OPS-03`) |
| `api-spec` | OpenAPI source of truth + Orval codegen | `openapi.yaml` (24 paths) | `GET /api/peer-status` declared but not implemented; `GET /api/metrics` implemented but not declared (`API-08`) |
| `api-zod` | Generated request/response validators | Orval output | — |
| `api-client-react` | Generated React Query client | hooks + typed fns | — |

---

## Tech stack

| Layer | Choice |
|---|---|
| Package manager | pnpm workspaces (catalog versions, `preinstall` enforces pnpm) |
| Runtime | Node.js 24 |
| Language | TypeScript 5.9 (strict, project references) |
| API | Express 5, pino logging, Clerk auth (`@clerk/express`), helmet, CORS |
| Database | PostgreSQL 16 + Drizzle ORM (14 tables, drizzle-zod validators) |
| Validation | Zod (v3 catalog) + generated `api-zod` schemas |
| API codegen | Orval from `lib/api-spec/openapi.yaml` |
| Web client | Vite 7, React 19, Tailwind v4, wouter, TanStack Query, Clerk, shadcn/ui |
| Build | esbuild (CJS bundle for api-server), Vite for the web client |
| Tests | Vitest 5 (root config, 30 files / 333 tests) |
| Crypto | `@noble/ed25519`, `@noble/hashes`, `jose` |
| Execution | Rootless `userns` (unshare + chroot) and `udocker` (PRoot) backends |

---

## Quick start

### Prerequisites

- Node.js 24 and pnpm 10 (`corepack enable` or install pnpm directly).
- PostgreSQL 16 with a reachable `DATABASE_URL`.
- A Clerk application (publishable key + proxy URL) for the web client and API auth.

### Install

```bash
pnpm install          # preinstall hook refuses non-pnpm package managers
```

### Run the API server

```bash
export PORT=8080
export DATABASE_URL=postgres://user:pass@localhost:5432/opennode
pnpm --filter @workspace/api-server run dev   # build + start
```

`PORT` is mandatory — the process throws at startup without it. `DATABASE_URL` is
mandatory in `@workspace/db`. There is no default port.

### Run the web client

```bash
export PORT=8080
export BASE_PATH=/
export VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
export VITE_CLERK_PROXY_URL=/api/__clerk
pnpm --filter @workspace/opennode run dev
```

The web client throws at startup if the Clerk publishable key is missing.

### Run the tests and gates

```bash
pnpm run typecheck    # tsc --build + per-package checks
pnpm test             # vitest run — 333 tests in 30 files
pnpm run check:ci     # static guards: PROV-03, RUN-22, OPS-20
```

### Regenerate API clients after editing the OpenAPI spec

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Database schema (development only)

```bash
pnpm --filter @workspace/db run push
```

> ⚠️ **Never run `push` against a node's durable store.** No committed migrations
> exist; `push` applies the schema destructively (`DATA-01`). It is for ephemeral
> local development databases only.

### Replit

OpenNode is **UI/client only** on Replit (`.replit` uses `deploymentTarget =
"autoscale"`, which is incompatible with durable peer streams and stable identity —
see [`docs/replit-deployment.md`](docs/replit-deployment.md)). Ports: `8080→80`,
`8081→3000`, `20557→3001`.

---

## Command reference

| Command | What it does |
|---|---|
| `pnpm install` | Install (pnpm enforced by `preinstall`) |
| `pnpm run typecheck` | `tsc --build` (18 libs) + `--if-present` per-package checks (api-server, opennode, mockup-sandbox, scripts) |
| `pnpm test` | Root Vitest run — 333 tests / 30 files |
| `pnpm run check:ci` | Static guards: unused-symbols (PROV-03), join-encoding (RUN-22), fault-injection pass-through (OPS-20) |
| `pnpm run build` | Typecheck + build all packages |
| `pnpm run coverage` | Per-lib coverage (only `opennode-domain` defines it) |
| `pnpm --filter @workspace/api-server run dev` | Build + start the API server |
| `pnpm --filter @workspace/api-server run start` | Start the built API server (`dist/index.mjs`) |
| `pnpm --filter @workspace/api-server run cli` | Run the CLI (`tsx ./bin/cli.ts`) |
| `pnpm --filter @workspace/opennode run dev` | Vite dev server for the web client |
| `pnpm --filter @workspace/api-spec run codegen` | Regenerate `api-client-react` + `api-zod` from `openapi.yaml` |
| `pnpm --filter @workspace/db run push` | **Dev only** — destructive schema push |
| `pnpm --filter @workspace/scripts run replit-feasibility` | Replit platform feasibility probes |
| `pnpm --filter @workspace/scripts run rootless:install` | Install rootless runtime (busybox rootfs + udocker) under `.local/rootless/` |
| `pnpm --filter @workspace/scripts run check:ci` | The CI guard runner directly |

---

## Environment and configuration

| Variable | Required by | Notes |
|---|---|---|
| `PORT` | api-server | Mandatory; throws at startup without it. Replit sets `8080` |
| `DATABASE_URL` | `@workspace/db` | Mandatory; `lib/db/src/index.ts` throws if unset |
| `BASE_PATH` | web client | Required by `vite.config.ts` |
| `VITE_CLERK_PUBLISHABLE_KEY` | web client | Throws at startup if missing |
| `VITE_CLERK_PROXY_URL` | web client | Mirrors the server's `/api/__clerk` proxy |
| `OPENNODE_KEYSTORE_PATH` | node-store | Identity keystore path (default `<base>/.local/opennode/node-identity.json`, mode 0600) |
| `OPENNODE_EXECUTION_BACKEND` | worker-runtime | **Proposed, not wired** — selector for `userns`/`udocker` |
| `OPENNODE_LOCAL_SECRET_KEY` | — | **Do not set.** Falls back to the published literal `"opennode-local-dev-secret"`, from which any party's NodeId is computable and any signature forgeable (`NET-02`) |

---

## Testing and verification

### The three gates

1. **`pnpm run typecheck`** — `tsc --build` over the 18-project reference graph, then
   per-package `--noEmit` checks for the four artifact/script projects.
2. **`pnpm test`** — root Vitest (config in `vitest.config.ts`): globs
   `lib/*/src/**/*.test.ts`, `artifacts/*/src/**/*.test.ts`, `scripts/**/*.test.ts`.
   Currently **333 tests in 30 files, all passing**.
3. **`pnpm run check:ci`** — repository static guards in `scripts/src/ci-checks/`:
   - `unused-symbols.ts` — **PROV-03**: every requirement-named security symbol must
     have a non-test call site, or CI fails.
   - `join-encoding.ts` — **RUN-22**: bare `Array.prototype.join("")` in set
     comparisons/digests fails CI.
   - `fault-injection.ts` — **OPS-20**: fault points must be wired; injector
     pass-through is detected.

CI (`.github/workflows/ci.yml`) runs all three on every push/PR to `main`.

### The evidence rule

> A gate may be marked **VERIFIED** only when it names the automated test or CI job
> that proves it, the command to reproduce it, and the commit SHA at which it passed.
> A gate without an executable evidence artifact is **UNVERIFIED** and blocks release.

`console.assert` is not a test assertion mechanism. The standalone smoke test
(`scripts/src/smoke-test.ts`) still uses it and is explicitly **not** release
evidence.

---

## The requirement vocabulary

`todo.md` is the shared vocabulary across every document. Requirement IDs are cited
rather than restating rules. There are **204 numbered requirements in 16 families**
(the count in `todo.md`'s own index — 176 — is stale):

| Family | Count | Covers |
|---|---|---|
| `GOV` | 22 | Membership governance: proposals, frozen electorates, ballots, thresholds, leave/eviction, genesis |
| `NET` | 17 | Peer network: transport, handshake, certificates/CRL, gossip, relay, rate limiting |
| `SYNC` | 18 | Consensus log, snapshots, catch-up, reconciliation, canonical hashing, schema versioning |
| `RUN` | 22 | Run coordination: commit-before-schedule, leases, fencing, quotas, retries, cancellation |
| `EXEC` | 20 | Worker isolation: real boundaries, digest pinning, limits, egress, hardening, teardown |
| `SEC` | 17 | Secrets and content store: broker, expiry, revocation, redaction, encryption, retention |
| `API` | 15 | Contracts: authN/authZ, idempotency, rate limits, OpenAPI truth, error taxonomy, health |
| `DATA` | 16 | Schema, migrations, tenancy, backups, audit integrity, retention |
| `UX` | 17 | User experience: honest preflight, accessibility, log streaming, pagination, freshness |
| `OPS` | 20 | Observability, testing, CI, alerts, runbooks, on-call, supply chain, residency |
| `CONC` | 5 | Concurrency: atomic allocation, truncation vs writers, event-loop budget, bounded maps |
| `CFG` | 3 | Configuration authority: one instance, merge-not-reset, unknown-key rejection |
| `ENC` | 4 | Encoding: identifier grammar, log sanitization, own-property lookups, locale-free ordering |
| `TIME` | 3 | Clock semantics: monotonic clocks, no caller-supplied time, server-anchored rendering |
| `LIFE` | 2 | Process lifecycle: validate-before-serve, graceful shutdown |
| `PROV` | 3 | Protocol retries, test depth (property/concurrency/fuzz), unused-mechanism rule |

### The verification legend

- `[x]` — implemented **and** covered by a named, runnable test or CI job.
- `[~]` — code exists, but the requirement is not proven and/or is partially
  implemented.
- `[ ]` — not implemented.

### Open decisions (D1–D18)

`todo.md` records 18 open decisions (D1–D18) that block specific requirements — for
example whether a NO vote is a veto (`D2`), how the first member of an empty cluster
is established (`D4`), and which consensus engine backs the log (`D10`). These are
recorded as open, not assumed.

---

## Known gaps and gotchas

These are the traps that dominate this codebase. Most are documented as requirements;
the list below is the "read this before you trust anything" summary.

1. **An unused mechanism is not a control (`PROV-03`).** `runCatchUp`,
   `authorizePeerAccess`, `ensureNodeIdentity`, `observeAttempt`, the entire
   `observability` and `failure-injection` packages, and ~20 other security functions
   have zero call sites. Correct code that nothing invokes provides zero protection.
2. **No run ever terminates (`RUN-21`).** `observeAttempt` has no callers, so runs
   freeze at `scheduled` and the 9th submission is rejected with 429 permanently.
3. **Every node's identity is the string `"local"` (`GOV-22`).** The identity table
   has no write path, so membership, leases, and run identity collide across nodes.
4. **State does not survive restart (`SYNC-01`, `RUN-13`).** Consensus log, run
   ledger, membership, and governance state are in-memory.
5. **Two disjoint `FeatureFlags` instances (`CFG-01`).** The kill switch and flag
   endpoints mutate an instance the run coordinator never reads — they have no effect
   on execution.
6. **Lease TTL is 30 s while max duration is 24 h (`RUN-03`).** No renewal exists, so
   every run over 30 s is fenced and re-executed.
7. **Backups destroy every timestamp (`DATA-03`)** (`stableStringify` renders `Date`
   as `{}`) and **restore deletes the audit trail** plus the node's identity
   (`DATA-04`).
8. **No enforcement anywhere (`EXEC-03`).** Resource limits, quotas, rate limits, and
   retention are declared and typed but not applied — with one exception, the
   wall-clock timer.
9. **`.replit` uses `deploymentTarget = "autoscale"`**, incompatible with durable
   inbound peer streams, a stable public identity, and graceful shutdown (`LIFE-02`).
10. **`GET /api/peer-status` is declared but not implemented** (the CLI's
    `peer-status` command 404s), and **`GET /api/metrics` is implemented but absent
    from the OpenAPI spec** (`API-08`).
11. **`scripts/post-merge.sh` runs `pnpm --filter db push`** — the filter does not
    match `@workspace/db`, so the post-merge hook is inert (and would be destructive
    if fixed).
12. **The mockup sandbox is empty** — `artifacts/mockup-sandbox/src/components/mockups/`
    has no files; it is a scaffold only.

---

## Roadmap: closure order

`todo.md` sequences the work so each stage unblocks the next:

| Stage | Requirements | Why it goes here |
|---|---|---|
| 1. Signatures and identity | `NET-01`, `NET-02`, `SYNC-13` | Production signing is forgeable from a public NodeId; nothing downstream is meaningful until signatures are real |
| 2. Authentication and authorization | `API-01`, `API-02` | Clerk auth exists; role/tenant authorization is missing |
| 3. Durable state | `SYNC-01`, `SYNC-04`, `RUN-13` | Governance, membership, and coordinator state are in-memory |
| 4. Evidence pipeline | `OPS-01`, `OPS-02`, `OPS-03` | Root Vitest + CI exist; distributed integration evidence, release enforcement, and metrics emission remain open |
| 5. Isolation | `EXEC-01`, `EXEC-03`, `EXEC-05`, `EXEC-06` | A real isolation boundary — the largest build |
| 6. Safety properties | `RUN-03`, `RUN-04`, `RUN-08`, `SYNC-06`, `SYNC-07`, `SEC-02` | Lease renewal, worker fencing, quorum, snapshot rollback defence |
| 7. Enterprise surface | `DATA-*`, `API-05…15`, `UX-*`, `OPS-09…18` | Tenancy, migrations, audit, UX, runbooks, compliance |

> **Fastest path to a truthful status:** Stage 4 alone. It converts every
> currently-false "verified" claim into real evidence.

---

## Documentation index

| Document | Purpose | Status |
|---|---|---|
| [`todo.md`](todo.md) | Requirements and the source of truth for every closure | 204 requirements |
| [`docs/release-gates.md`](docs/release-gates.md) | Release gate status and the evidence rule | All 5 **NOT MET** |
| [`docs/threat-model.md`](docs/threat-model.md) | 8 threat classes × 63 claimed mitigations | 4 verified |
| [`docs/selections.md`](docs/selections.md) | Peer-network and consensus selection rationale | Both **NOT SELECTED** |
| [`docs/replit-deployment.md`](docs/replit-deployment.md) | Deployment target assessment | Replit = UI/client only |
| [`docs/canary-deployment.md`](docs/canary-deployment.md) | Partition test scenarios | Blocked; scenarios preserved |
| [`docs/slos.md`](docs/slos.md) | 26 SLIs, 17 SLOs, alert→SLO mapping | None instrumented |
| [`docs/rootless-containers.md`](docs/rootless-containers.md) | Rootless execution (userns/udocker) | Implemented + verified in-repo |
| [`docs/runbooks/README.md`](docs/runbooks/README.md) | Required runbooks and template | 14 required, none written |
| [`replit.md`](replit.md) | Replit run/operate notes | Partly stale (see §13) |

---

## Contributing conventions

This repository has strong, written-down conventions. Read them before touching code:

- **Skills are procedural law.** `.opencode/skills/` carries the workflows:
  `branch-commit-pr-workflow` (branch per slice, commit style, PR + squash-merge),
  `github-issue-todo-tracking` (every todo mirrors a GitHub issue on the board),
  `opennode-evidence-pipeline` (the three verification gates), and
  `rootless-container-runtime` (execution backend operations).
- **Vertical slices, TDD, KISS.** Work lands as thin end-to-end slices, test-first
  (red → green → refactor), as simple as possible.
- **Ready-made modules win.** Reach for a library before hand-rolling; never
  hand-roll crypto, parsing, date math, HTTP plumbing, or concurrency primitives.
- **Branch → commit → PR.** `main` is not a working branch. Every slice lands through
  a short-lived branch and a squash-merged PR. Commit messages are imperative,
  sentence-case, no conventional-commit prefix (e.g. "Add peer clustering, rootless
  runtime, and verification pipeline").
- **Evidence in the PR body.** State the verification command and its actual output.
- **Requirement IDs everywhere.** Branch names, issue titles, and PR titles carry the
  `todo.md` ID they close.

---

## Glossary

| Term | Meaning |
|---|---|
| **Node / peer** | One independently deployed OpenNode installation with its own identity, state, UI/API, networking, and optional execution capacity |
| **Cluster** | A set of mutually authenticated peers sharing a committed history |
| **NodeId** | The public identity of a node, derived from its persistent signing key |
| **ClusterId** | The identity of the cluster a node belongs to |
| **Committed log** | The hash-linked, signed, append-only event log — the source of truth |
| **Read model / projection** | Derived state rebuilt by replaying committed events |
| **Membership epoch** | A monotonically increasing counter advanced by each committed membership change |
| **Frozen electorate** | The membership snapshot a proposal's threshold is computed against at open time |
| **Lease** | An exclusive, renewable, expiring grant to execute one attempt, carrying a fencing token |
| **Fencing token** | An opaque per-attempt value the worker must re-validate before advancing state |
| **Attempt** | One execution of a run (a run may have many attempts via retry) |
| **Preflight** | A non-mutating admission evaluation that must share logic with submit |
| **Isolation boundary** | The mechanism (userns, OCI runtime) that actually enforces workload limits |
| **Secret broker** | The scoped, expiring, audited channel that delivers job-scoped secrets to workers |
| **Content store** | Encrypted, content-addressed, retention-aware chunk storage for logs/artifacts |
| **Requirement ID** | A normative `MUST`/`SHOULD` statement in `todo.md` (e.g. `PROV-03`) |

---

## License

MIT. See `package.json`.