---
name: opennode-release-gate-evidence
description: Release gate evidence bookkeeping for OpenNode — turn check:ci / PROV-03 guard output into a named runnable test, a reproduce command, and a commit SHA, then update docs/release-gates.md without inheriting stale counts or stale file paths; use when verifying a gate, when closing or reopening a docs/release-gates.md row, or when auditing a claim in the ledger.
---

# OpenNode release-gate evidence

`docs/release-gates.md` is a **status ledger**, not a source of truth. The governing
rule is in the same file and in `todo.md`: a gate is **VERIFIED** only with a named
runnable test, a reproduce command, and the commit SHA at which it passed.

This skill is the bookkeeping layer — it covers how to turn command output into a
ledger row. For **how to run** `pnpm run typecheck`, `pnpm test`, `pnpm run check:ci`,
and what each guard does, load the **`opennode-evidence-pipeline`** skill instead. Do
not restate its commands from memory; load it.

---

## 1. What counts as evidence

A gate row may say **VERIFIED** only when all three are present and written down:

| Element | What it must be | Where it goes in the row |
|---|---|---|
| Named runnable test | An exact test file path, or `pnpm run check:ci` plus the guard name | `**Tests:**` / `**Guard:**` line |
| Reproduce command | The literal command a reader can paste to re-obtain the result | `**Reproduce:**` line |
| Commit SHA | The tree the result was observed on — see §2 | `**Reproduce:**` line, with `commits \`xxxxxxx\`` |

**Not evidence.** None of these may move a gate to VERIFIED:

- Reading source and concluding the code looks correct. Gate 1 of the current
  ledger was previously marked "✅ Verified" on exactly this basis and was
  retracted.
- A status line, summary row, or requirement ID in any doc — including this one.
  `todo.md` IDs (SYNC-01, PROV-03, RUN-19, …) say what is *required*, never that it
  holds.
- "It is wired", "the code exists", "the import is there". An implemented-but-uncalled
  mechanism is the exact failure PROV-03 exists to catch.
- Output from a previous session, a previous commit, or a previous run of the ledger's
  own text. The ledger is regenerated from fresh CI output, never copied forward.

A **"To close:"** list is a backlog, not a verdict. Leave it in place when you update
a row; it is the record of what is still missing.

---

## 2. The loop

One gate, one pass, five steps. Do not batch-gate: a stale SHA or a stale count from
gate 1 silently propagates into the Summary table.

```bash
# 0. Record the tree BEFORE you run anything.
git log -1 --format=%H          # the SHA
git status --porcelain          # MUST be empty, or this SHA does not describe the tree
```

If `git status --porcelain` is not empty, the tests will run against uncommitted
work. Either commit first or record the dirty state explicitly — a SHA next to a
dirty tree is a false evidence claim.

```bash
# 1. Run the gate's test. Load `opennode-evidence-pipeline` for the exact invocation.
# 2. Capture the output rather than paraphrasing it.
pnpm run check:ci 2>&1 | tail -20
```

Then, in `docs/release-gates.md`:

3. **Fill or refresh the three evidence fields** (§1 table) on that gate's section.
   Paste the real command output; do not retype a number from memory.
4. **Update the Summary table row** for that gate to match. The section and the
   Summary table are two copies of one status — a mismatch between them is a defect in
   the ledger.
5. **Restate what is still missing.** If the gate is still NOT MET, say precisely
   which of the three evidence elements is absent. "Still NOT MET" with no stated
   blocker is not an update; it is a repeat.

**Never** mark a gate VERIFIED in the same edit that changes the code it is evidence
for. The test must pass on the committed tree first, at the recorded SHA.

> **Concurrent sessions.** If another agent or a CI run is working the repo, do not
> run `pnpm run typecheck` or `pnpm test` — overlapping `tsc --build` runs share and
> corrupt `*.tsbuildinfo`. `pnpm run check:ci` is read-only and safe. Coordinate or
> wait rather than recording evidence from a run that may have been corrupted.

---

## 3. Enumerate the gates from the doc

The gate list changes. Gates are **added** as requirements are derived from them
(there is no fixed count), so never hardcode a numbered list — a hardcoded list is
how the ledger starts lying. Read the current set:

```bash
cd /home/runner/workspace
grep -n '^## Gate' docs/release-gates.md        # gate number + full name, with line numbers
grep -n '^\*\*Status' docs/release-gates.md     # current status line per gate
```

