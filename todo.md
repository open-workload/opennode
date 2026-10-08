# OpenNode — implementation TODO

Status: planning only; no implementation has started.

## Product and architecture decisions

- Each independently deployed OpenNode installation is a peer node with its own persistent identity, local durable state, UI/API, peer networking, and optional execution capacity. A restarted node must retain the same identity; a cloned installation must generate a new identity.
- There is no permanent central controller, shared central database, or single scheduler. Nodes exchange authenticated events and reach cluster decisions through a replicated consensus log.
- Use gossip and Merkle-based anti-entropy for discovery, presence, and transfer of missed state. Use a proven consensus implementation for membership changes, job ownership/leases, and other safety-critical decisions. Do not implement a custom consensus protocol.
- The initial governance model is permissioned: a new node needs approval from admitted peers. This is decentralized membership, not anonymous/permissionless membership.
- Admission votes: freeze eligible membership N when the proposal opens. If N = 1, require one yes vote. If N > 1, require max(2, ceil(0.20 × N)) yes votes. The candidate cannot vote. Offline peers remain in N and do not count as yes votes.
- Eviction votes: freeze N at proposal open; require ceil(0.50 × N) yes votes from members other than the target. The target remains in N and may submit a response, but their ballot does not count. No response is not a yes vote.
- A voluntary leave requires no vote. A leaving node stops accepting new work, drains or relinquishes active work, and publishes a signed leave event. Consensus finality is required to make membership changes consistent across peers.
- A percentage vote determines whether a proposal passes the governance rule. Consensus orders and commits that result; consensus participation is not an additional approval ballot.
- Replit may host a node only if persistent state, stable identity, networking, and process lifetime pass the feasibility spike. Do not assume a Replit deployment can safely execute untrusted containers or accept arbitrary peer protocols. Workload execution uses an isolated worker backend.
- MVP workload execution targets OCI images pinned by digest. udocker may be tested as an execution option inside the isolated worker, but is not treated as the security boundary.

## System outline

Each node contains these independently replaceable modules:

- Web client: project, cluster, membership, run submission, run history, logs, and node health UI.
- Local API: authenticated local and peer-facing API; validates requests and delegates to domain modules.
- Domain core: pure rules for membership, voting, jobs, attempts, leases, authorization decisions, and state transitions.
- Local state store: durable node-local database and content metadata. No shared database is the cluster source of truth.
- Cluster log: adapter to a proven consensus engine; commits ordered events and supports snapshots and replay.
- Peer network: encrypted authenticated peer streams, discovery, gossip, relays, rate limits, and protocol negotiation.
- Sync engine: snapshot validation, event replay, sequence/vector tracking, Merkle reconciliation, resumable chunk transfer, and schema compatibility.
- Run coordinator: records a run request, obtains an exclusive committed lease, selects a capable peer, handles retries/cancellation, and reconciles worker status.
- Execution provider: interface to an isolated worker runtime; never runs hostile workload code in the UI or node API process.
- Secret broker: references secrets by ID and delivers short-lived job-scoped values only to an authorized worker; secret values are not replicated in cluster metadata.
- Content store: encrypted, checksummed log/artifact chunks with explicit replication and retention policy.

Deep-module rule: callers depend on small stable interfaces, not on storage, transport, consensus, or runtime internals. Keep peer protocol and provider-specific types out of the domain core. Validate every boundary input. API, CLI, and UI are thin clients of the same domain/API contracts.

## Vertical slice 0 — feasibility and architecture gate

- [ ] Write threat model: hostile workload, malicious peer, compromised node, lost key, network partition, stale peer, replayed message, and resource exhaustion.
- [ ] Select candidate peer-network and consensus implementations. Record why they fit the language/runtime and membership model; require a maintained, reviewed implementation rather than custom consensus.
- [ ] Prototype peer-to-peer connectivity between two independently deployed nodes, including encrypted handshake, node identity, protocol version negotiation, reconnect, and outbound-only/NAT cases.
- [ ] Verify Replit deployment behavior: persistent state across restart, stable public identity, inbound and outbound connectivity, long-lived streams, process lifetime, and storage durability.
- [ ] Prototype an isolated worker outside the node API process; test OCI pull by digest, required udocker behavior, CPU/memory/PID/disk/time limits, network deny-by-default, cancellation, logs, and cleanup.
- [ ] Document worker operator, supported image registries, network egress policy, secret source, log/artifact retention, and initial resource quotas.

