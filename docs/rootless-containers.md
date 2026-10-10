# Rootless Containers

> ⚠️ **Status: implemented and verified in-repo.** The rootless runtime wiring
> (`rootlessRuntime.ts`, `rootlessBackend.ts`, the `cgroup.ts` integration, and
> the `rootless:install` script) is **implemented** and covered by named,
> runnable in-repo tests — see "Evidence index" below for the exact commands.
> Any earlier `/tmp` scratch transcripts (`evidence.md` files) were **ephemeral**
> and no longer exist; they are not evidence of record. Only the
> `OPENNODE_EXECUTION_BACKEND` selector remains **proposed** (not wired). Sections
> are labelled `IMPLEMENTED`/`VERIFIED` or `PROPOSED` so the two are never
> confused.

This supersedes the line in `docs/replit-deployment.md` that records *"No container
runtime available in Replit environment"*. A **rootless** runtime now exists — no
Docker daemon, no root, no sudo. `docs/replit-deployment.md` is deliberately left
unchanged by this work.

## Purpose and status

`lib/worker-runtime` needs to execute untrusted workloads inside a container
boundary on a host with **no Docker daemon and no root**. Two rootless kinds are
available, exposed as `RootlessRuntimeKind = "userns" | "udocker"`
(`lib/worker-runtime/src/rootlessRuntime.ts:5`):

- `userns` — kernel **user namespace + PID + mount + net namespaces + `chroot`**.
  A real isolation boundary.
- `udocker` — OCI-image compatibility via **PRoot P1 mode**. Convenient, but
  **not** a security boundary.

| Item | State |
|---|---|
| `userns` unshare + chroot execution | `IMPLEMENTED` + `VERIFIED` (`rootlessBackend.ts`; real-userns tests in `rootlessBackend.test.ts`) |
| cgroup v2 `pids.max` / `memory.max` rootless | `IMPLEMENTED` + `VERIFIED` (`cgroup.ts`; real rootless `pids.max` test in `cgroup.test.ts`) |
| PRoot static binary | `VERIFIED` by hand on 2026-10-09 (transient; no in-repo execution test) |
| udocker install (venv + `pip install udocker` + `udocker install`) | `IMPLEMENTED` (`scripts/src/rootless/install.ts`); unit-tested in `scripts/src/rootless/install.test.ts` |
| `buildRootlessInvocation` / `detectRootlessRuntime` | `IMPLEMENTED` (`rootlessRuntime.ts`); unit-tested in `rootlessRuntime.test.ts` |
| `rootless:install` package script | `IMPLEMENTED` (`scripts/package.json`); tested in `scripts/src/rootless/install.test.ts` |
| `OPENNODE_EXECUTION_BACKEND` selector | `PROPOSED` (not wired) |
| cgroup integration into the worker backend | `IMPLEMENTED` (`rootlessBackend.ts` calls `createCgroupConfigFromLimits`; the cgroup primitive is `VERIFIED` by `cgroup.test.ts`) |

## Host capability matrix

Measured on `Linux repl 6.18.55 #Replit-Linux SMP ... x86_64`, user `uid=1000(runner)`,
`REPLIT_DISABLE_DOCKER=1`, outer userns map `0 10000 65536`.

