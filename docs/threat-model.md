# OpenNode Threat Model

> ⚠️ **The repository is under active development.** Several claims in this
> document went stale within hours of being written — `lib/peernet/src/libp2pTransport.ts`
> appeared after the first draft had correctly reported that no production transport
> existed. Every factual claim below was verified against source on **2026-10-09**; treat
> unverified specifics as suspect and re-check before relying on them.

> **STATUS (domain review): this document previously described *intended*
> mitigations as if they were implemented.** Every entry below has been re-checked
> against the code. Each mitigation now carries an **Actual state** and a
> **Requirement** reference into `todo.md`.
>
> **Summary: 0 of 8 threat classes currently has a complete mitigation.** The
> attack surface is documented; the defences are largely specification, not code.
> This document is now a gap register, not a claim of coverage.

Legend — **Actual**: `IMPLEMENTED` / `PARTIAL` / `SPEC ONLY` / `ABSENT`

---

## 1. Hostile Workload

**Threat:** Untrusted container images attempt host escape, lateral movement,
credential access, or resource exhaustion.

| Mitigation | Actual | Finding |
|---|---|---|
| Workload runs in a process separate from the UI/API | `SPEC ONLY` | Vacuously true — **no workload executes at all**. The only backend is `IsolatedProcessBackend` (`kind = "isolated_process_stub"`), which creates a temp directory and two `setTimeout` callbacks. No `spawn`, no OCI runtime, no namespace. **EXEC-01** |
| Deny-by-default network egress | `ABSENT` | **CORRECTION:** `validateWorkerSpec` *does* read both booleans and rejects the spec unless each is `true` (`spec.ts:93-94`), and `workerSpecFromRun` sets both to `true` (`executionProvider.ts:26-27`) — so the declaration is honoured. The real defect is that **nothing acts on the decision**: `hostIsMetadata` is hostname-string matching, there is no enforcement point at the isolation boundary, and `allowedEgressHosts` is hardcoded `[]`, so an `allowlist` request fails validation rather than being applied. **EXEC-05** |
| CPU/memory/PID/disk/time/output limits enforced outside the workload | `PARTIAL` | **CORRECTION:** wall-clock *is* enforced — `lib/worker-runtime/src/runtime.ts:71-74` arms a real `setTimeout` on `spec.limits.wallClockMs` that calls the genuine cancellation path, and it is cleared on teardown. It **is** `.unref()`'d (line 74), so it will not by itself hold the process open. The other five (`cpuMilli`, `memoryBytes`, `pidLimit`, `diskBytes`, `outputBytes`) are **never read after validation** — `spec.limits` has exactly two consumers repo-wide, the six `isPositiveInt` checks at `spec.ts:79-85` and `wallClockMs` at `runtime.ts:73`. No cgroup, quota, tmpfs, rlimit, or netfilter code exists. **EXEC-03** |
| OCI images pinned by immutable digest | `ABSENT` | No pull, resolution, or verification code. `imageDigest` is written `null` and never updated. Pinning is `false` in production config and, where implemented, a substring test. **EXEC-02, EXEC-04** |
| Short-lived registry credentials never exposed to the workload | `ABSENT` | No registry or credential logic exists in `spec.ts` or any worker file. **EXEC-02** |
| Secret broker delivers job-scoped values only to an authorized worker | `ABSENT` | The broker is **unreachable from the run path** — `secretRefs` is hardcoded `[]` and `env.entries` is hardcoded `[]`. The wired implementation (`src/index.ts`) has no attempt/cluster/lease scope; the hardened one (`secret-broker.ts`) is dead code. Worker identity is an unsigned shape check. **SEC-01, SEC-02, EXEC-11** |
| Container hardening contract (non-root, no-new-privileges, seccomp, read-only rootfs) | `ABSENT` | `WorkerSpec` has no field for any hardening property, so a backend cannot be told to drop privileges. **EXEC-06** |

**Additional exposure found in review:** artifacts sit unencrypted in an unbounded
process-global `Map`, served by a guessable ID with **no authorization check**. The write
path (`storeArtifact`) currently has no caller, so this is **latent rather than live** —
but the read endpoints are real, unauthenticated, and `/runs/artifacts/:chunkId` does not
even confirm the run exists. **EXEC-17**

**Residual risk: TOTAL.** Any container runtime introduced later inherits that
runtime's defaults (root, full capabilities, writable rootfs) with no contract to
stop it.

---

