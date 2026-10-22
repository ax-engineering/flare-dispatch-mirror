# Architecture decision records

Decisions that settle a direction the rest of the repo then assumes. One file per
decision, numbered, never edited after acceptance — a superseding decision gets a new
record that names the one it replaces. Format: Status / Context / Decision / Rationale /
Consequences / Revisit triggers.

A record is only binding once its Status reads `accepted`. Treat `proposed` rows as
under discussion — in particular, do not implement against a proposed record's
interfaces or assume they exist.

| ADR                                             | Status   | Decision                                                                                                                                                                                                     |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [0001](./0001-cloudflare-workflows-scope.md)    | proposed | How runs use Cloudflare Workflows: one instance per dispatch, hibernation reserved for bounded human decisions, entity lifecycles keep state in the system of record, container disk is never durable state  |
| [0002](./0002-memory-capability.md)             | proposed | Org context is an optional, total `memory` capability with MCP-speaking adapters; runs consume, never produce                                                                                                |
| [0003](./0003-no-context-relay.md)              | proposed | Context backends ingest GitHub directly; FlareDispatch builds no relay, export, or pull endpoint for them                                                                                                    |
| [0004](./0004-serialized-run-groups.md)         | proposed | A run may declare a serialization group: one execution in flight, newest waiter wins, never cancel the running one; state in D1                                                                              |
| [0005](./0005-superseded-run-groups.md)         | proposed | A run may declare a supersession group: the highest-ranked member cancels every lower live one with its children, slots and checks                                                                           |
| [0006](./0006-spend-guard.md)                   | proposed | A monthly budget closes admission and a burn ceiling caps the summed hourly rate of admitted runs; both default low in code                                                                                  |
| [0007](./0007-cost-efficient-execution.md)      | proposed | Dispatch only opted-in work, upload each content-addressed cache key once, build heavy native dependencies once in the image                                                                                 |
| [0008](./0008-cheaper-waiting-and-transport.md) | proposed | rpc sandbox transport by default, admission polls scaled by queue position, one log line per supersession                                                                                                    |
| [0009](./0009-fast-trustworthy-verdicts.md)     | proposed | Interactive admission class ahead of batch, budgeted and reconciled check-run delivery, a light pull-request tier with the heavy gate on the default branch, pool caps as upper bounds under the spend guard |
