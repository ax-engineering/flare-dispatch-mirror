-- Migration number: 0010 	 run supersessions
--
-- Per-group supersession for runs that declare `supersede` (contextful-gate:
-- one group per pull request). A higher-ranked execution of a group marks every
-- lower-ranked 'live' row 'superseded', naming itself in `superseded_by`, then
-- cancels each of those executions with its children; a lower-ranked arrival
-- marks itself. A row is deleted when its execution finishes or is cancelled. See @fractalboxdev/flare-dispatch-runtime-cf
-- run-supersede-d1.ts.

CREATE TABLE IF NOT EXISTS run_supersessions (
  execution_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,          -- SupersedeSpec.group
  state TEXT NOT NULL,              -- 'live' | 'superseded'
  superseded_by TEXT,               -- execution id of the higher-ranked member that superseded this one
  revision_rank INTEGER NOT NULL,   -- SupersedeSpec.order, else registered_at; revision order within a group
  registered_at INTEGER NOT NULL    -- ms epoch; breaks a rank tie
);
CREATE INDEX IF NOT EXISTS run_supersessions_group_state
  ON run_supersessions(group_key, state, revision_rank);
CREATE INDEX IF NOT EXISTS run_supersessions_superseded_by
  ON run_supersessions(superseded_by);