Exit criteria:
- [ ] Two peers can authenticate and exchange a signed test message after reconnect without a central authority.
- [ ] Node identity survives the target deployment's restart model and cloned identity is detected or prevented.
- [ ] No user workload executes in the Replit web/API process; worker isolation controls have test evidence.
- [ ] If Replit cannot host a durable peer, document Replit as a UI/client deployment only and identify the supported full-node deployment target before proceeding.

## Vertical slice 1 — one durable OpenNode node

Goal: a single installation can create a project, submit a safe sample test run, view logs and history, and restart without losing state.

- [ ] Define versioned schemas for NodeId, ClusterId, JobSpec, Run, Attempt, LogChunk, ArtifactRef, MembershipProposal, Vote, and ClusterEvent.
- [ ] Implement NodeIdentity: generate a signing key once, store it via the node keystore interface, expose only a public NodeId, support key backup/rotation procedures, and refuse to start on an accidental identity collision.
- [ ] Implement a local durable store behind NodeStore. Define migrations, transaction boundaries, checksums, indexes, backup, and restore. Store no plaintext secrets in job records.
- [ ] Implement domain state machines for job and attempt states, including queued, starting, running, cancel-requested, succeeded, failed, cancelled, timed-out, and infrastructure-error/lost.
- [ ] Implement a local fake ExecutionProvider for development and contract tests; make the production API asynchronous and return a durable run ID before work finishes.
- [ ] Build the first UI path: create a test run with a built-in no-network sample, preflight it, submit, display live status/logs, cancel it, and revisit history after reload.
- [ ] Add request idempotency: repeated submission with the same idempotency key and same payload returns the same run; same key with a different payload returns conflict.
- [ ] Add initial audit events and structured logs with request/run/attempt correlation IDs and secret redaction.

Exit criteria:
- [ ] A node restart preserves identity, run history, and terminal attempt results.
- [ ] UI submission, API submission, and later CLI submission will share the same API/schema path.
- [ ] UI displays a clear distinction between preflight validation and actual execution.

## Vertical slice 2 — secure peer join and state synchronization

Goal: an admitted second node can join, verify cluster identity, synchronize state, and show as healthy without becoming a workload coordinator.

- [ ] Implement PeerTransport interface: connect, authenticate, open versioned streams, publish/subscribe, close, and report transport health. Keep libp2p/transport-specific types behind the adapter.
- [ ] Use signed node handshakes with cluster ID, NodeId, protocol range, nonce, timestamp/expiry, and replay protection. Rate-limit handshake and discovery endpoints.
- [ ] Implement multiple bootstrap peer addresses. Treat them as discovery hints only; they must not own governance or authoritative state. Add optional encrypted relay transport for NAT-restricted peers.
- [ ] Implement membership certificate verification before a peer can request protected cluster data or advertise execution capacity.
- [ ] Store committed ClusterEvents as a hash-linked, signed log with monotonic sequence/epoch identifiers. Define event schema versioning and deterministic validation.
- [ ] Implement snapshot generation and verification. A snapshot must identify its cluster, membership epoch, log height, schema version, and Merkle root, and be signed/approved according to the consensus protocol.
- [ ] Implement join catch-up: verify snapshot, replay events after snapshot height, request missing ranges, compare Merkle roots, exchange only differing chunks, and resume after interruption.
- [ ] Implement gossip for low-risk presence/capacity signals and periodic anti-entropy repair. Do not use eventual gossip alone to authorize jobs, membership changes, or secret access.
- [ ] Add local read models that can be rebuilt from committed events; expose stale/syncing/healthy states to the UI.

Exit criteria:
- [ ] A peer cannot join a cluster or read protected data with a forged, expired, or wrong-cluster identity.
- [ ] A newly admitted node reaches the same committed membership and job history as existing nodes after catch-up.
- [ ] Duplicate, delayed, reordered, and replayed events do not corrupt state; interrupted snapshot transfer resumes safely.

## Vertical slice 3 — decentralized membership governance

Goal: users can propose, vote on, synchronize, and audit node admission, voluntary leave, and eviction.

