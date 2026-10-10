---
name: opennode-lib-wiring-audit
description: Audits whether this repo's lib/ mechanisms are genuinely reachable and use when check:ci fails on a PROV-03 unused mechanism, an unwired symbol, a stale allowlist or exemption entry, or an orphan lib with zero importers.
---

# lib wiring audit

Governing requirement **PROV-03** (`todo.md`): "an unused mechanism is not a control." A security
mechanism MUST have at least one **non-test** call site from the deployed code path.

Three guards already implement this. Route through them; do not reimplement orphan detection with ad-hoc grep.

## 1. Always start here

```bash
cd /home/runner/workspace && pnpm run check:ci
```

That is `pnpm --filter @workspace/scripts run check:ci` → `tsx ./src/ci-checks/index.ts`, which runs
three guards and exits 1 on failure. Green output:

```
ok   PROV-03 unused mechanism — 18 required symbols: 2 tracked-unwired, 0 untracked, 0 stale
ok   RUN-22 bare join in comparison/digest — 0 violation(s), 1 documented exemption(s)
ok   OPS-20 fault injection pass-through — 10 silently injected type(s), 0 untracked, 0 stale

check:ci passed (3 guards)
```

A red run prints `FAIL <guard name> — <summary>` followed by indented `- <failure>` lines, then
`check:ci failed`. **Read the failure lines, not the summary** — the summary carries counts, the
failure lines carry the symbol name, the defining file, and the exact remedy.

| Guard | Source | Enforces |
|---|---|---|
| PROV-03 unused mechanism | `scripts/src/ci-checks/unused-symbols.ts` | `REQUIRED_SYMBOLS` (18) must each have a production call site |
| RUN-22 bare join in comparison/digest | `scripts/src/ci-checks/join-encoding.ts` | no `.join("")` outside `BARE_JOIN_EXEMPTIONS` |
| OPS-20 fault injection pass-through | `scripts/src/ci-checks/fault-injection.ts` | every `FaultType` must reach a `case FaultType.X:` arm |

## 2. PROV-03 finding: wire it AND delete its allowlist entry in the same change

A red PROV-03 line names one of two failure kinds. They are opposite halves of one fix.

**`untracked`** — no production call site, and no allowlist entry:

```
unwired required symbol not on allowlist: PROV-03:<symbol> (<definingFile>) — wire it or add it to KNOWN_UNWIRED_ALLOWLIST with a tracking id
```

**`stale`** — it *does* have a call site but is still listed:

```
stale allowlist entry: PROV-03:<symbol> now has a call site — remove it from KNOWN_UNWIRED_ALLOWLIST
```

Procedure for either:

1. The defining file is in the failure line, or in `REQUIRED_SYMBOLS` in `scripts/src/ci-checks/unused-symbols.ts`.
   Each entry carries `required(symbol, definingFile, callPattern)`.
2. Find a **production** call site. The guard computes "used" as: any non-test file *other than the
   symbol's own defining file* whose content matches `callPattern`. A call inside the defining file
   does not count. A call in a `.test.ts` / `.spec.ts` / `tests/` / `__tests__/` file does not count —
   `isTestFile()` in `scripts/src/ci-checks/source.ts` is applied by the guard by design, so a
   mechanism exercised only by tests is still unwired.
3. Add the call site to the real deployed path (an api-server route, a production lib module), not to a test.
4. **Delete the symbol's entry from `KNOWN_UNWIRED_ALLOWLIST` in the same change.**

Why step 4 is not optional: the guard fails on stale entries. Wiring a mechanism but leaving its
allowlist line behind converts an `untracked` failure into a `stale` failure — the same red CI, and the
next agent will be sent looking for a call site that already exists.

Entries are `PROV-03:<symbol>` strings. **Derive the current contents, never assert them** — this
allowlist is actively maintained and shrinks every time someone wires a mechanism:

```bash
grep -n "KNOWN_UNWIRED_ALLOWLIST" -A6 scripts/src/ci-checks/unused-symbols.ts
```

