# ADR-0007 — Cost-efficient execution: dispatch only work, upload each cache key once, build heavy native dependencies once

**Status:** proposed
**Related:** `apps/dispatcher/src/routes/webhook.ts` · `runs/check.ts` · `runs/offload-test.ts` · `runs/worker-deploy.ts` · `packages/runtime-cf/src/cache-r2.ts` · `packages/runtime-cf/src/cache-restore-or.ts` · `runs/contextful-gate.ts` · `infra/Dockerfile.sandbox-demo` · ADR-0006

## Context

A deploy pays for container time, and three patterns spend it on nothing:

- A webhook run on a repo that never opted in creates a Workflow, opens a
  check-run, waits for an admission slot, starts a container, and only then
  reads `CONFIG_KV` and ends green with nothing done. Each one also holds a
  pool slot that real work waits for.
- A cache restore that finds its archive but cannot apply it falls through to
  the miss path: the run installs from scratch, then packs and uploads the
  same content-addressed archive again. On the http sandbox transport every
  stream restore fails this way, so every run of a fan-out re-uploads the
  archive that already sits in R2.
- Every part of a fan-out gate clones and compiles the same dependency graph
  in a fresh container. A bundled C++ dependency such as DuckDB rebuilds its
  engine from source in each part and dominates that compile.

ADR-0006 caps what a deploy spends. This record lowers what each verdict costs,
so a budget buys more checks.

## Decision

### Dispatch only work

- A run may declare `optIn: (ctx) => readonly string[]`, the `CONFIG_KV` keys
  whose presence means the repo opted in. `check`, `offload-test` and
  `worker-deploy` declare the command keys their bodies read today.
- The webhook receiver reads those keys before it creates a Workflow. With
  none present it dispatches nothing, opens no check-run, and lists the run in
  the response's `skipped` array with reason `not-configured`.
- A dispatch that names its command explicitly, from an Action or a fan-out
  parent, skips the opt-in read.
- The run bodies keep their own opt-in check, so a key deleted between
  dispatch and run still ends in a no-op.

### Upload each cache key once

- A restore reports one of three outcomes: `hit`, `miss` (no archive under
  the key), or `unapplied` (the archive exists, applying it failed).
- `unapplied` runs the miss path and skips the save: the key is
  content-addressed, so the archive in R2 already holds this content.
- A save checks `bucket.head` for its key before it packs. An existing
  archive skips the `tar czf` and the upload. Parallel misses on one key then
  upload once instead of once per part.
- A restore on a transport that cannot stream into the container reports
  `unapplied` without reading the archive body, and logs the transport once
  per execution.

### Fan-out parts install nothing their stage repeats

- A gate part whose stage command resolves its own dependencies, as `cargo`
  does on build, spawns with `install: false` and restores only what the
  stage cannot rebuild cheaply, such as a prebuilt tool binary.

### Prebuilt heavy native dependencies in the image

- The Rust variant of the lean sandbox image ships sha256-pinned prebuilt shared libraries and
  headers for native dependencies that dominate a cold compile, DuckDB first,
  and exports the paths the dependency's build script reads in linked mode
  (`DUCKDB_LIB_DIR`, `DUCKDB_INCLUDE_DIR`).
- The variables change nothing for a consumer that builds the dependency
  bundled: the build script reads them only in linked mode. A consumer opts
  in by building the dependency linked in CI. The consumer owns that choice,
  and it asserts the loaded library's version at startup, because a linked
  library of the wrong version compiles cleanly and misbehaves at runtime.
- The image's library version and the consumer's pinned crate version move
  together.

### Shared compile cache

- A run whose definition answers `compileCache` with a lane compiles Rust
  through sccache. Every contextful gate part does. The dispatcher's
  `/v1/compile-cache` route serves sccache's WebDAV backend (GET, HEAD, PUT,
  `Depth: 0` PROPFIND, MKCOL) from `RUNS_STORAGE` under
  `compile-cache/<owner>/<name>/@<lane>/`; the client's key prefix below that
  is `<repo>/<rustc release>/<host triple>`.
- The dispatcher mints one token per execution: an HMAC under a key derived
  from `HMAC_SECRET`, bound to the repository, execution and lane, expiring at
  the instance's creation plus its queue age and `maxDurationSec`. A token for
  another repository, a forged one and an expired one are refused.
- The lane decides writes and reads. `base` belongs to default-branch
  executions and reads and writes `@base`. `pr-<n>` writes `@pr-<n>` and reads
  it, then `@base`. `read-only` reads `@base` and writes nothing. No execution
  reads another pull request's lane.
- One entry is at most `COMPILE_CACHE_MAX_OBJECT_BYTES`. Every PUT reserves its
  length in the repository's ledger, a Durable Object, against
  `COMPILE_CACHE_MAX_REPO_BYTES` for the repository and
  `COMPILE_CACHE_MAX_EXECUTION_BYTES` for the execution. When the run ends the
  workflow ends the execution's record, and its token writes nothing more.
- The hourly sweep lists up to 500 pages per tick and resumes from its stored
  cursor. It deletes entries older than `COMPILE_CACHE_TTL_DAYS`. For a
  repository listed whole within a tick, it evicts the oldest entries down to
  90% of the ceiling and sets the ledger to the measured size. A GET of an
  entry older than half the TTL rewrites it, so age counts from last use.
- A cache outage never fails a part: the wrapper starts the sccache server
  first and compiles without `RUSTC_WRAPPER` when it does not start; a started
  server reads an unreachable entry as a miss.

## Rationale

The receiver is the last point where skipping costs nothing: past it, a skip
still pays for a Workflow, a check-run and a slot. Keeping the body's check
makes the receiver read an optimisation rather than the only line of defence.

A content-addressed key makes a second upload pure waste, so the head check is
always safe. Separating `unapplied` from `miss` keeps a broken restore visible
in logs without paying for it in container time.

Thirty gate parts each compiled the same workspace cold; a content-addressed
compiler cache turns all but the first compile of each crate into a read.
sccache's WebDAV backend needs no cloud credentials in the container, so the
Worker's R2 binding stays the only storage authority.

Pull-request code runs with its token in its environment, and sccache trusts
whatever an entry holds. A shared writable prefix would let one pull request
plant an artifact that another pull request's gate, or a default-branch gate,
links and runs. Lanes confine each pull request's writes to itself. A ledger
counted at admission keeps the byte bound against a client that ignores
sccache's write pattern, where a bound measured hourly would not.

Building a C++ engine from source in every part buys nothing a prebuilt
library does not, and only the consumer can decide whether CI may link it
dynamically while release builds stay static.

## Consequences

- Webhook responses on unconfigured repos list `skipped` runs. Those repos no
  longer receive green no-op check-runs.
- A broken restore still costs a cold install per part until the transport is
  fixed, but no longer a repeated pack and upload.
- The lean image grows by the prebuilt libraries' size.
- A pull request reuses entries across its own pushes and the default
  branch's entries. It reuses nothing another pull request compiled. Only
  default-branch executions write `@base`. A gate whose default-branch tier
  runs other parts than its pull-request tier therefore populates `@base` only
  for the compiles those parts share.
- A pull request's lane holds its entries until they expire, after the pull
  request closes too.
- A deploy whose `wrangler.jsonc` lacks the `COMPILE_CACHE_LEDGER` binding
  serves compile-cache reads and refuses every write.

## Revisit triggers

- A restore path reaches the container without passing through the Worker,
  such as a signed R2 URL, at a throughput that makes a shared build cache pay.
- A consumer's opt-in needs more than the presence of a `CONFIG_KV` key.