- [ ] Implement MembershipService as a deep module with proposeAdmission, castVote, proposeEviction, requestLeave, commitDecision, and reconcile methods. UI/API must not implement threshold math independently.
- [ ] Freeze an electorate snapshot and membership epoch when each proposal opens. Store its denominator so later joins/leaves cannot change the threshold mid-vote.
- [ ] Implement admission rule: N = eligible members at proposal open, excluding candidate; require one yes vote when N = 1; otherwise max(2, ceil(0.20 × N)) unique signed yes votes.
- [ ] Implement eviction rule: N = eligible members at proposal open, including target in the denominator; target may respond but cannot cast a counted ballot; require ceil(0.50 × N) unique signed yes votes from the remaining electorate.
- [ ] Bind votes to proposal ID, cluster ID, voter NodeId, membership epoch, ballot choice, and expiry. Reject duplicate/replayed or stale-epoch ballots. Persist every accepted ballot and decision for audit.
- [ ] Implement proposal expiry and deterministic tie/timeout behavior. No response never counts as yes. Define whether a voter may change a ballot before expiry; if allowed, use signed ballot revisions and deterministic last-valid-revision rules.
- [ ] Commit a passed decision through the consensus log. Do not treat a locally observed vote count as final while the node is partitioned or consensus cannot commit.
- [ ] On admission, issue a membership credential/certificate only after commit, then allow state sync and capability registration.
- [ ] On voluntary leave, immediately stop new assignments locally, drain/relinquish work, and publish a signed leave event; reconcile the committed membership state with peers.
- [ ] On eviction, stop new assignments, revoke membership credentials, invalidate leases/fencing tokens, stop or quarantine execution capacity, and apply documented data-retention rules after commit.
- [ ] Add UI and CLI proposal/vote flows showing proposal reason, frozen denominator, required/received yes votes, expiry, decision state, and sync status.

Exit criteria:
- [ ] Threshold tests pass for N=1 through N=20, including exact 20%, minimum-two admission floor, exact 50% eviction, and offline voters.
- [ ] Conflicting or stale vote sets cannot produce different committed membership histories across peers.
- [ ] An evicted or voluntarily departed peer cannot receive new work or use old credentials after the committed epoch advances.

## Vertical slice 4 — replicated run submission and safe scheduling

Goal: a user can submit through any peer; the cluster records one run and grants one exclusive execution lease.

- [ ] Implement RunCoordinator behind a stable interface: validate, submit, request cancellation, retry, acquire lease, observe attempt, and reconcile lost worker state.
- [ ] Use a deterministic run/idempotency identity derived from cluster, authenticated submitter, and client key, then commit the accepted run event to consensus so submissions through different peers deduplicate.
- [ ] Add deterministic candidate selection (for example, rendezvous hashing over eligible node IDs and declared capability), but require a committed lease/fencing token before execution.
- [ ] Bind leases to run ID, attempt number, worker NodeId, membership epoch, and expiry. A stale or evicted node must not continue with a valid-looking old lease.
- [ ] Define partition behavior: an isolated minority may finish work it already holds under an unexpired lease if policy permits, but cannot create a conflicting exclusive assignment; new assignments wait for consensus quorum.
- [ ] Treat retries as at-least-once execution. Preserve every attempt and require workload idempotency guidance; never promise exactly-once external side effects.
- [ ] Add quotas and admission checks for concurrency, duration, resources, output size, image policy, and authorized secret references.
- [ ] Add run state reconciliation for worker loss, expired leases, delayed completion, duplicate reports, cancellation racing completion, and provider outage.

Exit criteria:
- [ ] Concurrent identical submissions via two peers create one logical run.
- [ ] Partitions and stale workers cannot obtain conflicting committed leases.
- [ ] UI and CLI see the same committed run/attempt states from different healthy peers.

## Vertical slice 5 — real isolated execution, logs, and artifacts

Goal: a committed run executes in a disposable isolated worker, with durable history and logs available through any authorized peer.