To get the gate short names alone:

```bash
grep -oE '^## Gate [0-9]+' docs/release-gates.md
```

To work one gate, take its heading line number from the first command and read that
section in full — the heading text names the requirement IDs that gate blocks, and
the `**To close:**` list is the work order.

Requirements for each gate live in `todo.md`; search it by ID (`grep -n 'PROV-03'
todo.md`) rather than recalling IDs from the ledger.

---

## 4. The stale-reference hazard

**Before repeating any file path, claim, or count from the ledger, verify it still
exists.** The ledger cites paths that do not exist, and other docs repeat the same
citations — a wrong path copied from the ledger looks authoritative precisely because
it is already written down.

Check every path-like token the ledger cites:

```bash
cd /home/runner/workspace
grep -oE '`[A-Za-z0-9_./@-]+\.(ts|tsx|json|yml|md)`' docs/release-gates.md \
 | tr -d '`' | sort -u \
 | while read -r p; do
     if [ -e "$p" ]; then
       printf 'ok      %s\n' "$p"
     else
       hit=$(find lib artifacts scripts docs . -maxdepth 6 -name "$(basename "$p")" \
             -not -path '*/node_modules/*' -not -path './.git/*' \
             -not -path './docs/release-gates.md' 2>/dev/null | head -3)
       if [ -n "$hit" ]; then printf 'MOVED   %s -> %s\n' "$p" "$(echo "$hit" | tr '\n' ' ')"
       else printf 'MISSING %s\n' "$p"; fi
     fi
   done
```

Read the output before you write:

- **`MISSING`** — the cited path does not exist anywhere. Do not repeat it. Either
  the mechanism was never built or the claim is wrong; find out which, and say so in
  the row. A review finding that rests on a `MISSING` path is not a finding.
- **`MOVED`** — real file, different location. Cite the real path in the row.
- **`ok`** — the path exists. Existence is *not* evidence the mechanism works; it
  only means the citation is safe to repeat.

The same hazard applies to **symbols** the ledger names, not just files. Existence of
an export does not mean it has a call site — `pnpm run check:ci` (PROV-03) is the
authority on that, and it is a *different* question from "does this file exist".

When you find a stale reference, correct the ledger row that carries it. Do not
propagate it into a new row, a commit message, or a summary.

---

## 5. Derive, never assert

Every number in the ledger drifts. This skill contains **no** test counts, file
counts, or guard counts on purpose: a hardcoded number in a skill outlives the truth
it recorded, and an agent that copies it stamps a falsehood into a release gate.

Get the current numbers at the moment you write the row:

```bash
cd /home/runner/workspace

# Current test count — read vitest's trailing summary block and copy those figures.
pnpm test 2>&1 | tail -20

# Current guard output — the three `ok`/`FAIL` lines are the evidence you paste.
pnpm run check:ci

# Current SHA for the Reproduce line.
git log -1 --format=%H
```

Rules:

- **The test count is the number vitest prints in its own summary block**, not a count
  you produce by counting files or grepping for `it(`/`test(`. A file count and a test
  count are different quantities; grepping a markdown file for `it(` counts
  substrings in prose and means nothing.
- Copy the whole summary line, including the file count vitest reports alongside it.
  They change together.
- If you did not run it in this session, you do not have the number. Write
  "not re-derived this session" rather than repeating the previous figure.
- A count is only meaningful with the SHA it was observed at. Count plus SHA, or
  neither.

Any example below is an **example of shape only** and must be re-derived before use:

```text
**Reproduce:** `pnpm run check:ci` <paste today's guard output>; observed at commit <git log -1 --format=%H>.
```

Counts written into the ledger are snapshots of one commit. When the commit moves,
every count in the document is suspect — re-derive the ones you touch, and say plainly
in the row which ones you did not re-check.

---

## 6. Where the commands live

Load **`opennode-evidence-pipeline`** for how to run the three commands
(`pnpm run typecheck`, `pnpm test`, `pnpm run check:ci`), what each CI guard enforces,
how to allowlist an intentionally-unwired mechanism, and the repo's tsconfig/
`tsbuildinfo` gotchas.

CI (`.github/workflows/ci.yml`) runs the same steps on push and pull request to
`main`. CI output is the strongest available evidence, but it is still evidence of one
commit — record which. If CI and a local run disagree, the local run is the wrong
answer until you find out why.