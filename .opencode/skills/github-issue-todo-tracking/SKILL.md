---
name: github-issue-todo-tracking
description: Mirror every todowrite todo to a GitHub issue and keep issue comments and status in sync. Use when the repo has a GitHub remote, when starting or finishing a slice, when reporting progress, or whenever a todo is added, started, blocked, or completed.
---

# GitHub issue todo tracking

Every todo in the `todowrite` list has a corresponding GitHub issue. The issue
is the durable record; the todo list is the working view. They never diverge.

## Setup (once per machine)

```bash
gh auth status          # confirm a token with 'repo' scope
gh auth setup-git       # wire gh as the git credential helper
```

If `gh auth status` fails, do not silently skip issue tracking and do not print
the token. Tell the user to run `gh auth login` and continue with todos
alone.

## Detect whether the repo is tracked

```bash
git remote get-url origin | grep -q 'github.com' && gh repo view --json nameWithOwner -q .nameWithOwner
```

`gh repo view --json number` does **not** work — `number` is not a field on that
query. Use `nameWithOwner`. No GitHub remote means no issues: fall back to
`todowrite` only and say so once.

## Labels

These are the only labels this workflow uses. `gh label create` is **not**
idempotent — a second call without `--force` fails with "label already exists".
Always pass `--force`:

```bash
gh label create slice --color 0e8a16 --description "Tracked unit of work" --force
```

Verify what already exists first with `gh label list`. Only create the four
below; do not touch the repo's default labels (`bug`, `enhancement`, etc.).

| Label | Color | Meaning |
|---|---|---|
| `slice` | `0e8a16` | A tracked unit of work |
| `in-progress` | `d93f0b` | Exactly one open issue carries this |
| `blocked` | `b60205` | Cannot proceed; blocker stated in a comment |
| `needs-decision` | `fbca04` | Waiting on a human choice |

## The mapping

| todowrite state | issue state | label change | comment |
|---|---|---|---|
| new todo | `open` | add `slice` | initial body: goal, file scope, verification command |
| → `in_progress` | `open` | add `in-progress`, remove `blocked` | `▶️ Started` + start time |
| → `completed` | `closed` (reason: completed) | remove `in-progress` | `✅ Done` + test/typecheck output |
| blocked | `open` | add `blocked`, remove `in-progress` | `🚧 Blocked: <specific blocker>` |
| → `cancelled` | `closed` (reason: not planned) | remove all | `❌ Cancelled: <why>` |

Exactly one issue carries `in-progress` at a time, mirroring the single
`in_progress` todo rule.

## Required command shapes

Create, in the same message as the todo write. Note the label set: `slice`
only. Do **not** add `in-progress` at creation, even for the todo you are about
to start — parallel slices are dispatched in one message, and pre-labelling
them all would put several issues into `in-progress` at once. The label is
applied when the todo actually flips, in the `Start` step below.

```bash
gh issue create --title "<ID>: <goal>" --label slice \
  --body "<goal, file paths in scope, exact verification command>"
```

Sync a state change (never edit the issue body to signal progress, comments are
the audit trail):

```bash
# Start
gh issue edit <n> --add-label in-progress
gh issue comment <n> --body "▶️ Started $(date -u +%FT%TZ)"

# Block
gh issue edit <n> --add-label blocked --remove-label in-progress
gh issue comment <n> --body "🚧 Blocked: <specific blocker>"

# Complete — reason and --comment are both required for a clean audit trail
gh issue close <n> --reason completed \
  --comment "✅ Done — <verification command + its actual output>"

# Cancel
gh issue close <n> --reason "not planned" --comment "❌ Cancelled: <why>"
```

`--reason "not planned"` needs the quotes — the space splits it into two args
otherwise. `gh issue close --comment` posts the comment *and* closes in one
call; do not `gh issue comment` first and then close, that produces two entries.

Find the issue number for a todo by its ID prefix. Store the mapping in the
todo body as `#<issue-number>` the moment it is created, so later syncs need no
search at all — the search is only the recovery path when that link is lost:

```bash
gh issue list --state all --search "in:title PROV-01" --json number,title,state \
  -q '.[] | select(.title | startswith("PROV-01:")) | "\(.number) \(.state)"'
```

Three traps in that command, all learned the hard way:

- **`--state all` is required.** `gh issue list` defaults to `state: open`, so a
  completed slice's issue silently becomes unfindable — and the next lookup
  creates a duplicate. Always pass `--state all` when correlating.
- **Search matches substrings, not IDs.** `in:title DATA-01` would also match
  `DATA-010`. The `startswith` filter is what makes it exact — do not drop it.
  Verified for this repo: the 208 distinct IDs in `todo.md` contain no
  `X-01`/`X-010` prefix pairs today, but re-run the check before adding a new
  ID family rather than assuming it stays true.
- If the search returns more than one match, stop and report the ambiguity. Do
  not guess.

## Correlation with the repo's requirement IDs

`todo.md` is the source of requirement IDs (`PROV-03`, `NET-01`, `RUN-22`, …).
The issue title carries the same ID so `todo.md` and GitHub stay linkable:

- Title: `PROV-03: guard releases on typecheck`
- Body opens with `Source: todo.md § <section>` and links back.

