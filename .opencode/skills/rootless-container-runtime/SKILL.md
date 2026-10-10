---
name: rootless-container-runtime
description: Install, run, and troubleshoot rootless containers (udocker OCI images over PRoot, unshare userns+chroot, cgroup v2 limits) on this Replit/Ubuntu host with no Docker daemon; use when a task must execute a container/workload here, when rootless setup fails with EPERM/EACCES, or when auditing the worker isolation boundary.
---

# Rootless container runtime

No Docker daemon, no root, no sudo on this host (`REPLIT_DISABLE_DOCKER=1`).
Two verified rootless paths: `udocker` (OCI images, PRoot P1 — **not** a security
boundary) and `unshare` userns+chroot (strong isolation). Design details and the
host capability matrix: `docs/rootless-containers.md`. Durable evidence is the
named tests: `lib/worker-runtime/src/{rootlessRuntime,rootlessBackend,cgroup}.test.ts`
and `scripts/src/rootless/install.test.ts`.

## Procedure

1. Install everything under the gitignored prefix `<repo>/.local/rootless/`
   (`<prefix>/udocker-venv/bin/udocker` is what the resolver expects).

2. Install udocker with the real package script (implemented by
   `scripts/src/rootless/install.ts`):

   ```
   pnpm --filter scripts run rootless:install
   ```

   The equivalent manual sequence the script performs, using the gitignored
   prefix rather than `/tmp`:

   ```
   BASE=<repo>/.local/rootless
   export HOME="$BASE/home"
   python3 -m venv "$BASE/venv"
   "$BASE/venv/bin/python" -m pip install udocker
   "$BASE/venv/bin/udocker" version
   "$BASE/venv/bin/udocker" install
   "$BASE/venv/bin/udocker" pull alpine:3.19
   ```

3. Build a userns rootfs from a **static** busybox. Prefer the installer — it
   downloads, sha256-verifies, `chmod +x`es, and symlinks the applets. If you
   fetch by hand, a raw download is not executable: `chmod +x` it and verify the
   sha256 is `6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348`.

   ```
   BIN=$BASE/busybox
   curl -fSL -o "$BIN" https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox
   chmod +x "$BIN"; sha256sum "$BIN"; "$BIN" echo ok
   ```

4. Run **udocker** (OCI image) — always pass `--hostauth`:

   ```
   "$BASE/venv/bin/udocker" run alpine:3.19 sh -c 'echo hi; id'
   "$BASE/venv/bin/udocker" run --hostauth hello-world   # plain `run hello-world` fails on scratch
   ```

5. Run **userns** (strong isolation):

   ```
   unshare --user --map-root-user --pid --fork --mount --net chroot <prefix>/rootfs /bin/sh -c 'id; echo hi; ls /; echo "shell_pid=$$ ppid=$PPID"'
   ```

### 6. Add cgroup v2 limits (subtree_control delegation)

A child cgroup only exposes `pids.max` / `cpu.max` / `memory.max` when its
**parent** lists those controllers in `cgroup.subtree_control`. On this host
`/sys/fs/cgroup/cgroup.subtree_control` is `cpu memory pids` — `io` is **not**
delegated — so `mkdir` alone yields a child with no writable limit files.
Enable the controllers on the parent subtree first (idempotent: use
`cgroup.controllers` minus current `cgroup.subtree_control`), then create the
child. `CgroupManager.ensureRoot()` (`lib/worker-runtime/src/cgroup.ts`) does
exactly this.

```
PARENT=/sys/fs/cgroup/evalbox.$$; CG=$PARENT/child
mkdir -p $CG
printf '+cpu +memory +pids' > $PARENT/cgroup.subtree_control   # enable on the PARENT
echo 64 > $CG/pids.max; echo 64M > $CG/memory.max
echo pids.max=$(cat $CG/pids.max) memory.max=$(cat $CG/memory.max)
```

When placing a shell into the cgroup, `spawn(shell)` can fork children **before**
the move-in and orphan them outside the cgroup — insert a short `sleep` before
the fork loop so the `cgroup.procs` write lands first:

```
sh -c "sleep 0.2; echo \$\$ > $CG/cgroup.procs; for i in 1 2 3; do sleep 30 & done; echo spawned"
```

To remove it, first `echo 1 > $CG/cgroup.kill` (or kill all members), then
`rmdir`; a plain recursive `rm` does not empty a populated cgroup:

```
echo 1 > $CG/cgroup.kill; rmdir $CG; rmdir $PARENT; echo cleanup_ok
```

## Failure modes actually observed

- child cgroup missing `pids.max` / `cpu.max` → the parent's `cgroup.subtree_control`
  does not list the controller; `lib/worker-runtime/src/cgroup.test.ts` then
  silently **SKIPS** (via `describe.skipIf`) instead of failing, so broken
  delegation looks green.
- `unshare ... --mount-proc` / `mount -t proc` → **`mount proc: operation not permitted`** (EPERM). `/proc` is unavailable inside the userns; PID 1 still works (use `$$`, `kill -0 1`).
- udocker plain run → **`Error: invalid host volume path`** (exit 2) on `FROM scratch` images; use `--hostauth`.
- busybox download is non-executable → **`chmod +x`** (and verify the sha256).
- bubblewrap fails with `Unexpected capabilities but not setuid` → prefix with **`setpriv --inh-caps=-all --ambient-caps=-all`**.
- `--net` gives an **empty netns**: only `lo`/`sit0`, both DOWN; DNS and TCP fail. No egress.
- udocker real-namespace modes (runc R1/R2/R3) fail: `mount proc:/proc ... operation not permitted`.
- `unshare --setenv` is unsupported (util-linux 2.39.3); set env before `unshare`.

## Verification

```
pnpm exec vitest run lib/worker-runtime/src/cgroup.test.ts
pnpm run typecheck
pnpm run check:ci
```

`udocker` shares the host PID/net namespaces and fakes uid — never treat it as a
security boundary. Only `userns` is one, and even then without `/proc` or network.