| Capability | Status | Evidence |
|---|---|---|
| Unprivileged user namespaces (`unshare --user --map-root-user`) | ✅ | `rootlessBackend.test.ts` real-userns integration (uid 0 inside) |
| PID namespace (`--pid --fork`, PID 1 inside) | ✅ | `rootlessBackend.test.ts` (process-group kill of a userns workload) |
| Mount namespace (`--mount`) + `tmpfs`/`ramfs`/`overlayfs` | ✅ | hand-verified 2026-10-09 (transient) |
| cgroup v2 delegation: `pids.max`, `memory.max` writable + enforced rootlessly | ✅ | `cgroup.test.ts` (real rootless `pids.max` enforcement) |
| Combined cgroup + userns sandbox | ✅ | hand-verified 2026-10-09 (transient) |
| PRoot (static v5.5.0) | ✅ weak | hand-verified 2026-10-09 (transient) |
| udocker with OCI images (PRoot P1 default for x86_64) | ✅ | install only: `scripts/src/rootless/install.test.ts`; execution hand-verified 2026-10-09 (transient) |
| Mount `/proc` inside a user namespace | ❌ `mount proc: EPERM` | hand-verified 2026-10-09 (transient) |
| udocker real-namespace modes (runc R1/R2/R3) | ❌ `mount proc:/proc ... operation not permitted` | hand-verified 2026-10-09 (transient) |
| Docker daemon | ❌ disabled (`REPLIT_DISABLE_DOCKER=1`) | host config |
| `nft` / netfilter | ❌ `nft` not on `PATH`; effective caps only `CapEff: 0000000000000020` | host probe; see "Not yet done" |
| Rootless net helpers (`slirp4netns`, `fuse-overlayfs`, `podman`) | ❌ absent | host probe |
| `newuidmap` / `newgidmap` | ❌ missing (subuid/subgid range exists but unused) | host probe |

## The two runtime kinds

### `userns` — strong isolation (VERIFIED)

`unshare` maps the caller to root **inside a new user namespace**, then creates
PID, mount, and net namespaces and `chroot`s into a prepared rootfs. With the
prefix installed per "Install and use" below, the invocation is:

```
unshare --user --map-root-user --pid --fork --mount --net chroot <repo>/.local/rootless/rootfs /bin/sh -c 'id; echo hi; ls /; echo "shell_pid=$$ ppid=$PPID"'
```

Output (hand-verified 2026-10-09, transient): `uid=0(root) gid=0(root)`,
`shell_pid=1 ppid=0`.

The rootfs is built from a **static** busybox (a raw download is not executable —
`chmod +x` is required). This is now automated:

```
pnpm --filter scripts run rootless:install   # builds <repo>/.local/rootless/rootfs from the pinned busybox
```

The installer pins the busybox by sha256
`6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348`
(`scripts/src/rootless/install.ts`); a mismatch aborts the install
(`scripts/src/rootless/install.test.ts`).

`lib/worker-runtime/src/rootlessRuntime.ts:46-64` emits the same argv
(`unshare --user --map-root-user --pid --fork --mount --net chroot <rootfs> ...`),
and `detectRootlessRuntime` requires `/usr/bin/unshare` **and** an existing
rootfs (symbol `detectRootlessRuntime`; unit-tested in
`rootlessRuntime.test.ts`).

**cgroup v2 limits.** The limits are not part of the `unshare` argv; the backend
must place the child in a delegated cgroup. `lib/worker-runtime/src/cgroup.ts`
(`CgroupManager`) implements this, and `rootlessBackend.ts` builds the limits via
`createCgroupConfigFromLimits`. Enforcement of `pids.max` was hand-verified on
this host (transient): a fork loop printed `sh: 0: Cannot fork`, `enforce_rc=2`.

**`cgroup.subtree_control` requirement.** A child cgroup only receives
`pids.max`/`cpu.max`/`memory.max` if its **parent** already lists those
controllers in `cgroup.subtree_control`. On this host the root
`cgroup.subtree_control` is `cpu memory pids` (`io` is **not** delegated), so
`CgroupManager.ensureRoot()` enables `+cpu +memory +pids` on
`<root>/worker-runtime/cgroup.subtree_control` before `create()`. Without that
step `create()` fails and the real cgroup test self-skips (its
`isCgroupV2Writable()` probe returns false). A `cgroup.test.ts` run that passes
rather than skips is therefore evidence the enable step ran.

### `udocker` — OCI-image compatibility, NOT a boundary (VERIFIED)

`udocker` runs real OCI images without a daemon. On x86_64 the default execution
mode is PRoot **P1**:

```
default_execution_modes = {'x86_64': 'P1', 'x86': 'P1', 'arm64': 'P1', 'arm': 'P2', 'ppc64le': 'R1', 'DEFAULT': 'R1'}
```

