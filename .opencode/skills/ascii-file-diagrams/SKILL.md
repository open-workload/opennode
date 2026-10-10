---
name: ascii-file-diagrams
description: Add and maintain the commented ASCII diagram header that every code file carries, and check that no source file is missing one. Use when creating a new source file, when a change alters what a file does or consumes, or when auditing a file for diagram coverage.
---

# ASCII file diagrams

Every hand-written source file opens with a commented ASCII diagram of what the
file does. The diagram is orientation for the next reader and the next agent:
what goes in, what comes out, and the path between them.

## Why this exists

A file's name says what it is called. Its exports say what it offers. Neither
tells you what it does at a glance, and both drift silently — a file keeps its
name long after its logic moves. The diagram is the one place that describes
*behaviour*, so it has to be updated when behaviour changes. A stale diagram is
worse than none, because people trust it.

## The rule

The diagram is a comment block. It must not affect behaviour, and it must match
the file's existing comment style so it reads as part of the file.

- Inputs on one side, outputs on the other, the path between them.
- For an orchestrator or state machine: the states, and the transitions.
- For a leaf helper: the contract, and what it guards or protects.
- Roughly a dozen lines or fewer. Orientation, not art.

## Examples

Leaf helper:

```ts
/**
 * Verify that two canonical JSON payloads hash equally.
 *
 *   payload ──▶ stableStringify ──▶ sha256 ──▶ hex
 *                                        │
 *                    leftDigest ──────────┴─────────▶ boolean equal
 *
 * Used by the event log to reject appends that would fork the chain.
 */
```

State machine:

```ts
/**
 * Raft node lifecycle. Single node, driven by `tick`.
 *
 *   Follower ──▶ Candidate ──▶ Leader
 *       ▲            │           │
 *       │            ▼           │
 *       └── timeout ─┴─── stepdown
 *
 *   Candidate ──votes> quorum ──▶ Leader
 */
```

Orchestrator:

```ts
/**
 * Owns one attempt of a workload run: lease, execution, result, cleanup.
 *
 *   submit ──▶ Acquire lease ──▶ Execute ──▶ Publish ──▶ Release
 *                │                  │            │
 *              reject            fault        retry ──▶ Acquire
 *                │                  │            │
 *                └──────▶ audit ◀───┴────────────┘
 */
```

## When to add or update one

**Adding:** create the diagram with the file. A new file without one is
incomplete.

**Updating:** any change that alters what the file consumes, produces, or how it
flows. Renaming an export, adding a branch to a state machine, moving a
side-effect behind a guard — if the diagram would now be wrong, it is part of the
same change. A change that leaves a diagram describing removed behaviour has
introduced a defect, exactly like a stale test would.

## Exemptions

- Generated files — the diagram belongs in the generator or the spec.
- Test files — the name and the assertions already document the intent.
- Type-only re-export barrels.

## Audit

Confirm coverage across the tree:

```bash
for f in $(git ls-files 'lib/**/*.ts' 'artifacts/**/*.ts' | grep -v '\.test\.ts' | grep -v '/generated/'); do
  head -20 "$f" | grep -qE '[-+|\\/_<>*^=~`]' && head -12 "$f" | grep -qE '^\s*(//|\*|/\*)' \
    || echo "NO DIAGRAM: $f"
done
```

The check is a heuristic: it looks for a comment block near the top containing
box-drawing characters. Expect false positives on short files and false
negatives where a diagram is worded differently. **Read the file before
concluding anything** — this command tells you where to look, not what is true.

## Sizing the work before starting it

Do not trust the heuristic's count as the backlog. Classify first, so the
sweep has a real denominator and the trivial files are excluded deliberately
rather than by accident:

- **Barrels** — re-export files with no executable body. Exempt under the rule.
- **Config** — `*.config.ts` and build wiring. Exempt; there is no behaviour to
  orient a reader toward.
- **Small** — under ~45 lines. Judgment call, and usually not worth a diagram;
  the file is already readable end to end.
- **Substantive** — the real backlog. These are worth a diagram.

Re-derive the classification when starting a sweep rather than trusting a number
recorded here — the tree moves, and a stale denominator is how a sweep either
misses files or wastes effort on ones that never needed it.

## Boundary

Adding diagrams to an existing file is a change to that file's contract with its
readers, so it belongs in its own slice or with the logic change that motivated
it. Do not sweep the whole tree in a commit that also changes behaviour — the
diff becomes unreviewable and the real change gets lost in it.

**Check for concurrent writers before a sweep.** A sweep touches many files at
once, so it collides with anyone else editing them — and a diagram written into
a file whose logic is mid-rewrite is stale on arrival, which is the one defect
this rule exists to prevent:

```bash
git status --short   # any dirty .ts files are someone else's active work
```

If files are dirty, do not write diagrams into them. Land the scoping now and run
the sweep when the tree is quiet — a correct diagram later beats a stale one
now.