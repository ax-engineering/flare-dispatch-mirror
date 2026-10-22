-- Migration number: 0011 	 spend guard
--
-- The meter, the monthly budget and the burn ceiling of
-- specs/adr/0006-spend-guard.md, and the interactive admission class of
-- specs/adr/0009-fast-trustworthy-verdicts.md:
--
--   * `executions.admitted_at` — when the run's admission claim landed. A
--     container is active from admission to completion, so the finish path
--     prices that window (runtime-cf execution-cost.ts) and queue wait costs
--     nothing. NULL for a run never admitted.
--   * `executions.cost_meter` — which rule priced `cost_micro_usd`:
--     `admitted-active` from here on; rows priced on wall time before this
--     migration keep their value and read `modeled-wall`.
--   * `run_admissions.hourly_rate_micro_usd` — the list rate of the row's
--     container class per hour. The claim admits only while the live admitted
--     rates plus the claimant's own fit under the burn ceiling, across every
--     pool (runtime-cf run-admission-d1.ts).
--   * `run_admissions.admission_class` — the waiter's line
--     (specs/adr/0009-fast-trustworthy-verdicts.md): the claim admits the
--     oldest live `interactive` waiter in a pool before any `batch` waiter,
--     and FIFO order and the queue position apply within a class. A NULL row
--     (pre-0011) ranks as `batch`.
--
-- The month-to-date spend read (runtime-cf spend-d1.ts) sums `cost_micro_usd`
-- over executions admitted this month; `executions_admitted_at` serves that
-- range scan.

ALTER TABLE executions ADD COLUMN admitted_at INTEGER;   -- ms epoch; NULL = never admitted
ALTER TABLE executions ADD COLUMN cost_meter TEXT;       -- admitted-active | modeled-wall
UPDATE executions SET cost_meter = 'modeled-wall' WHERE cost_micro_usd IS NOT NULL;
CREATE INDEX IF NOT EXISTS executions_admitted_at ON executions(admitted_at);

ALTER TABLE run_admissions ADD COLUMN hourly_rate_micro_usd INTEGER;  -- NULL rows (pre-0011) count as 0
ALTER TABLE run_admissions ADD COLUMN admission_class TEXT;         -- interactive | batch; NULL = batch