The same applies to the sibling allowlists: `KNOWN_PASS_THROUGH_ALLOWLIST` in
`scripts/src/ci-checks/fault-injection.ts` and `BARE_JOIN_EXEMPTIONS` in
`scripts/src/ci-checks/join-encoding.ts`. All three fail on stale entries, all three change as the
code moves, and all three are the reason a "half-finished" wiring shows up as a stale failure rather
than passing quietly.

Removing an entry is how the repo records that a mechanism became reachable. Leaving it is a claim
that it is still unwired, and it becomes false the moment you wire it.

Note the guard skips `scripts/src/ci-checks/` itself (`checkUnusedSymbols` passes a `skip` predicate),
so the guard source never satisfies another symbol's `callPattern`.

## 3. The same stale-entry rule applies to the other two guards

Do not treat a stale entry as a separate cleanup ticket. It is the second half of a wiring change in
all three guards.

**OPS-20** — `KNOWN_PASS_THROUGH_ALLOWLIST` in `scripts/src/ci-checks/fault-injection.ts`. Keys are
`` `${method}:${type}` ``, e.g. `inject:Partition`, `injectSync:MessageLoss`. 10 entries today.
The guard diffs the `FaultType` enum in `lib/failure-injection/src/injector.ts` against the
`case FaultType.X:` arms inside `inject()` and `injectSync()`. A type reaching `default:` injects
nothing while the fault scenario reports green.

- Wire it → add `case FaultType.X:` to the method body **and** delete `"<method>:X"` from the allowlist.
- Adding the `case` without deleting the entry fails as
  `stale OPS-20 allowlist entry: <key> is now explicitly injected — remove it from KNOWN_PASS_THROUGH_ALLOWLIST`.
- A newly added enum member with no `case` arm fails as `untracked`, which is the intended signal —
  inject it or document it with a tracking id.

**RUN-22** — `BARE_JOIN_EXEMPTIONS` in `scripts/src/ci-checks/join-encoding.ts`. Keys are **file
paths, not line numbers**:

```ts
export const BARE_JOIN_EXEMPTIONS: readonly string[] = ['lib/peernet/src/membership.ts'];
```

The single exemption is justified because that file encodes fixed-width hex bytes
(`toString(16).padStart(2, "0")`), where concatenation is injective. Pattern is
`/\.join\s*\(\s*(['"])\1\s*\)/`, tested per line. Replacing the bare join with a length-prefixed
encoding or `JSON.stringify(sortedArray)` makes the exemption stale, which fails as
`stale RUN-22 exemption: <path> no longer contains join("") — remove it from BARE_JOIN_EXEMPTIONS`.
Remove the entry in the same change. Adding an exemption is only legitimate for a fixed-width
encoding, and the comment above the existing entry is the model.

## 4. Auditing a lib with no guard entry

`REQUIRED_SYMBOLS` covers 18 symbols. Everything else in `lib/` is uncovered by CI, so orphans there
are silent. For those, fall back to importer counting — but count **import specifiers**, not words.

```bash
# declared-but-unimported packages: who even lists this as a dependency?
grep -rn '"@workspace/<pkg>"' --include=package.json . --exclude-dir=node_modules

# real importers, production only
grep -rn --include=*.ts --include=*.tsx "@workspace/<pkg>" . \
  --exclude-dir=node_modules --exclude-dir=dist \
  | grep -E "from \"|from '" \
  | grep -vE '\.(test|spec)\.tsx?$' \
  | grep -vE '(^|/)(tests?|__tests__|__test__)/'
```

Two traps that produce false conclusions — both were hit while writing this skill:

- **Grep the quoted specifier, not the bare word.** Grepping `gossip` returns
  `lib/feature-flags/src/index.ts` (a `"gossip.enabled"` flag key) and `lib/failure-injection/src/registry.ts`
  (fault-point names). None of those import `lib/gossip`. Only a `from '@workspace/gossip'` hit is an importer.