Install and run (the installer targets `<prefix>`, default
`<repo>/.local/rootless/`, so the launcher is
`<prefix>/udocker-venv/bin/udocker`):

```
pnpm --filter scripts run rootless:install
BASE=<repo>/.local/rootless
export HOME="$BASE/home"
"$BASE/udocker-venv/bin/udocker" pull hello-world
"$BASE/udocker-venv/bin/udocker" pull alpine:3.19
"$BASE/udocker-venv/bin/udocker" run alpine:3.19 sh -c 'echo hi; id'
"$BASE/udocker-venv/bin/udocker" run --hostauth hello-world   # plain `run hello-world` fails on scratch
```

`--hostauth` is required for `FROM scratch` images (no `/etc/passwd`/`/etc/group`
inside): a plain `udocker run hello-world` exits **2** with
`Error: invalid host volume path`, while `--hostauth` prints `Hello from Docker!`
and exits **0**. `lib/worker-runtime/src/rootlessRuntime.ts:31-45` always passes
`--hostauth`, bind-mounts the work dir at `/workspace`, and sets `--workdir
/workspace`.

## Threat model: what each kind actually isolates

Honesty is the point of this section. The `userns` kind is the trust boundary.
The `udocker`/PRoot kind is a compatibility layer, never a boundary.

| Property | `userns` | `udocker` (PRoot P1) |
|---|---|---|
| Kernel namespace isolation | ✅ user + PID + mount + net | ❌ none — PRoot `ptrace` emulation |
| UID inside | 0 (mapped into the new userns) | 0 **faked** via `ptrace`; kernel `Uid: 1000` |
| Host PID table | separate PID namespace (PID 1) | **shared** — `pid:[4026532708]` identical to host |
| Host network | separate netns | **shared** — `net:[4026532710]` identical to host; DNS + TCP 443 work |
| Filesystem root | `chroot` rootfs; host paths unreachable | per-container `~/.udocker/containers/<id>/ROOT`; host `/` not visible |
| `/proc` inside | **cannot be mounted** (`mount proc: EPERM`) | shown from the per-container view |
| Security boundary? | **yes** (with the caveats below) | **no** — "not a security boundary" |

Not isolated by `userns` on this host:

- **No `/proc`.** `mount -t proc` fails with `Operation not permitted` inside the
  new userns, so process introspection that needs procfs is unavailable. PID 1
  still holds (proven by `$$` and `kill -0 1`), but `/proc/self/status` cannot be
  read from inside.
- **Empty netns.** `--net` creates a separate network namespace that contains only
  `lo`/`sit0`, both `DOWN`; DNS fails (`wget: bad address`) and loopback is
  `Network unreachable`. There is no egress unless a net helper (`slirp4netns`,
  absent) or explicit veth setup is added.
- **Faked/mapped UID.** The outer host maps `0 10000 65536`; root inside is a
  namespace mapping, not host root. Writes still land with host ownership
  (`runner:runner`) in the rootfs.

Not isolated by `udocker`/PRoot (so it must not be relied on as a boundary):

- **Host network and PID namespaces are shared.** PRoot does not create
  PID/NET/UTS/cgroup namespaces; the guest shares the host network and process table.
- **Root is cosmetic.** `id` reports `uid=0(root)` while the kernel runs the tree
  as real uid 1000 (`/proc/self/status` shows `Uid: 1000`). Real privilege
  changes (`chown`, `mknod`, mount, raw sockets) are emulated or not performed.
- **`-R` leaks host paths.** PRoot's `-R` binds host `$HOME`, `/tmp`, `/dev`,
  `/proc`, `/sys`, `/run`, and several `/etc` files; host `$HOME` is directly
  readable/writable from the guest.
- **Larger attack surface.** Every syscall is trapped via `ptrace`.

Note also the qualification carried by the hand-verification: user namespaces
+ chroot are **a building block**, not a complete sandbox without additional
hardening (dropped capabilities, seccomp, `pivot_root`, explicit mount layout).
Treat `userns` as the strongest option available here, not as equivalent to a VM.

## Install and use