## 2. Malicious Peer

**Threat:** A peer sends forged handshakes, replays old messages, floods
discovery/handshake endpoints, or attempts protocol downgrade.

| Mitigation | Actual | Finding |
|---|---|---|
| Signed handshakes bind cluster ID, NodeId, protocol range, nonce, expiry | `SPEC ONLY` | The *structure* exists. The *signature* does not: production `sign()` is `hash(NodeId + ":" + msg)`. The NodeId is public (gossip, projections, `PeerMessage.sender`), so **anyone who has seen it can forge any signature with no secret**. **NET-01, NET-02** |
| `verifyHandshake` enforces cluster match, timestamp validity, signature, nonce uniqueness | `PARTIAL` | Structure is correct; signature check is meaningless per above. Rejects `issuedAt > now` with **zero skew tolerance**, so a node 30 s ahead self-partitions. **NET-13** |
| Nonce cache rejects reused nonces | `PARTIAL` | **Corrected:** `createNonceCache` has **zero callers** outside its own module — it is never constructed in the server, so the property is real but unexercised. Within the module, the cache is populated with the **remote's** `expiresAt`, which is unbounded — a peer presenting a far-future expiry pins entries forever and evicts legitimate nonces. **NET-13, PROV-03** |
| Rate limiter throttles per remote identity | `ABSENT` | The limiter keys on `handshake.nodeId.value` — a **free-form string the caller supplies** — *before* signature verification. A Sybil mints a fresh NodeId per handshake and gets a fresh allowance, while growing the bucket map without bound. **NET-05** |
| Protocol negotiation selects highest common version, no downgrade below minimum | `ABSENT` | `negotiateProtocol` returns `Math.min(local.max, remote.max)` — the **lowest common version always wins**, which is a downgrade oracle. There is no cluster-configured minimum. **NET-13** |
| Membership certificate verified before protected data access | `ABSENT` | `authorizePeerAccess` has **zero call sites**. `connect()` opens a connection and marks it connected **without any authentication step**. **NET-04, NET-06** |
| Domain logic never sees transport types | `IMPLEMENTED` | The `PeerTransport` interface boundary is genuinely respected. |

> ⚠️ **This whole section is unwired.** `Libp2pPeerTransport` and
> `InMemoryPeerTransport` both have zero callers, so no `PeerTransport` is instantiated
> at runtime and `verifyHandshake` is reached only from the in-memory double's
> `authenticate`. The rows above grade the *code*; none of it is a deployed control. The
> only genuinely live defence in this section is the interface boundary itself. **PROV-03**

**Additional exposure:** peer messages carry `{topic, payload, sender, sentAt}` — no
signature, no cluster ID, no epoch, no nonce, no topic allowlist, no size limit.
Any connected peer can publish arbitrary payloads attributed to any sender into
any topic. Gossip messages are likewise unsigned and `originId` is not bound to
`rumorId`, so capacity and presence can be forged and skewed into scheduling.
**NET-03, NET-07**

**Residual risk: TOTAL.** A hostile peer needs no secret material to impersonate
any node.

---

## 3. Compromised Node

**Threat:** An admitted node's key is stolen or the node is coerced; attacker
issues fake votes, leases, or cluster events.

| Mitigation | Actual | Finding |
|---|---|---|
| `fenceOnEpochChange` revokes leases bound to prior epochs | `PARTIAL` | The registry function exists, but the **mirrored lease record discards the fencing token**, and `fenceOnMembershipChange` has no caller. Invalidation ignores `subjectId` and `cause`: any unrelated admission fences every in-flight lease cluster-wide, while **voluntary leave fences nothing**. **RUN-19** |
| Membership decisions require consensus commit | `ABSENT` | The domain is mutated **before** the log append. On failure the domain has advanced, the proposal is marked committed, and it can never be retried. **GOV-13** |
| Voluntary leave fences nothing | `PARTIAL` | **CORRECTION:** leave *does* reach `fenceOnEpochChange` — `applyFromLog` (`lib/membership-log/src/core.ts:470-472`) fires on epoch advancement, which `commitLeave` (`:362`) and the route's `reconcile` (`routes/membership.ts:354`) both trigger. The real defect is narrower: `runtime.ts:241-244` implements `invalidate` as a **zero-argument function** discarding `subjectId`/`cause`, so it is subject-blind (any unrelated admission fences every lease cluster-wide) and premature (it reads the pre-leave epoch, fencing nothing for the leaver). |
| Admission/eviction thresholds from frozen electorate | `PARTIAL` | The electorate is frozen in memory, but the committed event **self-asserts** the denominator and yes-count; replay never cross-checks against committed membership. **GOV-02** |
| Ballots are signed and bound to voter identity | `ABSENT` | The default verifier is `typeof signature === "string" && length > 0`. Any electorate member can be impersonated. **GOV-03** |
| Node refuses to start on identity collision | `ABSENT` | `ensureNodeIdentity` / `assertNoNodeIdCollision` have zero callers. The identity table is never written; `local_node_identity` is only ever `SELECT`ed. **NET-02** |
| HMAC prevents a verifier from forging | `ABSENT` | Only symmetric HMAC is available, so **any node that can verify an entry can also forge it**. This inverts the intended trust property. **SYNC-13** |
| Key rotation with additive verification set | `ABSENT` | No rotation mechanism exists. **SYNC-13** |

