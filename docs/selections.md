# OpenNode Architecture Selections

> ⚠️ **The repository is under active development.** Several claims in this
> document went stale within hours of being written — `lib/peernet/src/libp2pTransport.ts`
> appeared after the first draft had correctly reported that no production transport
> existed. Every factual claim below was verified against source on **2026-10-09**; treat
> unverified specifics as suspect and re-check before relying on them.

> **STATUS (domain review): selections here were recorded as *decided*, but two of
> them are not selected — they are interface sketches with no implementation behind
> them.** Slice 0 requires "Select candidate peer-network and consensus
> implementations. Record why they fit... require a maintained, reviewed
> implementation rather than custom consensus." That item is **still open**.
>
> Each selection below now carries an **Actual state** and the requirement that
> must be satisfied to make it real (`todo.md` D10, NET-01, SYNC-01).

---

## Peer Network: `lib/peernet` — **NOT SELECTED**

> ⚠️ **UPDATED.** An earlier draft of this document stated that no production
> transport existed and that `InMemoryPeerTransport` was the only
> `implements PeerTransport`. **That was correct when written and is now stale.**
> `lib/peernet/src/libp2pTransport.ts` has since been added. Re-verify before citing.

**Actual state: an implemented-but-unwired libp2p transport, plus an in-memory test double.**

### What exists

- `Libp2pPeerTransport` (`lib/peernet/src/libp2pTransport.ts`) — ~13 KB implementing
  `PeerTransport` over libp2p: Noise, yamux, QUIC, WebSocket/WebTransport, bootstrap,
  kad-dht, circuit-relay-v2, identify, ping, autoNAT. **It has zero external callers** —
  it is never instantiated by the server, so the only transport reachable at runtime is
  the in-memory one. It also cannot yet be typechecked: the barrel is absent from the root
  `tsconfig.json` reference graph, and its `@libp2p/*` imports are not declared in
  `lib/peernet/package.json`.
- `PeerTransport` interface (`lib/peernet/src/transport.ts`) — 193 lines, including real
  `createDefaultConfig` and `createRateLimitedGater` implementations, not only types.
- `InMemoryPeerTransport` (`lib/peernet/src/inMemory.ts`) — process-local `Map` transport
  for tests; `createInMemoryPair` itself has no callers.
- Signed-handshake, replay-protection, membership-certificate, and relay modules —
  structurally correct, but as shown below, security-critical paths are inert.

### Claims previously recorded as satisfied — corrected

| Criterion | Previously claimed | Actual |
|---|---|---|
| Pure TypeScript, no native bindings | ✅ | ✅ Still true. |
| In-process testable | ✅ | ⚠️ True but **trivially** — nothing runs over a real socket, so no test can exercise TLS, NAT, framing, or backpressure. |
| No external deps | ✅ | ✅ Still true. |
| Pluggable adapters (libp2p, WebRTC, relay) | ✅ | ⚠️ A libp2p adapter now exists and is comprehensive, but is **never instantiated** and is outside the typecheck graph. Implemented ≠ selected ≠ deployed. |
| Handshake verifies membership certificate before protected data | ✅ | ❌ `authorizePeerAccess` has **zero call sites**; `connect()` never authenticates. **NET-04, NET-06** |
| "Developed in-repo; security-relevant code is small and auditable" | ✅ | ❌ Auditable, yes — and the audit found the security-critical path is **forgery, not protection**: production signing is `hash(NodeId + msg)` and the NodeId is public. **NET-01** |
| Rate limiting on handshake/discovery | ✅ | ❌ Keyed on attacker-supplied NodeId before verification; buckets never evicted. **NET-05** |
| Protocol negotiation prevents downgrade | ✅ | ❌ `Math.min(local.max, remote.max)` — the lowest common version always wins. **NET-13** |

### Blockers before this can be selected

1. ~~**Choose a maintained networking stack.**~~ **DONE — libp2p.** Record its
   threat properties (relay trust: NET-12) and confirm the selection (D10).
2. **Wire `Libp2pPeerTransport` into the server bootstrap** and move the in-memory
   double to a `testing` entrypoint that production bundles cannot import. Also
   bring `lib/peernet` into the root `tsconfig.json` reference graph and declare its
   `@libp2p/*` dependencies so the transport is actually typechecked (NET-01, OPS-19).
3. **Replace the forgeable signature** with an asymmetric scheme bound to the
   keystore identity (NET-02, SYNC-13).
4. **Make bootstrap peers configurable.** No env var, CLI flag, or config file
   references bootstrap or relay peers today — `lib/peernet/src/bootstrap.ts` is a
   library nothing configures (NET-11).
5. **Prove it with a two-process integration test over real sockets.** Release gates
   must not accept an interface as evidence of connectivity (NET-01).

### Rejected alternatives (assessment unchanged)

- **libp2p direct** — heavy dependency graph; leaks types into domain. *Reconsider:
  the current alternative (no transport at all) is not viable, and libp2p ships
  circuit relay, connection manager, and Noise — all of which are required by
  NET-10 and NET-12 and would otherwise be hand-built.*
- **Custom WebSocket/TCP** — re-invents auth, replay protection, negotiation. Agreed.
- **gRPC/Connect** — assumes a central endpoint. Agreed.