**Install prefix.** Everything installs under `<repo>/.local/rootless/`
(gitignored via `.gitignore:49`, never committed). The binary resolver expects
`${prefix}/udocker-venv/bin/udocker` (symbol `udockerBinary`,
`lib/worker-runtime/src/rootlessRuntime.ts:25-27`).

**`rootless:install`.** The `rootless:install` package script in
`scripts/package.json` runs `scripts/src/rootless/install.ts`. It downloads and
sha256-verifies the pinned static busybox, builds `<prefix>/rootfs`, and (unless
`withUdocker: false`) creates the udocker venv at `<prefix>/udocker-venv`:

```
pnpm --filter scripts run rootless:install
```

Run a workload with the resulting launcher:

```
BASE=<repo>/.local/rootless
export HOME="$BASE/home"
"$BASE/udocker-venv/bin/udocker" run alpine:3.19 sh -c 'echo hi; id'
"$BASE/udocker-venv/bin/udocker" run --hostauth hello-world   # plain `run hello-world` fails on scratch
```

**Backend selection (PROPOSED, not wired).** `OPENNODE_EXECUTION_BACKEND` would
select the runtime kind (`userns` or `udocker`). The value must satisfy
`detectRootlessRuntime` before a run starts: `userns` needs `/usr/bin/unshare`
plus an existing rootfs; `udocker` needs the launcher under the install prefix.
The production `artifacts/api-server` still constructs `IsolatedProcessBackend`
(`artifacts/api-server/src/lib/runtime.ts`), so no production caller selects
`RootlessBackend` yet (`docs/threat-model.md` EXEC-01).

**Verification commands.** Any change here is not done until `pnpm exec vitest run <file>`, `pnpm run typecheck`, and `pnpm run check:ci` all pass (see `.opencode/skills/opennode-evidence-pipeline/SKILL.md`).

## Evidence index

The durable evidence is the named in-repo tests below; earlier `/tmp` transcript
files were transient scratch output and no longer exist. Run a single file with:

```
pnpm exec vitest run lib/worker-runtime/src/rootlessRuntime.test.ts
pnpm exec vitest run lib/worker-runtime/src/rootlessBackend.test.ts
pnpm exec vitest run lib/worker-runtime/src/cgroup.test.ts
pnpm exec vitest run scripts/src/rootless/install.test.ts
```

- `lib/worker-runtime/src/rootlessRuntime.test.ts` — `udockerBinary`,
  `buildRootlessInvocation` (udocker and userns argv), and `detectRootlessRuntime`.
- `lib/worker-runtime/src/rootlessBackend.test.ts` — `RootlessBackend` unit
  behavior via the `invocationFactory` seam, plus a real `unshare` userns
  integration suite (skipped only when the rootfs is absent).
- `lib/worker-runtime/src/cgroup.test.ts` — real rootless cgroup v2 `pids.max`
  enforcement; passes (not skipped) on this host because `ensureRoot()` enables
  the controllers.
- `scripts/src/rootless/install.test.ts` — pinned-sha256 fetch rejection,
  busybox rootfs build, and udocker venv install ordering.

## Not yet done

- **`OPENNODE_EXECUTION_BACKEND` is unwired.** No production path selects
  `RootlessBackend`; `artifacts/api-server` still uses `IsolatedProcessBackend`
  (`artifacts/api-server/src/lib/runtime.ts`; `docs/threat-model.md` EXEC-01).
- **No `/proc` in the userns sandbox**; no fix found on this kernel.
- **Empty `--net` netns** — no egress; no `slirp4netns`/`fuse-overlayfs` installed.
- **No network policy enforcement** — `nft` absent, effective caps lack
  `CAP_NET_ADMIN`; `NetworkPolicy` is declaration-only (EXEC-05).
- **Image digest verification** (`image.digest`) is not implemented (EXEC-02/04).
- **`newuidmap`/`newgidmap` absent**, so the `runner:100000:65536` subuid range is
  unused.
- **`udocker` must never be presented as a security boundary.** It shares host
  PID/net and fakes uid; only `userns` provides a real boundary.
