# OpenNode

Enterprise-grade decentralized cluster for running untrusted containerized workloads. Each
installation is a peer node with its own persistent identity, durable local state, UI/API,
peer networking, and optional execution capacity. Nodes exchange authenticated events and
reach cluster decisions through a replicated consensus log — there is no central controller,
shared database, or single scheduler.

> **Project status: planning and partial implementation.** A ten-domain review found that most
> `[x]` items in `todo.md` were marked complete on source-code reading rather than executable
> evidence. **All five release gates are NOT MET.** Start with `docs/release-gates.md`.
>
> ⚠️ **This repository is under active development.** `lib/peernet/src/libp2pTransport.ts`
> appeared after the first draft of these documents, which had correctly reported that no
> production transport existed. Statements below carry the date they were verified. Re-verify
> before relying on any specific claim.

## Run & Operate

- `pnpm --filter @workspace/api-server run start` — run the API server. **`PORT` is required** and the process throws at startup without it; the Replit artifact config sets `PORT=8080`. There is no default port.
- `pnpm run typecheck` — `tsc --build` plus per-package checks. Note it uses `--if-present`, so packages without a `typecheck` script are skipped; `lib/peernet` and `lib/api-spec` are not in the root `tsconfig.json` reference graph.
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — **dev only.** No committed migrations exist; never run against a node's durable store (`todo.md` DATA-01)
- `pnpm -r test` — **no `test` script exists in any package.** `vitest` is declared in `lib/peernet/package.json` but unconfigured, and there are zero test files. See OPS-01.

Required env: `PORT` **and** `DATABASE_URL` — both are mandatory and both are currently
undocumented as a pair.

> **Do not set `OPENNODE_LOCAL_SECRET_KEY`.** It falls back to the published literal
> `"opennode-local-dev-secret"`, from which any party's NodeId is computable and any
> signature forgeable. Signing material belongs in the keystore (`todo.md` NET-02).

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

| Area | Location |
|---|---|
| Requirements + closures | `todo.md` — **start here**; 199 numbered requirements (`GOV/NET/SYNC/RUN/EXEC/SEC/API/DATA/UX/OPS/CONC/CFG/ENC/TIME/LIFE/PROV`) |
| Release gates | `docs/release-gates.md` — all five NOT MET, with the evidence rule |
| Threat model | `docs/threat-model.md` — 6 of 54 claimed mitigations actually implemented |
| Architecture selections | `docs/selections.md` — peer network and consensus both NOT SELECTED |
| Deployment targets | `docs/replit-deployment.md` — Replit is UI/client only |
| Canary plan | `docs/canary-deployment.md` — scenarios annotated with blockers |
| SLOs | `docs/slos.md` — 26 SLIs, 17 SLOs, none instrumented |
| Runbooks | `docs/runbooks/README.md` — 14 required, none written |
| API contract (source of truth) | `lib/api-spec/openapi.yaml` |
| DB schema | `lib/db/src/schema/` |
| Domain rules | `lib/opennode-domain/` — membership, governance, jobs, identity |
| Consensus log + sync | `lib/sync-engine/` — bespoke log; needs a real engine (SYNC-01) |
| Peer networking | `lib/peernet/` — a libp2p transport now exists but is **never instantiated**; `authorizePeerAccess` has no callers (NET-01) |
| Worker isolation | `lib/worker-runtime/` — **spawns no process** (EXEC-01) |
| Web client | `artifacts/opennode/` |

## Architecture decisions

- **No custom consensus.** `todo.md` requires a maintained, reviewed engine; the shipped
  `EventLog` is a bespoke single-writer append with no quorum, and its adapter interface
  cannot express one. **SYNC-01, D10.**
- **An unused mechanism is not a control.** Roughly 20 security functions — including the
  whole `observability` and `failure-injection` packages — have zero call sites. Correct code
  that nothing invokes provides zero protection while reading as a control. **PROV-03.**
- **Submit before you schedule.** A run is committed first, then leased. Assignment must be
  driven by committed state so a client retry cannot leave a run permanently unassigned.
  **RUN-01.**
- **Fencing must stop the worker, not just the record.** Updating the attempt row while the
  container keeps running is the duplicate-execution hole. **RUN-04.**
- **One deep module per domain.** Thresholds, state machines, and authorization live in the
  domain core; UI/API/CLI are thin clients. A second exported governance engine currently
  violates this. **GOV-01.**
- **A proposal is data, not a count.** Committed membership events carry the frozen electorate
  and counted ballot digests so peers can independently re-verify. **GOV-02, SYNC-09.**

## Product

Projects, cluster and membership views, run submission with preflight, run history with
resumable logs and artifacts, and node health. Governance covers admission, voluntary leave,
and eviction by frozen-electorate vote.

## User preferences

- **Documentation only until the review gaps are triaged.** No code changes without explicit
  approval — the corrections in `docs/` were scoped to requirements and design docs.
- Requirement IDs (`SYNC-01`, `EXEC-06`, …) are the shared vocabulary across all documents;
  cite them rather than restating a rule.
- Claims of completion require a **named runnable test** and a commit SHA. Source-code reading
  is not evidence.
- **Verify before you cite.** Several claims in the first draft of these docs were wrong and
  were caught only by adversarial re-reading of the source. Re-check anything load-bearing.

## Gotchas

- **An unused mechanism is not a control.** `runCatchUp`, `authorizePeerAccess`,
  `ensureNodeIdentity`, the entire observability package, and ~20 other security functions
  have zero call sites. This is the dominant failure mode. **PROV-03.**
- **Nothing is authenticated.** `@clerk/express`, `helmet`, and `cookie-parser` are declared
  dependencies and never imported; `POST /membership/leave` and the flags routes are publicly
  reachable. **API-01.**
- **Two disjoint `FeatureFlags` instances.** The kill switch and flag endpoints mutate an
  instance the run coordinator never reads, so they have no effect on execution. **CFG-01.**
- **No run ever terminates.** `observeAttempt` has no callers, so runs freeze at `scheduled`
  and the 9th submission is rejected with 429 permanently. **RUN-21.**
- **Every node's identity is the string `"local"`.** The identity table has no write path, so
  membership, leases, and run identity all collide across nodes. **GOV-21.**
- **State does not survive restart.** Consensus log, run ledger, membership, and all governance
  state are in-memory. **SYNC-01, RUN-13.**
- **Backups destroy every timestamp** (`stableStringify` renders `Date` as `{}`) and restore
  **deletes the audit trail** plus the node's identity. **DATA-03, DATA-04.**
- **No enforcement anywhere.** Resource limits, quotas, rate limits, and retention are declared
  and typed but not applied — with one exception, the wall-clock timer. **EXEC-03.**
- **`.replit` uses `deploymentTarget = "autoscale"`**, incompatible with durable inbound peer
  streams, a stable public identity, and graceful shutdown.

## Pointers

- `pnpm-workspace` skill — workspace structure, TypeScript setup, package details
- `todo.md` — the requirements document and the source of truth for every closure