**Additional exposure:** the log verifier trusts exactly **one** signer, so a peer
cannot validate entries from any other node — multi-node catch-up always fails
with `SIGNATURE_INVALID`. **SYNC-13**

**Residual risk: TOTAL.** A single admitted node can forge ballots, membership
events, and any other member's log entries.

---

## 4. Lost Key

**Threat:** A node's signing key is lost; it cannot sign new events, handshakes,
or votes.

| Mitigation | Actual | Finding |
|---|---|---|
| Key backup/rotation procedures | `SPEC ONLY` | `identity.ts` implements a keystore interface correctly, but **the runtime never uses it**. The deployed key is `process.env.OPENNODE_LOCAL_SECRET_KEY ?? "opennode-local-dev-secret"` — a published constant. **NET-02** |
| Refuses start on accidental identity collision | `ABSENT` | Not implemented; not wired. **NET-02** |
| Voluntary leave publishes a signed leave event | `PARTIAL` | A leave event verifies against whatever `payload.signerNodeId` claims, **never checked against `subjectId`**, so a peer can forge a leave removing an arbitrary member. `leaveVerifier` is optional and is skipped when omitted. **NET-02, GOV-20** |
| Eviction revokes credentials and fences leases | `ABSENT` | `handleVoluntaryLeave` returns `credentialsRevoked: false`. `handleEviction` returns `drain: null` and never drains. Revocation/quarantine are process-local `Set`s with **zero readers**, lost on restart. **GOV-15, RUN-19** |
| New identity for cloned installations | `ABSENT` | Two deployments that both omit the env var derive an **identical NodeId from a published key**, and share the cluster ID `"local-cluster"`. **NET-02** |
| Restore does not clone another node's identity | `ABSENT` | `restoreFromFile` restores `local_node_identity` **verbatim**, so applying the wrong backup duplicates a node identity. **DATA-04** |

**Residual risk: HIGH.** Key loss is unrecoverable, key compromise is undetectable
by other nodes, and the restore path actively enables identity cloning.

---

## 5. Network Partition

**Threat:** Cluster splits; the minority may serve stale reads or issue
conflicting leases.

| Mitigation | Actual | Finding |
|---|---|---|
| `EventLog.appendEvent` enforces monotonic sequence and hash-linked chain | `PARTIAL` | Validation and append are separated by `await` points with no mutex or compare-and-set. **Two concurrent commits can both validate and both append**, producing two entries at the same sequence with the same `prevHash`. The chain is then permanently broken with no recovery. **SYNC-02, SYNC-03** |
| `validateEntryChain` rejects gaps, hash mismatches, epoch regression | `IMPLEMENTED` | Correct — and it is why the broken chain above is unrecoverable rather than silently accepted. |
| Leases bound to membership epoch; minority cannot create conflicting leases | `ABSENT` | The anti-double-assignment guard is an **optional `peerClaim` argument with no producer**. With it absent, the only check is `memberIds.length === 0`. A not-yet-caught-up minority mints a conflicting lease. **RUN-08** |
| Fencing stops the executing worker | `ABSENT` | Fencing updates only the attempt **record**. The container keeps running and keeps emitting logs and artifacts under the same run ID — attempt N is fenced while attempt N+1 executes elsewhere. **RUN-04** |
| Partitioned worker is detected and rescheduled | `PARTIAL` | `reconcile()` is the only detection path and has **one caller: an unauthenticated HTTP endpoint** that accepts caller-supplied `now` and worker-lost lists. Anyone who can reach the API can fence every live run in the cluster. **RUN-08** |
| Gossip never used for authorization | `IMPLEMENTED` | `policy.ts` correctly blocks gossip from authorizing anything, and gossip is not wired at all — so it cannot be mis-used for authorization. (That is also why the control is vacuous: it does nothing to stop forged *content* — **NET-07**.) |
| Lease TTL exceeds maximum workload duration | `ABSENT` | TTL is **30 s**; max duration is 24 h. There is **no renewal mechanism** despite an alert rule that assumes one. Every run over 30 s is fenced and re-executed. **RUN-03** |
| Fencing stops the executing worker | `ABSENT` | Fencing updates only the attempt **record**. The container keeps running and keeps emitting logs and artifacts under the same run ID — attempt N is fenced while attempt N+1 executes elsewhere. **RUN-04** |

