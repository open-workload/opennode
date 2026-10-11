---
name: opencode-session-resume
description: Resume every opencode session that still has incomplete todos until all are done — use when sessions were interrupted mid-slice, when todo.md or GitHub issues show unfinished work, or when asked to resume all sessions, finish the outstanding todos, or run the session supervisor (scripts/src/opencode-session-resume.ts).
---

# opencode session-resume supervisor

Procedure for running the supervisor (`scripts/src/opencode-session-resume.ts`)
that continues every opencode session left with incomplete todos. It only
*continues* existing sessions — see §2 for when not to reach for it.

## 1. What it does

- Opens opencode's SQLite DB **read-only** (`node:sqlite`).
- Finds sessions with **incomplete todos**: todo status `NOT IN
  (completed, cancelled)`, session not archived, and **top-level only** — child
  / subagent sessions are excluded, because their parent session is the one to
  resume.
- Resumes each eligible session by spawning
  `opencode run --session <id> --dir <dir> <prompt>`.

The default resume prompt is
`"Resume this session and finish its remaining todos. ..."`; override it with
`--prompt`.

## 2. When to use — and when not

Use it when:

- a session was interrupted mid-slice and its todos are still open;
- `todo.md` or its mirrored GitHub issues show unfinished work;
- the user asks to "resume all sessions" / "finish the outstanding todos" /
  "keep working until the todos are done".

Do **not** use it to start brand-new work. The supervisor never opens a fresh
session or invents a task; it only continues sessions that already exist and
already have incomplete todos.

## 3. The hazard (operating rule 7)

Resuming several sessions that share one working directory concurrently cares
about the same git index, branch pointer, `.tsbuildinfo`, and build state. Two
sessions on one tree corrupt it.

The supervisor defends against this:

- **Per-directory locks** — it serializes per working directory, so two eligible
  sessions in the same tree never resume at once.
- **Singleton lock** — it refuses to start a second supervisor (exit `3`).

**A human running it must not start a second supervisor, or a manual `opencode`
session, on the same tree while it runs.**

## 4. Procedure

Invocation is the `resume-sessions` script in `@workspace/scripts`. Pass the
subcommand directly; add a leading `--` only when the first argument is a flag
(so pnpm does not swallow it). The script tolerates a leading `--` either way.

```bash
# 1. Be alone first. Report anything you did not write, then stop.
git status --short

# 2. See the queue and whether a supervisor is already live.
pnpm --filter @workspace/scripts run resume-sessions status

# 3a. Continuously supervise until done (loop every --interval seconds):
pnpm --filter @workspace/scripts run resume-sessions watch

# 3b. Or run exactly one pass and report:
pnpm --filter @workspace/scripts run resume-sessions once
```

Dry-run the plan (prints it, takes no locks, spawns nothing, exit 0) before a
real pass. The first argument is a flag, so the `--` separator is required here:

```bash
pnpm --filter @workspace/scripts run resume-sessions -- once --dry-run
```

### Subcommands

| Command  | Behavior | Exit |
| --- | --- | --- |
| `status` | Report liveness (heartbeat age, lock held) and the queue of sessions with incomplete todos. | `0` |
| `once`   | One supervision pass: resume eligible sessions, then report. | `0` all done, `2` some remain after attempts exhausted, `3` another supervisor holds the lock |
| `watch`  | Loop passes every `--interval` seconds until no incomplete todos remain or every eligible session has exhausted its attempts. | `0` all done, `2` attempts exhausted |

### Options

| Flag | Meaning | Default |
| --- | --- | --- |
| `--db <path>` | opencode sqlite db. | `$OPENCODE_DB`, else `opencode db path`, else error |
| `--state <dir>` | supervisor state dir. | `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/resume-supervisor` |
| `--interval <secs>` | `watch` loop interval. | `60` |
| `--max-parallel <n>` | max concurrent resumes. | `1` |
| `--max-attempts <n>` | per-session resume attempts before giving up. | `5` |
| `--attempt-timeout <s>` | kill a resume that exceeds this. | `1800` |
| `--cooldown <s>` | min seconds between attempts for the same session. | `300` |
| `--prompt <text>` | resume prompt. | `"Resume this session and finish its remaining todos. ..."` |
| `--auto` | pass `--auto` to `opencode run` (auto-approve permissions; dangerous). | off |
| `--dir <path>` | only resume sessions whose directory matches (repeatable). | all |
| `--dry-run` | print the plan without spawning opencode or taking locks; exit `0`. | off |
| `--log <file>` | JSONL log path. | `$STATE/resume-supervisor.jsonl` |
| `--log-level <level>` | `debug`\|`info`\|`warn`\|`error`. | `info` |
| `-h`, `--help` | usage. | — |

Exit codes in full: `0` all done / nothing to do; `1` usage or fatal error;
`2` incomplete todos remain after attempts exhausted; `3` duplicate supervisor
refused.

## 5. State and logs

Default state dir:
`${XDG_STATE_HOME:-$HOME/.local/state}/opencode/resume-supervisor`.

| File | Contents |
| --- | --- |
| `heartbeat` | Liveness marker; mtime advances each pass. |
| `attempts.json` | Per-session attempt counts and cooldown timestamps. |
| `resume-supervisor.jsonl` | Structured JSONL, emitted via the repo's `LogCorrelator` (`lib/observability/src/logCorrelation.ts`). |
| `sessions/<id>.log` | Raw per-session resume output. |

To check it is running: run `status`, then look at the heartbeat age and whether
the lock is held. A stale heartbeat with the lock held means a wedged supervisor.

## 6. Failure modes

- **Stuck session.** After `--max-attempts` the session is listed as skipped and
  the run exits `2`. Raise `--max-attempts` deliberately, or fix the session
  before retrying; do not loop `watch` hoping it clears.
- **Duplicate supervisor.** A second supervisor exits `3` immediately. This is
  correct — do not delete the lock file to force it through.
- **DB path resolution.** Resolution order is `--db`, then `$OPENCODE_DB`, then
  `opencode db path`. If all are absent it is a fatal error (exit `1`). Pass
  `--db` explicitly when running outside the normal environment.
- **WAL read-only note.** opencode writes in WAL mode, so the supervisor reading
  the DB read-only while opencode is running is safe and expected; no need to
  stop opencode first.

## 7. Verification

The supervisor is covered by vitest at
`scripts/src/opencode-session-resume.test.ts`. After changing the script:

```bash
pnpm exec vitest run scripts/src/opencode-session-resume.test.ts
```
