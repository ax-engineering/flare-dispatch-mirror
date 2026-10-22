# ADR-0008 — Cheaper waiting: rpc transport by default, position-scaled admission polls, counted supersessions

**Status:** proposed
**Related:** `packages/runtime-cf/src/runtime.ts` · `packages/runtime-cf/src/sandbox-cf.ts` · `apps/dispatcher/src/workflow.ts` · `packages/runtime-cf/src/run-admission-d1.ts` · `apps/dispatcher/src/supersede.ts` · ADR-0005 · ADR-0007

## Context

- The sandbox transport defaults to http, and only a per-repo `CONFIG_KV` pin
  selects rpc. Streaming a file into a container needs rpc, so on the default
  transport every cache restore fails and every run installs from scratch.
- A queued run polls admission every 20 seconds whatever its position. Each
  poll is a claim step plus a sleep step, and Workflows bills each step. A run
  fifty places back pays for hundreds of polls that cannot admit it.
- ADR-0005 cancels a superseded gate's children, but nothing counts how often
  that happens or how much work it stops, so nobody can tell whether it is
  working.

## Decision

### rpc transport by default

- `SANDBOX_TRANSPORT` defaults to `rpc` in code when unset.
- `CONFIG_KV` `sandbox.transport:<repo>` still overrides the default per repo,
  in both directions, so an operator pins a repo back to `http` without a
  deploy.
- A container keeps the transport it started with for its whole life, as
  `sandbox-cf.ts` pins it today.

### Position-scaled admission polls

- A waiter at FIFO position `p` in a pool with cap `c` sleeps
  `min(60 s, 20 s × ceil(p / c))` between claims. The head of the queue keeps
  the 20-second poll, and a waiter many slots back polls up to three times
  less often.
- The waiter liveness window (`ADMISSION_WAITER_TTL_MS`) is at least three
  times the longest sleep, so a slow-polling waiter never reads as dead.
- The sleep length derives from the position observed inside the claim step,
  so a replay sleeps the same length.

### Counted supersessions

- Each supersession logs one `supersede.cancelled` line naming the group, the
  cancelled root, and the number of children, admitted slots and open
  check-runs it ended.
- The dashboard's execution list labels a cancelled execution with the
  execution that superseded it.

## Rationale

rpc is the only transport on which every capability in `@cloudflare/sandbox`
works, file streaming included, so an http default makes the cache a cost
rather than a saving. Keeping the per-repo pin gives a deploy a rollback
without a release.

Polling far from the head buys nothing: a waiter cannot move more than one
position per released slot. Scaling the sleep with position cuts the step bill
of a long queue while the head still admits within one short poll.

A log line per supersession makes the saving measurable without a new table.

## Consequences

- Deploys that never set the variable switch to rpc on their next deploy.
- Waiters deep in a long queue admit up to 40 seconds later after a burst of
  releases.

## Revisit triggers

- rpc fails a capability that http serves.
- Admission moves from polling to an event that wakes the head waiter.