**Residual risk: TOTAL.** A partition produces duplicate execution, and an
unauthenticated caller can trigger it cluster-wide on demand.

---

## 6. Stale Peer

**Threat:** A peer rejoins with outdated state, serves a stale snapshot, or
replays old events.

| Mitigation | Actual | Finding |
|---|---|---|
| Snapshots carry cluster, epoch, height, schema version, Merkle root | `PARTIAL` | The schema is correct, but `createClusterSnapshot` has **zero callers**, and `merkleRoot` duplicates the last leaf for odd counts with no domain separation or tree-size folding. Correct structure, unexercised. |
| Snapshots signed/approved per consensus protocol | `ABSENT` | `approved` is a **self-asserted boolean** chosen by the caller, signed by any one peer. Nothing ties it to a quorum or a role. One peer can dictate a node's entire history. **SYNC-07** |
| Snapshot adoption cannot roll the node back | `ABSENT` | Adoption calls `replace()` with **no check that snapshot height ≥ local height or snapshot epoch ≥ local epoch**. It is guarded by `localMatches` (`catchup.ts:93-98`), but a signed, approved `height: 0` snapshot fails that guard, fetches an empty prefix, and reaches `replace([])` — erasing the entire local log. **SYNC-06** |
| `membershipEpoch` cross-checked against log contents | `ABSENT` | Never compared to the event at `height - 1`. **CORRECTION:** the snapshot epoch is only written into the checkpoint store (`catchup.ts:127-132`, `:190-196`); membership epoch is derived from committed entries in `applyFromLog`, never from the snapshot — so a forged epoch does **not** currently fence anything. The requirement stands because the checkpoint value is unvalidated and the gap is one refactor away from mattering. **SYNC-07** |
| Catch-up replays events after snapshot height | `PARTIAL` | Catch-up downloads the **entire prefix** `[0, height)` in full, so a snapshot saves no transfer — and compaction becomes impossible by construction. **SYNC-07** |
| Catch-up resumes after interruption | `ABSENT` | `checkpoint.height` is loaded and hash-checked, then **never used**. Interrupted transfers restart from chunk 0. **SYNC-05** |
| `runCatchUp` is invoked | `ABSENT` | **Zero call sites.** The entire join path is dead code. **SYNC-05** |
| Gossip anti-entropy reconciles periodically | `PARTIAL` | `setHash` is computed and **never compared**; reconciliation compares per-`rumorId` version only. "Merkle-based anti-entropy" is an O(n) digest exchange with an unused fingerprint. **NET-08** |
| Divergence has a recovery path | `PARTIAL` | **CORRECTION:** a truncate-and-replace primitive *does* exist — `catchup.ts:168-181` calls `truncateTo(from)` then `appendVerified(chunkEntries)` on a chunk mismatch. But it is **peer-authoritative, not quorum-backed**: a node that ingested a rogue peer's entries "recovers" by adopting whichever peer it next syncs from, and discarded entries are never compensated to `onEvent` subscribers. It is also gated behind four unconditional throws (`CHECKPOINT_INVALID`, `SNAPSHOT_ROOT_MISMATCH`, `INCOMPLETE_CHUNK`, per-chunk `MERKLE_ROOT_MISMATCH`), and `runCatchUp` itself has **zero call sites**, so no repair ever executes. **SYNC-06** |
| Catch-up from a lagging peer succeeds | `ABSENT` | Throws with a message stating the **opposite** of the condition — an operator is sent to the wrong runbook. **SYNC-10** |