- **Subpath exports defeat exact-name matching.** `@workspace/peernet` is imported as
  `@workspace/peernet/membership`, `@workspace/peernet/replayProtection`, and `@workspace/peernet/signatures`.
  A grep for exactly `'@workspace/peernet'` reports zero importers and is wrong. Always match the prefix
  and inspect the `from "..."` clause.

Zero importers outside the package's own `lib/<pkg>/` directory means **orphan**. Zero importers
repo-wide *including* `package.json` declarations means the package is not even a dependency of
anything. A package declared in a `package.json` but never imported is a dead dependency edge that
typechecks cleanly and hides the whole library from review.

Also check for the transitive form: a lib can have one importer whose only path to it is a function
that itself has no callers (see `lib/raft-log` below).

## 5. Known orphans — work list

Verified against the tree. None are on a CI guard, so none are caught automatically. Wire each under
PROV-03 before claiming its governing mechanism is a control.

| Package / mechanism | Evidence | Requirement |
|---|---|---|
| `@workspace/gossip` (`lib/gossip`) | Zero importers; not a dependency of any `package.json`. `lib/feature-flags` and `lib/failure-injection` mention "gossip" as strings only. | **NET-07 / NET-08** (gossip signing, anti-entropy); **ENC-04** (`lib/gossip/src/rumorSet.ts:130` sorts with `localeCompare` before `setHash`) |
| `@workspace/failure-injection` (`lib/failure-injection`) | Zero production importers. Only `scripts/src/ci-checks/` references it, as a file path string. Both `PROV-03` allowlist entries live here. | **OPS-07** (fault injection must be wired), **OPS-20** (must not mask behavior) |
| `@workspace/raft-log` (`lib/raft-log`) | One importer: `lib/membership-log/src/core.ts:36`. That importer's `MembershipLog.createWithRaft` (defined `core.ts:233`) has **zero call sites** — `new RaftEventLogStore(deps.raftConfig)` at `core.ts:241` is unreachable. | **PROV-03** (no `todo.md` entry names raft-log yet) |
| `@workspace/content-store` at the API server | Declared at `artifacts/api-server/package.json:41`, imported by **no** api-server source file. Only `lib/worker-runtime/src/contentStore.ts` imports it, via `@workspace/content-store/encryption` and `/hash`. | **PROV-03**; `lib/content-store/src/stream.ts` `truncate(reason)` discarding its reason is **PROV-01** |
| `lib/peernet` transport | `PeerTransport` (`lib/peernet/src/transport.ts:46`) has exactly one implementor, `InMemoryPeerTransport` (`lib/peernet/src/inMemory.ts:25`). Never instantiated anywhere outside `lib/peernet` — production imports peernet only for `membership`, `replayProtection`, `signatures`, and the barrel. | **PROV-03** |

Two related cautions:

- `todo.md` PROV-03's evidence paragraph names `Libp2pPeerTransport` and `setFeatureFlagsInstance`.
  **Neither exists anywhere in the source.** Do not send anyone hunting for them; the transport that
  does exist is `InMemoryPeerTransport`.
- `todo.md` claims `observability` is "not even declared as dependencies of the server". That is now
  **stale**: `@workspace/observability` is declared at `artifacts/api-server/package.json:32` and imported
  by `routes/membership.ts`, `routes/flags.ts`, `routes/metrics.ts`, and `routes/runs.ts`. It is not an
  orphan. (Its own requirement is **OPS-03**, observability must be emission, not declaration.)

## 6. Reporting

State which guard fired, the exact symbol or key, the defining file, the production call site you
added or the arm you added, and the allowlist/exemption entry you removed. If you wired a mechanism
without removing its entry, `check:ci` will say `stale` and the work is not finished.

Do not edit an allowlist file as part of an audit report — an audit names the required edit; the
wiring change and the allowlist deletion land together, in one change, with the wiring.