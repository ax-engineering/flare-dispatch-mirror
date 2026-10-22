// @fractalboxdev/flare-dispatch-runtime-cf — CacheR2Live: the live `cache` capability.
//
// Backs `CacheService` with the R2 bucket + the Containers binding. A cache
// entry is a single gzipped tar of the requested paths.
//
//   * restoreOr — `bucket.get` the archive; on a hit, stream it into the
//     container and `tar xzf` it in place. On a miss — or a restore error —
//     run `onMiss`, then best-effort `save`. An archive that exists but does
//     not apply is `unapplied`: `onMiss` runs and the save is skipped.
//   * save — `bucket.head` the key first; an archive already stored skips the
//     pack and the upload. Otherwise `tar czf` the paths inside the container,
//     stream the archive out, and `bucket.put` it.
//
// --- Transport ---------------------------------------------------------------
//
// Streaming a body into the container (`writeFile` with a stream) exists only
// on the SDK's `rpc` transport; on `http` / `websocket` it throws. Containers
// run on `rpc` unless a repo pin or the Worker-wide var says otherwise
// (sandbox-transport.ts), so a restore streams by default. A restore on
// another transport reads only the archive's `head` and reports `unapplied`, so
// the run pays for neither the download nor a re-upload of an archive R2
// already holds. The transport is logged once per Layer instance: once per
// execution, again after a Workflow replay rebuilds the runtime.
//
// --- Cache key isolation (review fix) ---------------------------------------
//
// The R2 bucket is shared across every repo the Dispatcher serves, so the
// archive key MUST be scoped per repo — otherwise two repos with an identical
// lockfile hash would collide and one could restore (and execute) a
// `node_modules` tree another repo populated: a cross-repo cache-poisoning
// vector. The key is `cache/<repo>/<lockfile-key>.tar.gz`; `<repo>` is the
// owner/name slug threaded in by `makeCFRuntimeLive` from the execution
// context. Within a repo, entries are still reused across executions.
//
// Caching is an optimization, never a correctness primitive: the hit/miss/
// error orchestration lives in `composeRestoreOr` (cache-restore-or.ts, pure
// + unit-tested); this file wires the container-backed `restore` / `save`.
//
// ============================================================================
// Verification scope — same constraint as sandbox-cf.ts
// ============================================================================
//
// The container side (`tar`, `readFileStream`, `writeFile`) cannot run in
// `vitest-pool-workers` — Miniflare has no container runtime. The live
// `restore` / `save` closures are covered by cache-r2-live.test.ts against a
// mocked `getSandbox` and a fake bucket; their orchestration by
// cache-r2.test.ts via `composeRestoreOr` / `composeSave` with fakes.
//
// Spec: specs/03-dsl.md § cache, specs/02-runs.md § cache-pnpm, plan § PR8,
// specs/adr/0007-cost-efficient-execution.md § Upload each cache key once.

import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { Effect, Layer } from "effect";
import { Cache, CacheError, type CacheService } from "@fractalboxdev/flare-dispatch-core";
import { readContainerFile } from "./container-file-stream";
import { putStream } from "./r2-put-stream";
import type { SandboxTransport } from "./sandbox-transport";
import {
  composeRestoreOr,
  composeSave,
  type ExistsFn,
  type RestoreFn,
  type RestoreOutcome,
  type SaveFn,
} from "./cache-restore-or";

/** Per-repo, content-addressed R2 key for a cache entry. */
const archiveKey = (repo: string, key: string): string => `cache/${repo}/${key}.tar.gz`;

/** In-container scratch path the tarball is packed to / extracted from. */
const TARBALL_PATH = "/tmp/fd-cache.tar.gz";

/**
 * Build the live `Cache` Layer bound to an R2 bucket and the Containers
 * binding. Cache entries are reused across executions but isolated per repo.
 *
 * @param bucket  the R2 binding (`env.RUNS_STORAGE`).
 * @param ns      the `RUNS_SANDBOX` namespace for the supplied Sandbox subclass.
 * @param repo    the `owner/name` slug — scopes the archive key per repo.
 * @param transport the transport this execution's containers run on, as
 *                `resolveSandboxTransport` resolved it — only `rpc` can stream
 *                an archive into a container.
 */
