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

- A run whose definition answers `compileCache` with `true` compiles Rust
  through sccache. Every contextful gate part does. The dispatcher's
  `/v1/compile-cache` route serves sccache's WebDAV backend (GET, HEAD, PUT,
  `Depth: 0` PROPFIND, MKCOL) from `RUNS_STORAGE` under
  `compile-cache/<owner>/<name>/`; the client's key prefix below that is
  `<repo>/<rustc release>/<host triple>`.
- The dispatcher mints one token per execution: an HMAC under a key derived
  from `HMAC_SECRET`, bound to the repository and execution, expiring at the
  instance's creation plus its queue age and `maxDurationSec`. A token for
  another repository, a forged one and an expired one are refused.
- One entry is at most `COMPILE_CACHE_MAX_OBJECT_BYTES`, one repository prefix
  at most `COMPILE_CACHE_MAX_REPO_BYTES` as of the last hourly sweep, and an
  entry older than `COMPILE_CACHE_TTL_DAYS` is deleted. The sweep evicts the
  oldest-written entries down to 90% of the ceiling.
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

Building a C++ engine from source in every part buys nothing a prebuilt
library does not, and only the consumer can decide whether CI may link it
dynamically while release builds stay static.

## Consequences

- Webhook responses on unconfigured repos list `skipped` runs. Those repos no
  longer receive green no-op check-runs.
- A broken restore still costs a cold install per part until the transport is
  fixed, but no longer a repeated pack and upload.
- The lean image grows by the prebuilt libraries' size.
- Pull-request parts write to the repository's shared prefix, so a
  same-repository pull request can place an entry a later default-branch
  part reads.

## Revisit triggers

- A restore path reaches the container without passing through the Worker,
  such as a signed R2 URL, at a throughput that makes a shared build cache pay.
- A consumer's opt-in needs more than the presence of a `CONFIG_KV` key.
