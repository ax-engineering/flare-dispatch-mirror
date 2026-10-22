# ADR-0006 — Spend guard: a monthly budget closes admission, a burn ceiling bounds concurrency

**Status:** proposed
**Related:** `apps/dispatcher/src/workflow.ts` · `packages/runtime-cf/src/run-admission-d1.ts` · `packages/runtime-cf/src/execution-cost.ts` · `packages/core/src/cost.ts` · `infra/migrations/0005_execution_cost.sql` · ADR-0007

## Context

Cloudflare offers no spend cap for Workers, Workflows or Containers. A budget
notification sends one email when month-to-date spend first crosses its
threshold and stops nothing. Container compute is almost all of a deploy's
bill, and it scales with pushes times fan-out width: a 30-part gate on a busy
pull request spends in an afternoon what a month of standard checks spends.

Every run passes the admission semaphore before it starts a container, and a
run refused there costs nothing. That makes admission the one place a hard
limit holds for every dispatch path: webhook, Action and cron.

The per-execution cost rollup does not support a limit today. It prices the
execution's wall time, queue wait included, and maps the lean image to
`standard-2` while the lean container class runs `standard-4`.

## Decision

### Meter

- An execution's container-active time runs from admission to completion.
  Admission writes `executions.admitted_at`; queue wait costs nothing.
- Its compute cost is the list rate of its container class's instance type,
  priced on provisioned vCPU, memory and disk, times active seconds, plus its
  metered model tokens. A provisioned-size list rate is an upper bound on the
  billed rate, so the guard stops early rather than late.
- The instance type per sandbox image comes from one table that a test
  checks against the container classes in `wrangler.jsonc`.
- The finish path writes `cost_micro_usd` from this rule. Rows written before
  the rule keep their value and are labelled `modeled-wall`.

### Spend read

Month-to-date spend is the sum over the current UTC calendar month of:

- `cost_micro_usd` of every finished execution admitted this month;
- for every admitted, unfinished execution, its hourly rate times the time
  since `admitted_at`;

times an overhead factor for Workflow steps and Durable Objects
(`SPEND_OVERHEAD_FACTOR`, default `1.10`). One indexed D1 query answers it.

### Monthly budget

- `SPEND_BUDGET_MONTHLY_USD` sets the budget. Unset, the budget is **50 USD**.
  `unlimited` disables the monthly check. A `CONFIG_KV` value at
  `spend.budgetMonthlyUsd` overrides the variable, so an operator raises the
  budget without a deploy.
- Admission reads spend before it enqueues a run and again before each claim.
  At or over budget, the run ends `RunSkipped` with the reason
  `spend budget reached: $<spend> of $<budget> this month`, which concludes
  its check-run `neutral` and records the execution `skipped`. No run is
  exempt.
- A fan-out parent reads spend before it spawns children. Over budget, it
  skips and spawns none. A child spawned before exhaustion skips at its own
  admission.
- Runs already admitted finish. The overshoot is bounded by the burn ceiling
  times the longest run body still in flight.

### Burn ceiling

- `SPEND_BURN_MAX_USD_PER_HOUR` caps the summed hourly rate of all admitted
  executions across every pool. Unset, the ceiling is **1.50 USD per hour**,
  which admits three `standard-4` containers, or eleven `standard-2`, at once.
  `unlimited` disables it. `CONFIG_KV` `spend.burnMaxUsdPerHour` overrides it.
- `run_admissions` records each admitted row's hourly rate. A claim admits
  only when the pool has a free slot and the admitted rates plus the
  claimant's own rate fit under the ceiling. A run whose own rate exceeds the
  ceiling is admitted only into an empty set, so it never waits forever.
- A run that times out in the queue while the ceiling, not the pool cap, held
  it back ends `RunSkipped` with the reason `spend ceiling`. A queue timeout
  under the pool cap alone keeps its current verdict.
- `max_instances` per container class stays the platform's hard limit. The
  ceiling makes the configured `ADMISSION_CAP` an upper bound, not the
  operating point.

### Warning and visibility

- The first admission after spend crosses `SPEND_WARN_RATIO` of the budget
  (default `0.8`) in a month logs `spend.warn` and sends one notification on
  the dispatcher's notify path. `CONFIG_KV` `spend.warned:<YYYY-MM>` marks
  the month as warned.
- `GET /api/spend` returns month-to-date spend, the budget, the burn ceiling,
  the admitted hourly rate and the month's reset time. The dashboard shows
  the same line.

## Rationale

The budget has to bind on every path, and only admission sees every run
before it costs anything. A neutral skip tells the developer the check did
not run without reading as a failure.

The defaults cap a deploy that sets nothing. The operator overlay replaces the
committed `wrangler.jsonc`, so a default in committed config never reaches a
deploy whose overlay predates it. The defaults therefore live in code.

A monthly budget alone lets one burst spend the month in a day and leaves the
rest of the month with no checks. The burn ceiling spreads the budget over
time and bounds the overshoot when the budget closes. A dollar rate, rather
than a container count, holds across pools whose instance types differ.

An upper-bound meter can stop runs while real spend sits below the budget.
That is the safe direction for a cap. The monthly reconcile against the
Billable Usage API shows how far apart the two are.

## Consequences

- At the defaults, checks skip once a month's estimated spend reaches 50 USD.
  Wide fan-outs queue behind the burn ceiling and run slower.
- Raising either limit is a single `CONFIG_KV` write.
- The meter estimates spend; it is not the invoice. The Billable Usage API
  stays the source of truth for the month's bill.
- Workers requests, R2, KV, D1 and AI Gateway are inside the overhead factor
  rather than metered per execution.

## Revisit triggers

- Measured monthly billed spend differs from the meter's month-to-date by more
  than 25%.
- Cloudflare ships an account-level spend cap for Containers.
- A run class needs to run regardless of budget, such as a release.