export const makeCacheR2Live = <T extends Sandbox>(
  bucket: R2Bucket,
  ns: DurableObjectNamespace<T>,
  repo: string,
  transport: SandboxTransport,
): Layer.Layer<Cache> => {
  const streams = transport === "rpc";
  let transportLogged = false;
  const logTransportOnce = Effect.suspend(() => {
    if (transportLogged) return Effect.void;
    transportLogged = true;
    return Effect.logWarning(
      `cache: the ${transport} sandbox transport cannot stream an archive into a container — stored archives report unapplied for this execution`,
    );
  });

  const exists: ExistsFn = (key) =>
    Effect.tryPromise({
      try: async () => (await bucket.head(archiveKey(repo, key))) !== null,
      catch: (cause) => new CacheError({ phase: "save", key, cause }),
    });

  const pack: SaveFn = (opts) =>
    Effect.tryPromise({
      try: async () => {
        const box = getSandbox(ns, opts.container.id);
        const tar = await box.exec(`tar czf ${TARBALL_PATH} ${opts.paths.join(" ")}`, {
          cwd: opts.base ?? opts.dir,
        });
        if (tar.exitCode !== 0) {
          throw new Error(`tar czf exited ${tar.exitCode}: ${tar.stderr}`);
        }
        // STREAM the archive into R2 — a node_modules / pnpm-store tarball can
        // be hundreds of MB, well past the Worker's 128 MB isolate budget if
        // buffered whole. `stat` + `readFileStream`, NOT
        // `readFile({encoding:'none'})` — that variant is rpc-transport-only
        // and broke the container upload path on the deployed dispatcher
        // (#88); see container-file-stream.ts.
        const { content, size } = await readContainerFile(box, TARBALL_PATH);
        await putStream(bucket, archiveKey(repo, opts.key), content, size, {
          contentType: "application/gzip",
        });
      },
      catch: (cause) => new CacheError({ phase: "save", key: opts.key, cause }),
    });

  const restore: RestoreFn = (opts) =>
    Effect.gen(function* () {
      const objectKey = archiveKey(repo, opts.key);
      if (!streams) {
        const stored = yield* Effect.tryPromise({
          try: () => bucket.head(objectKey),
          catch: (cause) => new CacheError({ phase: "restore", key: opts.key, cause }),
        });
        if (stored === null) return "miss" as const;
        yield* logTransportOnce;
        return "unapplied" as const;
      }
      const archive = yield* Effect.tryPromise({
        try: () => bucket.get(objectKey),
        catch: (cause) => new CacheError({ phase: "restore", key: opts.key, cause }),
      });
      if (archive === null) return "miss" as const;
      return yield* Effect.tryPromise({
        try: async (): Promise<RestoreOutcome> => {
          const box = getSandbox(ns, opts.container.id);
          try {
            await box.writeFile(TARBALL_PATH, archive.body);
          } catch (cause) {
            // An unread body holds the R2 read open; a locked one rejects the
            // cancel, which changes nothing.
            await archive.body.cancel().catch(() => undefined);
            throw cause;
          }
          const untar = await box.exec(`tar xzf ${TARBALL_PATH}`, {
            cwd: opts.base ?? opts.dir,
          });
          if (untar.exitCode !== 0) {
            throw new Error(`tar xzf exited ${untar.exitCode}: ${untar.stderr}`);
          }
          return "hit";
        },
        catch: (cause) => new CacheError({ phase: "restore", key: opts.key, cause }),
      }).pipe(
        Effect.catchAll((e) =>
          Effect.as(Effect.logWarning(`${e.message} — stored archive unapplied`), "unapplied" as const),
        ),
      );
    });

  const save = composeSave(exists, pack);

  const service: CacheService = {
    restoreOr: composeRestoreOr(restore, save),
    save,
  };

  return Layer.succeed(Cache, service);
};
