---
name: branch-commit-pr-workflow
description: Create a branch per slice, commit periodically with the repo's message style, and land work through a merged pull request instead of pushing to main. Use before the first edit in a session, when committing finished work, or when the user says commit, branch, push, or open a PR.
---

# Branch, commit, PR workflow

`main` is not a working branch. Every slice lands through a short-lived branch
and a merged pull request, so `main` always holds verified, reviewed work and
any single change stays revertable on its own.

## Branch per slice

```bash
git checkout -b <type>/<ID-short-slug>
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`.

```bash
git checkout -b feat/ops-08-structured-logger   # OPS-08
git checkout -b docs/prov-03-release-gates      # PROV-03
```

The branch name carries the `todo.md` requirement ID so the branch, the issue,
and the board item all share one handle.

**Branch before the first edit.** Creating a branch afterwards to "capture"
work already staged is how unrelated changes get bundled into one PR. Branch
first, then edit.

## Before committing: branch is not optional

```bash
git branch --show-current    # must not be main
```

If it says `main`, stop and create the branch. Committing to `main` means the
change cannot land through a PR.

## Committing periodically

Commit when a slice reaches a green state — do not save commits for the end of
a session. A run of work that dies mid-slice should still be recoverable.

### Pre-commit gate

Every commit runs the project's verification first. Never commit code that
does not typecheck or whose tests fail:

```bash
pnpm run typecheck && pnpm test
```

Verified present in this repo's root `package.json`. If a slice touches
`docs/` or config only, `pnpm run typecheck` alone is the gate; a slice that
changes release evidence also runs `pnpm run check:ci`.

### Scope

One slice per commit. Do not mix a `docs/` fix with a `lib/` behaviour change,
and never sweep in unrelated modified files. Stage explicitly by path:

```bash
git add lib/foo/src/bar.ts lib/foo/src/bar.test.ts
git status --short    # confirm nothing unintended is staged
```

Never `git add -A` or `git add .` — that is how generated files, lockfile
churn, and half-finished slices get into a PR. The lockfile is a special case:
regenerate it deliberately and commit it in its own `chore:` commit.

### Message style

This repo uses imperative, sentence-case subjects with no conventional-commit
prefix and no body:

```
Clear stale PROV-03 allowlist entries now that mechanisms are wired
Regenerate lockfile for api-server observability dependency
Add peer clustering, rootless runtime, and verification pipeline
```

So: `<Imperative verb> <what changed>` — capital first letter, no trailing
period, no `feat:` prefix. Read `git log --oneline -10` before committing and
match what is actually there; if the repo has shifted to conventional commits,
follow that instead.

Add a body only when the *why* is not obvious from the subject — a rejected
alternative, a constraint that forced the design.

## Pull request

```bash
git push -u origin <branch>
gh pr create --title "<ID>: <goal>" --body "<what, why, verification output>"
gh pr merge <n> --squash --delete-branch
```

The PR title carries the requirement ID, matching the issue title and branch
name. The body states the verification command and its actual output — a PR
without that is not ready for review.

Link the issue in the body (`Closes #12`) so merging closes it and updates the
board automatically.

**Squash-merge by default.** `main`'s history is already a linear run of
single-purpose commits; fast-forward merges would stack the per-commit noise of
a branch that took twelve commits to land.

Never push to `main` directly, never force-push, and never amend a pushed
commit — add a follow-up commit instead.