- [ ] Implement ExecutionProvider adapter for the selected worker backend. Keep provider credentials server-side and scoped; authenticate workers independently of users.
- [ ] Run one job per disposable isolation boundary. Deny network egress by default, block metadata/control-plane/other-tenant endpoints, and enforce CPU, memory, PID, disk, wall-clock, and output limits outside the workload.
- [ ] Pin OCI image by immutable digest; record digest and policy result per attempt. Pull with short-lived registry credentials and never expose those credentials to the job.
- [ ] Inject only referenced job-scoped secrets through a broker; keep values out of argv, image layers, replicated metadata, logs, traces, and UI responses.
- [ ] Stream sequenced bounded log chunks with attempt ID, stream type, timestamp, and checksum. Support follow, cursor resume, pagination, ordering, and duplicate chunk handling.
- [ ] Store larger logs/artifacts as encrypted content-addressed chunks with checksums and explicit replication/retention metadata. Do not publicly expose private workload output.
- [ ] Implement cancellation and teardown for success, failure, timeout, eviction, worker disappearance, and control-plane outage. Clean scratch state and revoke temporary credentials.
- [ ] Add UI Test Run guided form and advanced spec editor; run preflight for image, permissions, quota, network policy, secrets, and worker health; submit only on explicit user action.
- [ ] Add run details/history, reconnectable logs, cancellation, attempt history, artifacts, and actionable worker/policy errors.
- [ ] Add CLI login/logout/status, preflight, submit, list, show, logs --follow/resume, cancel, retry, and cluster/peer status. Use OS credential store where available; never put secrets in shell history or arguments.

Exit criteria:
- [ ] No workload executes in the UI or node API process.
- [ ] Hostile workload tests cannot access host, control-plane credentials, metadata, another job, or another tenant.
- [ ] Logs/artifacts are ordered, bounded, authorized, resumable, checksummed, and subject to retention.

## Vertical slice 6 — production hardening and staged rollout

- [ ] Add tests for hostile peers, message floods, malformed events, signature failures, replay, stale snapshots, key rotation, duplicate node identities, and protocol downgrade.
- [ ] Add failure injection for peer partitions, control-plane restart, consensus quorum loss, worker restart, object-store outage, full disk, provider timeout, expired credentials, and failed cleanup.
- [ ] Add observability for consensus health, peer connectivity, catch-up height/lag, sync errors, queue age, lease expiry, duplicate submissions, worker health, log lag, and orphan cleanup.
- [ ] Add alerts and runbooks for quorum loss, suspected compromised peer, key revocation, worker containment, provider outage, stuck proposal, stale lease, and state restore.
- [ ] Test backup/restore and rejoin from snapshots; reconcile restored state with current consensus height before the node advertises capacity.
- [ ] Add feature flags and a kill switch that stops new execution while preserving cancellation, cleanup, and membership revocation paths.
- [ ] Deploy a small canary cluster, test join/leave/eviction and workloads under representative partitions, then expand only after launch gates pass.

Release gates:
- [ ] Consensus and sync implementation is reviewed; no custom consensus protocol is in production.
- [ ] No unresolved critical/high security findings, cross-tenant access, host escape, or secret leakage.
- [ ] Membership thresholds, partition behavior, rejoin, eviction fencing, and lease recovery pass automated integration and fault-injection tests.
- [ ] Replit full-node support is claimed only if persistence and peer-connectivity tests pass on the actual deployment target.
- [ ] Operators can pause new work, quarantine a peer, revoke its identity, and recover the cluster without losing auditability.

## Shared technical contracts

- Domain modules expose typed commands/results and domain errors; API/CLI map them into stable versioned error responses.
- Every mutation carries authenticated actor, cluster ID, request ID, idempotency key where applicable, and expected membership/state epoch.
- Every replicated event is schema-versioned, signed by its origin where appropriate, validated deterministically, and safe to replay more than once.
- Every peer-facing endpoint enforces size limits, authentication, replay protection, rate limits, and authorization before reading protected state.
- Secrets, private keys, access tokens, raw credentials, and unredacted sensitive workload output never enter the replicated event log.
- Metrics and logs use correlation IDs and bounded cardinality; never emit secret values or private key material.

## Deferred unless required for MVP

- Open/permissionless membership, token economics, public reputation, and Sybil resistance.
- Multi-cloud worker provisioning, GPUs, persistent workload volumes, unrestricted internet egress, and multi-region policy.
- Exactly-once workload side effects, arbitrary Kubernetes manifests, privileged containers, or user-controlled host mounts.
- Replicating every private artifact to every peer; data replication must follow explicit authorization, encryption, and retention policy.