**One requirement is not one issue.** `todo.md` cites some IDs many times —
`NET-01` and `SYNC-01` appear 7 times each. Those mentions are cross-references
to a single requirement, not seven slices, and not seven issues. Before creating
an issue, search for an existing one on the same *defect*; if it exists, reuse it
and comment rather than opening a second issue.

**But distinct defects under one ID get distinct issues.** A requirement like
`SEC-01` can be violated in several unrelated places, each needing its own fix,
its own PR, and its own verification. Merging them into one issue recreates the
original problem — a single issue that never closes because three unrelated
defects block it. This repo currently has three open `SEC-01` issues and two
`NET-01` issues, all genuinely different defects.

So the ID prefix **groups** issues; it does not identify one. Consequences:

- Correlation must use the issue number recorded in the todo body, not a title
  search. The search is recovery only, and it is ambiguous by design.
- When recovering from a search, match the **full title**, not just the ID
  prefix. `in:title SEC-01` matches three issues; only the descriptor after the
  colon distinguishes them.
- If a search is genuinely ambiguous, report it and ask. Do not guess which
  issue a todo belongs to.

## The kanban board (projects)

Issues are the record; the board is the visual mirror. A project item is
backed by a real issue, so every benefit of issues — numbers, comments,
`--reason`, search — survives. Do **not** use `gh project item-create` draft
items: a draft issue has no repo issue number and never appears in
`gh issue list`, which would break the correlation above.

### Resolved IDs for this repo — do not re-derive

```
project number : 1
project id     : PVT_kwDOFEnQgc4BmadI
owner          : open-workload
field  Status  : PVTSSF_lADOFEnQgc4BmadIzhlDoeM
  Todo        656c2e60
  In Progress 8da18d8c
  Blocked     636c1598
  Review      55d2e219
  Done        976ae46a
  Cancelled   d06d5694
```

Re-resolve only if `gh project field-list 1 --owner open-workload` stops
matching these.

### Adding an issue to the board

```bash
gh project item-add 1 --owner open-workload \
  --url https://github.com/open-workload/opennode/issues/<n>
```

`item-add` needs **both** the project number and `--url`. Passing neither makes
`gh` fall back to interactive prompts, which fails in a non-TTY session with
`project number is required when not running interactively`.

### Setting the status

Prefer name-based editing — it survives option-ID rotation:

```bash
gh project item-edit 1 --owner open-workload \
  --url https://github.com/open-workload/opennode/issues/<n> \
  --field Status --value "In Progress"
```

For non-draft issues only **one** field value can be set per invocation.

### Removing an item

```bash
gh project item-delete 1 --id <PVTI_...> --owner open-workload
```

Needs the project number *and* `--id`. Removing an item does not close the
issue, and closing an issue does not remove the item — they are separate.

### Status mirrors the todo, label stays the guard

| todo state | label | board column |
|---|---|---|
| new / `pending` | `slice` | Todo |
| `in_progress` | `in-progress` | In Progress |
| blocked | `blocked` | Blocked |
| verification passed, human sign-off | `needs-decision` | Review |
| `completed` | *(removed)* | Done |
| `cancelled` | *(removed)* | Cancelled |

The `in-progress` label remains the single-active guard because it is queryable
from `gh issue list` without a project lookup. The board duplicates that state
for humans and never overrides it — if they disagree, the label wins and the
board is corrected.

## Parallel slices and the single in-progress rule

The build agent dispatches independent slices in one message, which collides
with "exactly one `in_progress` at a time" if creation also sets the label.
Resolution, which the commands above already implement:

1. Create every issue up front with `--label slice` only.
2. Put every issue number into its todo body immediately.
3. Add each to the board with status `Todo`.
4. Apply `in-progress` / `In Progress` to the one todo that actually starts, and
   clear both when that todo completes or blocks.

If a second slice genuinely must start before the first finishes, that is a
deliberate deviation: comment on both issues saying so, so the audit trail
explains the two `in-progress` labels rather than leaving them contradictory.

## Rules

- **Never** bulk-create issues for the whole `todo.md` without asking. It holds
  208 distinct IDs; 200+ issues in one command is unrecoverable noise. Propose
  the command, let the user run or approve it.
- **Never** close an issue to hit a count. Close it when the verification
  command passed.
- **Never** delete an issue. Close with the right reason instead.
- **Never** use `gh project item-create`. Draft items have no issue number and
  are invisible to `gh issue list`, which silently breaks correlation. Board
  items must be added from a real issue URL.
- The issue body's verification command and the todo's must be identical. If
  they differ, one of them is wrong — fix before starting.
- If `gh` fails mid-slice, keep working, keep the todo list correct, and report
  the failure. Do not fake a synced state.
- `gh` is rate-limited to 5000 calls/hour per token. A large parallel dispatch
  is fine; re-running the whole slice from scratch is not. Check with
  `gh api rate_limit -q '.resources.core'` if commands start failing with 403s.
- Every `gh project` subcommand needs `--owner`, and the non-interactive ones
  also need the project number. Omitting either produces a prompt, and a
  prompt in a non-TTY session is a hard failure, not a fallback.

## Reporting

End every slice report with the issue number and its URL, so the user can click
through. A slice with passing tests but no issue is not a finished slice.

Board: <https://github.com/orgs/open-workload/projects/1>