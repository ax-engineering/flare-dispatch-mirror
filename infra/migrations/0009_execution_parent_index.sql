-- Migration number: 0009 	 execution parent index
--
-- A fan-out parent reads its children back by lineage at two points: the
-- join poll, and its terminal path, where it concludes any child check-run
-- still open (apps/dispatcher/src/child-check-runs.ts). Every execution runs
-- that terminal read, so `parent_execution_id` carries an index rather than a
-- table scan per finished run.
CREATE INDEX IF NOT EXISTS executions_parent_execution_id ON executions(parent_execution_id);