**Additional exposure:** `stableStringify` includes keys whose value is
`undefined` (`lib/sync-engine/src/hash.ts:11-14`), so hashes are **not reproducible across
a JSON transport hop**. **Qualification:** the failure requires an *explicitly present*
undefined key; no current `ClusterEvent` payload is constructed that way, so this is a
latent canonicalization defect rather than a live catch-up failure. It becomes live the
moment any payload sets an optional field to `undefined`. **SYNC-11**

**Residual risk: TOTAL.** A single hostile peer can roll a node back, erase its
log, fence the entire cluster, or make it permanently unsyncable.

---

## 7. Replayed Message

**Threat:** An attacker captures and re-sends a valid handshake, vote, lease, or
cluster event.

| Mitigation | Actual | Finding |
|---|---|---|
| Nonce cache rejects reused nonces in handshakes | `PARTIAL` | Bounded cache (4096) but populated with an unbounded peer-supplied expiry; oldest-insertion eviction lets an attacker push out legitimate nonces. **NET-13** |
| Event log enforces exact sequence and prevHash | `PARTIAL` | Correct validation, undermined by non-atomic append (**SYNC-02**) and by hash non-reproducibility across transport (**SYNC-11**). |
| Votes bound to proposal, cluster, voter, epoch, choice, expiry | `PARTIAL` | Fields exist; **the signature is not verified**, so the binding is not enforced. Ballots live in an in-memory `Map` and never enter the log. **GOV-03, SYNC-09** |
| Duplicate/replayed ballots rejected | `PARTIAL` | Rejected locally, but the revision counter is process-local and resets to 1 on restart, permanently bricking a voter whose peer restored a higher revision. **GOV-06** |
| Idempotency keys on run submission | `PARTIAL` | **CORRECTION:** the live path is `deriveRunId` (`lib/run-coordinator/src/identity.ts:29-35`) — SHA-256 truncated to 128 bits, which is adequate. The 32-bit FNV-1a `hashString` in `lib/opennode-domain/src/idempotency.ts:125-131` is **dead code** (`resolveIdempotentSubmission` has zero callers) and is not what runs. The real defects: the dedup key `clientRequestId` carries a **global single-column unique index** with no cluster or tenant discriminator (`lib/db/src/schema/workload-runs.ts:41`); `requestFingerprint` (defined at `lib/node-store/src/checksum.ts:14-16`) covers neither `clusterId` nor tenant; and the store assigns a **random UUID** primary key, so the database and the consensus log hold different identities for one run. **RUN-02, DATA-05** |

**Additional exposure:** peer-facing **relay** envelopes carry no end-to-end
signature, no counter, and no expiry, so a malicious relay can replay and reorder
undetectably. Leave signatures bind no nonce or timestamp, so a captured signature
is valid forever within that epoch pair. **NET-12, GOV-20**

---

## 8. Resource Exhaustion

**Threat:** Malicious or buggy peers/workloads consume unbounded CPU, memory,
disk, file descriptors, or network.

| Mitigation | Actual | Finding |
|---|---|---|
| `ResourceLimits` enforces CPU/memory/PID/disk/time/output | `ABSENT` | Type-checked only; nothing enforces (**EXEC-03**). **PID limit is a module constant, not overridable by spec or quota.** |
| `RateLimiter` bounds handshake/discovery rates per remote identity | `ABSENT` | Keyed on attacker-supplied NodeId; buckets never evicted; unbounded map growth. **NET-05** |
| `NonceCache` bounded by `maxEntries` | `IMPLEMENTED` | Correct, modulo the eviction attack in §7. |
| Merkle reconciliation transfers only differing ranges | `PARTIAL` | `getHeight()` is called **before** the loop and `chunkCount` derives from the peer's claim, with **no negotiated chunk size** — so "differing chunks" holds only when both sides happen to be configured identically. **SYNC-05** |
| Peer-advertised values bounded | `ABSENT` | A peer advertising `getHeight() = MAX_SAFE_INTEGER` forces ~1.4×10^14 iterations; an unbounded page is materialised into memory. **SYNC-15** |
| Gossip digest bounded | `ABSENT` | No cap on `entries.length`. An **empty digest** induces a full state dump (amplification); a million-entry digest forces a synchronous build. **NET-08** |
| Transport stream/message limits | `ABSENT` | No cap on concurrent streams, buffered bytes, message size, or subscriptions. `STREAM_NOT_FOUND` / `PEER_NOT_FOUND` are declared and **never thrown**. **NET-11** |
| Content store bounded and retention-enforced | `ABSENT` | No reference counting, no GC (`ChunkStore.delete` has no callers), and `size`/`none` retention policies **never expire**. **SEC-13** |
| Log/table compaction and storage quotas | `ABSENT` | Every table grows without bound; disk exhaustion stops the node from committing and **presents as a sync failure**. **SYNC-08** |
| Failure injection covers the required scenarios | `ABSENT` | The registry is **never wired** to production. Four fault types (`Partition`, `MessageLoss`, `MessageDuplication`, `MessageReordering`) fall through to a **silent pass-through** — a partition scenario reports green while injecting nothing. **OPS-07** |
| Log stream bounded per run/attempt | `ABSENT` | Unlimited SSE connections per run; no byte cap on `run_log_entries`; `outputBytes` and content-store caps are on different, unwired code paths. **SEC-12, EXEC-18** |
| Artifact storage bounded | `ABSENT` | Unbounded process-global `Map` until OOM. **EXEC-17** |

