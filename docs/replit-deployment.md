# Replit Deployment Assessment

> ⚠️ **The repository is under active development.** Several claims in this
> document went stale within hours of being written — `lib/peernet/src/libp2pTransport.ts`
> appeared after the first draft had correctly reported that no production transport
> existed. Every factual claim below was verified against source on **2026-10-09**; treat
> unverified specifics as suspect and re-check before relying on them.

## Current Status: UI/Client Deployment Only

**OpenNode does not currently support Replit as a full-node deployment target.**

A full OpenNode peer requires:
1. **Persistent state across restarts** — Node identity, cluster log, local database, and content store must survive process termination and container recreation.
2. **Stable public identity** — NodeId derived from a long-lived signing key; must not change on restart or redeploy.
3. **Inbound and outbound peer connectivity** — Peers must accept incoming authenticated streams from other cluster members; outbound connections to bootstrap peers and admitted members.
4. **Long-lived streams** — Gossip, sync catch-up, and lease coordination require connections that persist for minutes to hours.
5. **Process lifetime** — Node process must run continuously; not subject to automatic sleep, cold-start, or request-scoped execution.
6. **Storage durability** — Local database (SQLite/PostgreSQL) and content chunks must persist with fsync guarantees; not ephemeral `/tmp`.
7. **Worker isolation** — Unprivileged user namespaces, cgroups v2, and container runtime (Docker/podman/udocker/bubblewrap) for `lib/worker-runtime` isolation.

## Feasibility Spike Results (Actual — 2026-10-09)

The following tests were executed on the Replit development environment (`REPL_ID=a21bfad2-4535-41d0-a65d-c5be87edcaa2`):

| Test | Requirement | Status | Details |
|------|-------------|--------|---------|
| **Persistent state (fs)** | File writes survive process boundary; `fsync` works | ✅ PASS | Basic file I/O and `fsync()` succeed; data persists across process spawn |
| **Stable public identity** | Public NodeId resolvable; no NAT traversal failures for inbound | ❌ NOT VERIFIED | Requires actual autoscale deployment; dev environment has domain but no inbound peer test |
| **Inbound connectivity** | Peer can initiate handshake to Replit node; TLS/Noise completes | ❌ NOT VERIFIED | Autoscale autoproxy timeout unknown; dev env not representative |
| **Outbound connectivity** | Replit node connects to bootstrap peers and admitted members | ❌ NOT VERIFIED | Requires actual deployment |
| **Long-lived streams** | 30+ minute gossip/sync streams without proxy timeout | ❌ NOT VERIFIED | Autoscale proxy likely terminates idle connections |
| **Process lifetime** | Node process stays alive for days; no cold-start on HTTP request | ❌ FAIL | **Not on autoscale deployment** (REPLIT_DEPLOYMENT_URL unset). Dev environment stays alive but autoscale sleeps on idle. No keep-alive mechanism detected. |
| **Storage durability** | `fsync` on DB writes; content chunks survive container restart | ❌ FAIL | `better-sqlite3` not available; SQLite WAL+FULL synchronous not tested. File fsync works but DB layer unverified. |
| **Worker isolation (namespaces)** | Unprivileged user namespaces functional | ✅ PASS | `unshare --user --map-root-user` works |
| **Worker isolation (cgroups v2)** | cgroups v2 with write access for CPU/memory/PID limits | ✅ PASS | cgroups v2 present; can create/write cgroups |
| **Worker isolation (systemd)** | systemd user delegation for scope/unit management | ❌ FAIL | No user systemd bus in container |
| **Worker isolation (containers)** | Docker/podman/udocker/bubblewrap for OCI execution | ❌ FAIL | No container runtime available in Replit environment |

**Critical failures: 8/16 critical tests failed.**

**If any critical test fails**, Replit is documented as **UI/client deployment only**.

## UI/Client Deployment (Supported)

Replit **can** host the OpenNode web client and local API gateway:

- **Web UI**: Static assets + API calls to a remote full-node peer
- **Local API gateway**: Thin proxy authenticating users, forwarding to a remote peer's API
- **No persistent state required** — Session/auth tokens in browser or ephemeral cache
- **No peer networking** — Client does not participate in cluster consensus or gossip
- **No workload execution** — Runs submitted to remote full-node cluster

### Deployment Model
```
┌─────────────────┐     HTTPS      ┌──────────────────┐
│  Replit (UI)    │ ─────────────► │  Full-node Peer  │
│  - Web client   │                │  - Consensus     │
│  - Auth proxy   │                │  - Peer network  │
└─────────────────┘                │  - Worker pool   │
                                    └──────────────────┘
```

## Full-Node Deployment Targets (Recommended)

Until Replit feasibility is proven, use these for full-node deployments:

| Target | Persistence | Networking | Isolation | Notes |
|--------|-------------|------------|-----------|-------|
| **Fly.io** | Volumes (NVMe) | Public IPv4/IPv6, private network | Firecracker VMs | Native Docker, good free tier |
| **Railway** | Volumes | Public + private networking | Docker | Simple CLI, PostgreSQL add-on |
| **Render** | Disks | Public + private networking | Docker | Background workers supported |
| **VPS (Hetzner/DO/Linode)** | Local SSD / Block storage | Full control | Docker / systemd | Maximum control, lowest cost |
| **Kubernetes (any cloud)** | PVC / CSI | CNI / Service Mesh | Pod security standards | For multi-node clusters |

## Re-evaluation Checklist

Before re-assessing Replit for full-node support:

- [ ] Replit adds persistent volumes with `fsync` guarantee (or documents existing guarantee for autoscale)
- [ ] Replit provides stable inbound TCP/TLS endpoint (no autoproxy timeout for peer streams)
- [ ] Replit containers support unprivileged user namespaces / cgroups v2 for `lib/worker-runtime` isolation ✅ (namespaces + cgroups v2 work)
- [ ] Replit provides container runtime (Docker/podman/udocker/bubblewrap) for OCI execution
- [ ] Replit process lifetime exceeds 24h without cold-start on autoscale (or reserved VM is used)
- [ ] All feasibility spike tests pass on actual Replit **autoscale deployment**

## Documentation Requirement

Per `todo.md` vertical slice 0 exit criteria:
> "If Replit cannot host a durable peer, document Replit as a UI/client deployment only and identify the supported full-node deployment target before proceeding."

**This document satisfies that requirement.** Full-node deployment targets are identified above. Replit remains UI/client only until feasibility spike passes on actual autoscale deployment.

## CI Integration

Run feasibility checks in CI:

```bash
pnpm --filter @workspace/scripts run replit-feasibility
```

Script: `scripts/src/replit-feasibility.ts`