-- Migration number: 0012 	 verdict delivery
--
-- A computed verdict reaches the pull request only when the concluding
-- check-run write lands. These columns record whether it did:
--
--   * `installation_id` — the GitHub App installation the execution's
--                         check-run posts under. NULL when the execution has
--                         no live check-run (no App credentials, or a dispatch
--                         with no installation): no verdict is owed on GitHub.
--   * `delivered_at`    — ms epoch the concluding write succeeded. NULL until
--                         then.
--   * `delivery_refused_at` — ms epoch GitHub rejected the sweep's write for
--                         the check-run itself (404 or 422). The row leaves
--                         the sweep's queue; NULL otherwise.
--
-- The reconcile sweep re-sends the conclusion of every finished execution with
-- an installation and neither stamp, oldest first (apps/dispatcher
-- delivery-sweep.ts). Rows written before this migration carry no
-- installation, so the sweep leaves them alone.
ALTER TABLE executions ADD COLUMN installation_id INTEGER;
ALTER TABLE executions ADD COLUMN delivered_at INTEGER;
ALTER TABLE executions ADD COLUMN delivery_refused_at INTEGER;
CREATE INDEX IF NOT EXISTS executions_undelivered
  ON executions(completed_at)
  WHERE delivered_at IS NULL AND installation_id IS NOT NULL AND delivery_refused_at IS NULL;