**Residual risk: HIGH.** No bound is actually enforced anywhere in the system.

---

## Cross-cutting: authentication and authorization

Not one of the eight threat classes above is complete. API authentication has since
been added: Clerk middleware protects API routes except the public health endpoint,
and cookie-authenticated writes require a same-origin request. CLI writes must carry
a Clerk-verified bearer token.

Authorization remains incomplete. There is no role or tenant policy, so any signed-in
account can reach membership, feature-flag, kill-switch, and run-management actions.
Peer authentication is not mounted on a peer route; its middleware now requires a real
Ed25519 verifier, a committed node-key resolver, and a nonce-consumption store, none of
which is wired by the API. **Requirements: API-01 is partially addressed; API-02 and
API-04 remain open.** See `todo.md`.

---

## Summary

| Threat | Rows | `IMPLEMENTED` | Highest-severity gap |
|---|---|---|---|
| 1. Hostile Workload | 7 | **0** | No isolation boundary exists at all (EXEC-01) |
| 2. Malicious Peer | 7 | **1** | Signatures forgeable from public data (NET-02) |
| 3. Compromised Node | 8 | **0** | Any node can forge any other node (SYNC-13) |
| 4. Lost Key | 6 | **0** | Published default key (NET-02) |
| 5. Network Partition | 8 | **2** | No quorum check; duplicate execution (RUN-08) |
| 6. Stale Peer | 10 | **0** | Snapshot rollback can erase the log (SYNC-06) |
| 7. Replayed Message | 5 | **0** | Ballot signatures unverified (GOV-03) |
| 8. Resource Exhaustion | 12 | **1** | Five of six limits unenforced (EXEC-03) |
| **Total** | **63** | **4** | |
| AuthN/AuthZ | Partial | Clerk route authentication and same-origin browser-write guard | No role/tenant authorization; peer auth is unwired (API-02, API-04) |

**4 of 63 threat-class mitigations were verified in the original review.** The new API
authentication and same-origin guard are cross-cutting controls, not a re-review of the
63 threat-class rows. The remaining controls still require implementation and evidence.

**Every `IMPLEMENTED` row is now load-bearing across all eight classes**, and
**three of the four are structural invariants rather than runtime defences:**

- §2, §5 — the domain/transport interface boundary (no storage or transport types
  leak into domain rules)
- §5 — gossip is not used for authorization
- §5 — per-entry chain validation (`validateEntryChain` rejects gaps, hash breaks,
  epoch regression)

That is the honest headline: **not one runtime security control in this codebase is
currently deployed.** See PROV-03 — an unwired mechanism is not a control.

---

## Requirements coverage

Every gap above maps to a numbered requirement in `todo.md`. Closure order for the
threat model specifically:

1. **NET-01, NET-02, SYNC-13** — real asymmetric signing and a keystore-backed
   identity. Nothing else in this document matters until signatures are real.
2. **API-01, API-02** — authentication and authorization on every route.
3. **EXEC-01, EXEC-03, EXEC-05, EXEC-06** — a real isolation boundary.
4. **SYNC-06, SYNC-07** — snapshot rollback and epoch forgery defences.
5. **RUN-03, RUN-04, RUN-08** — lease renewal, worker fencing, quorum check.
6. **SEC-02, SEC-06, SEC-13** — worker-bound secrets, live redaction, real GC.

---

*Requirements: `todo.md`. Gates: `docs/release-gates.md`. SLOs: `docs/slos.md`.
Runbooks: `docs/runbooks/README.md`.*
