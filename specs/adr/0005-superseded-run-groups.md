# ADR-0005 — Superseded run groups: the highest-ranked member cancels lower live ones

**Status:** proposed
**Related:** `packages/runtime-cf/src/run-supersede-d1.ts` · `apps/dispatcher/src/supersede.ts` · `apps/dispatcher/src/workflow.ts` · `runs/contextful-gate.ts` · `infra/migrations/0010_run_supersessions.sql` · ADR-0004

## Context

A pull-request gate fans out tens of child checks, each holding an admission
slot for up to 45 minutes. A new push makes every child of the previous head's
gate worthless, yet each keeps its slot until it finishes, and the new head's
children queue behind them in the same pool. ADR-0004's serialization never
touches a running execution, which is right for a deploy and wrong here.

## Decision

A run may declare `supersede: (input) => { group, order? } | undefined`. A
member's rank is `order` — the gate passes the pull request's `updated_at` —
or its registration time without one; ties fall to registration time, then
execution id. For executions with equal `group`:

- registration happens in `RunWorkflow` after the check-run opens and before
  serialization and admission;
- an arrival marks every lower-ranked live member superseded, naming itself, in
  one D1 batch, and cancels each one: root row marked `cancelled`, root
  instance terminated, every open child instance terminated, containers torn
  down, rows ended `cancelled`, admission and serial rows deleted, open
  check-runs concluded `cancelled`;
- an arrival that finds a higher-ranked live member marks itself superseded in
  the same batch and ends itself `cancelled`, so an older head whose workflow
  reaches registration late never cancels the newer head;
- a re-run (`retryOf` set) joins the group and cancels nothing, so re-running
  an older head never cancels a newer one;
- a child whose parent row reads `cancelled` when it boots ends itself
  `cancelled` before it queues for a slot;
- a member leaves the group when it finishes, on every exit path.

## Rationale

Ranking by revision rather than by registration closes the race between two
pushes seconds apart: registration order is whichever workflow reaches the
step first. Marking the root before reading its tree closes the race with a child spawned
just before termination: a child either appears in the tree read, or boots
after the mark and stands down. A registration that re-runs reads its set back
by `superseded_by`, so an instance lost between the batch and its checkpoint
still cancels what it superseded.

## Consequences

- A cancelled execution ends without its own finalizer: the canceller writes
  its row, slots and check-runs.
- A keyed container (a second workspace inside one execution) is reaped by
  `sleepAfter`, not by the canceller.

## Revisit triggers

- A group needs a rank that `updated_at` cannot order, such as two pushes
  inside one second.
