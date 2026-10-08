# OpenNode domain

Pure TypeScript governance and workload-run rules, independent of transport,
persistence, consensus, and container execution.

## Governance API

`createAdmissionProposal`, `createEvictionProposal`, and
`createVoluntaryLeaveProposal` create immutable proposal snapshots.
`castGovernanceVote` returns a new proposal and rejects duplicate, stale, or
unauthorized ballots. `submitEvictionResponse` lets only the eviction target
respond; a response is not a ballot. `admissionThreshold` and
`evictionThreshold` expose the rules, while `hasGovernancePassed` reports only
rule passage.

Admission uses the frozen electorate size `N`: `1` yes vote when `N = 1`,
otherwise `max(2, ceil(0.20 * N))`. The candidate is not in that electorate and
cannot vote. Eviction uses `ceil(0.50 * N)`; its electorate includes the target,
but the target cannot vote. Offline members remain in `N` and do not count as
yes votes. Voluntary leave is represented as immediately vote-free. Rule
passage does not imply consensus commit or finality; those are external.
Epochs are non-negative safe integers and ballots must match the proposal epoch.

## Workload/run API

`createBuiltInDiagnosticWorkload` creates the safe built-in health check;
`createArbitraryContainerWorkload` represents a distinct container mode by
image only. Neither API accepts a command or entrypoint, and the domain does
not execute workloads or silently fall back to another mode. `createRun`
starts a validated workload in `queued`; `transitionRun` returns a new run only
for legal state transitions. Terminal states cannot transition further.

All rule violations throw `DomainError` with a stable `code`.