---

## Consensus: `lib/sync-engine` — **NOT SELECTED; CURRENT CODE IS CUSTOM CONSENSUS**

**Actual state: a bespoke single-writer append log.** This directly violates the
requirement that no custom consensus protocol be in production.

### The critical finding

`EventLog.appendEvent` (`lib/sync-engine/src/eventLog.ts`) reads the tip, validates
`sequence === height`, then appends — separated by `await` points with **no mutex
and no compare-and-set on `(height, prevHash)`**.

This is not "an adapter over a proven engine". It is a consensus protocol: a
single-writer ordered log with a total order and no quorum. Two healthy peers each
appending locally produce **identical sequence numbers with different content** —
a textbook split-brain. There is no leader, no term, no quorum, no finality, and no
replication.

The previous version of this document claimed "no custom consensus protocol code
exists in the codebase." **That claim is false.** Release Gate 1 was corrected to
**NOT MET** on this basis.

### Claims previously recorded as satisfied — corrected

| Criterion | Previously claimed | Actual |
|---|---|---|
| Pure TS, zero side effects in validators | ✅ | ✅ `validateEntry` / `validateEntryChain` are genuinely pure. |
| Deterministic validation | ✅ | ⚠️ Correct for a **single** entry, but `stableStringify` includes keys whose value is `undefined`, so hashes are **not reproducible across a JSON transport hop**. Catch-up deterministically fails for any event with an optional field. **SYNC-11** |
| "Does not implement leader election, log replication, or quorum" | ✅ | ✅ Literally true — and that is the problem. Nothing else implements them either. |
| "The consensus engine is a separate, maintained, reviewed implementation" | ✅ | ❌ **No such engine exists, is selected, or is wired.** |
| Snapshots signed per consensus protocol | ✅ | ❌ `approved` is a **self-asserted boolean** signed by any one peer. **SYNC-07** |
| Catch-up with Merkle reconciliation, resumable transfer | ✅ | ❌ `runCatchUp` has **zero call sites**; resume is not implemented; chunk size is never negotiated. **SYNC-05** |
| Pluggable adapter | ✅ | ❌ `EventLogStore` has one implementation, `MemoryEventLogStore` — in-memory, lost on restart. |

### The interface (unchanged, but note it is not sufficient)

```typescript
interface EventLogStore {
  getHeight(): Promise<number>;
  getEntry(sequence: number): Promise<SignedLogEntry | undefined>;
  getRange(fromInclusive: number, toExclusive: number): Promise<SignedLogEntry[]>;
  append(entries: readonly SignedLogEntry[]): Promise<void>;
  truncateTo(height: number): Promise<void>;
  replace(entries: readonly SignedLogEntry[]): Promise<void>;
}
```

This interface **cannot express consensus**: it has no term, no leader, no quorum
acknowledgement, and no compare-and-set on the append path. A Raft-family engine
cannot be correctly adapted to it without extending it — and `append()` as written
permits the non-atomic double-append that breaks the chain (SYNC-02).

### Blockers before this can be selected

1. **Select a maintained consensus engine** and record why it fits the runtime and
   membership model (D9, D10).
2. **Extend the adapter interface** to carry term/leader/quorum and expose a
   compare-and-set append; a single-writer in-process append must be gated behind a
   build flag that disables run submission (SYNC-01).
3. **Make the log durable.** It is in-memory only, so all committed height, leases,
   and membership are lost on restart (SYNC-01, RUN-13).
4. **Serialize appends** with compare-and-set on `(height, prevHash)`, surfacing
   `SEQUENCE_GAP` rather than silently concatenating (SYNC-02).
5. **Resolve signers from the committed membership key set.** Today the verifier
   trusts exactly one signer, so cross-node catch-up always fails (SYNC-13).
6. **Prove Gate 1** with an integration test that exercises duplicate, reordered,
   replayed, and torn delivery — none of which has a test today (OPS-01).

### Rejected alternatives (assessment unchanged)

- **Custom Raft** — high risk; exactly what `eventLog.ts` has become. Rejected
  means **replaced**, not kept.
- **etcd/raft directly in domain** — leaks consensus types into the domain core.
  Agreed; keep the adapter boundary.
- **CRDT/Automerge only** — eventual consistency is insufficient for membership and
  leases. Agreed.

---

## Summary

| Layer | Previous claim | Correct status | Requirement |
|---|---|---|---|
| Peer Network | Selected: in-memory + pluggable | **Adapter written, not wired** | NET-01, NET-02, PROV-03, D10 |
| Consensus | Selected: adapter, no custom consensus | **Not selected** — current code *is* custom consensus | SYNC-01, SYNC-02, D9, D10 |

Both slice-0 selection items remain **open**. The interfaces are reasonable and
worth keeping as boundaries; what is missing is an implementation behind each.

**Recommended order:** wire the transport and prove it (NET-01, PROV-03) and select
a consensus engine (SYNC-01) together. Until both exist, no peer-network test result
is meaningful, because cross-node catch-up cannot succeed against a single-signer
in-memory log, and an uninstantiated transport is not a control.

---

*Requirements: `todo.md`. Gates: `docs/release-gates.md`. Threat model:
`docs/threat-model.md`.*
