# ADR-0009 — Fast, trustworthy verdicts: an interactive admission class, durable delivery, a two-tier gate, pools sized under the spend guard

**Status:** proposed
**Related:** `apps/dispatcher/src/workflow.ts` · `packages/runtime-cf/src/run-admission-d1.ts` · `packages/core/src/services/checks.ts` · `runs/contextful-gate.ts` · `runs/check.ts` · ADR-0005 · ADR-0006

## Context

- Every run shares one FIFO per pool. A fan-out gate enqueues tens of parts
  at once, and a one-minute lint or review queued behind them waits for the
  whole fan-out, then times out red.
- Check-run updates have no budget. The queue-position update is a GitHub
  write per position change per waiter, and a burst exhausts the
  installation's hourly quota. After that, check-runs fail to open or never
  conclude, and computed verdicts never reach the pull request.
- A wide gate's floor is its slowest part, tens of minutes on any platform.
  Running every heavy part on every pull-request push buys a verdict nobody
  waits for, at the highest cost per push.
- A larger pool shortens queues, but under ADR-0006 it is the burn ceiling,
  not the pool cap, that sets concurrency.

## Decision

### Interactive admission class

- A run may declare `limits.admissionClass: "interactive" | "batch"`.
  Unset, the class is `batch`. `oxlint`, `pr-review`, `offload-test` and
  `worker-deploy` declare `interactive`.
- `run_admissions` records the class. A claim admits the oldest interactive
  waiter before any batch waiter. The no-barge rule and the queue position
  apply within a class, interactive ahead of batch.
- An interactive run never waits behind a batch run that has not yet been
  admitted.

### Durable verdict delivery

- Queue-position updates are bucketed: a waiter writes its position only when
  it crosses a bucket boundary (1, 2-5, 6-20, over 20) and at most once a
  minute.
- Every GitHub call honours `Retry-After` and the rate-limit reset header. The
  checks client keeps a per-installation reserve of 10% of the hourly quota
  for create and conclude calls; position updates stop first.
- A check-run that failed to open is created at conclusion, with the
  verdict, instead of left absent.
- `executions.delivered_at` records when the concluding check-run write
  succeeded. A cron reconcile sweep re-sends the conclusion of every finished
  execution without `delivered_at`, oldest first, inside the reserve.

### Two-tier gate

- A gate's plan marks each part `light` or `heavy`. `CONFIG_KV`
  `gate.lightLabels:<repo>` lists the light labels. Unset, every part is
  heavy, which keeps today's behaviour.
- On a pull-request event the gate runs light parts only, as interactive
  runs. On a push to the default branch it runs the heavy parts once per head
  under a serialization group (ADR-0004), so a newer head supersedes an older
  one.
- Branch protection on the light tier is the repository owner's setting, not
  the dispatcher's.

### Pools sized under the spend guard

- `ADMISSION_CAP` per pool is an upper bound. ADR-0006's burn ceiling sets the
  operating concurrency: a pool admits at most
  `min(cap, ceiling / instance hourly rate)` at once, summed across pools.
- The lean pool's cap is 48 by default. It moves to 64 once a week at 48 shows
  no container start-rate errors and no placement retries. The browser pool
  has its own `ADMISSION_CAP_BROWSER`, like the agent and release pools.
- The caps take effect only as the operator raises the burn ceiling. At the
  default 1.50 USD an hour the guard admits three `standard-4` containers,
  whatever the cap. Full use of the cap needs the ceiling below:

  | lean concurrency | burn ceiling (`standard-4` at list rate) |
  | ---------------- | ---------------------------------------- |
  | 3                | 1.50 USD/h (default)                     |
  | 16               | 6.50 USD/h                               |
  | 48               | 19.50 USD/h                              |
  | 64               | 26.00 USD/h                              |

  An operator raises the ceiling together with the monthly budget, so a
  larger pool shortens queues without lifting the cap on the month.

- `max_instances` per container class is the pool's cap plus 8, headroom for
  containers still stopping. A test asserts cap < `max_instances` for every
  pool, on the committed vars and on the code defaults.
- A claim that admits adds a jitter of up to 2 seconds before the container
  starts, so a burst of admissions does not hit the container start-rate
  limit at once.

## Rationale

A class costs nothing when the pool is free and removes the one wait a
developer feels most. Delivery is the product: a computed verdict that never
reaches GitHub costs the same as one that does and reads as a hang. A two-tier
gate puts the minutes-scale check where the merge decision is made and runs
the slow matrix where it can still catch regressions.

## Consequences

- Batch work waits longer when interactive work is queued.
- GitHub shows coarser queue positions.
- Heavy failures surface on the default branch after merge, not on the pull
  request.

## Revisit triggers

- A batch run starves behind sustained interactive load.
- GitHub raises installation limits, or the checks API gains a cheaper
  progress channel.
