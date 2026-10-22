// @fractalboxdev/flare-dispatch-runtime-cf — SandboxCloudflareLive: the live `sandbox` capability.
//
// Backs `SandboxService` with the Cloudflare Containers binding, via the
// `@cloudflare/sandbox` SDK. The SDK's `Sandbox` Durable Object wraps a
// container and exposes a typed `exec` / `gitCheckout` surface over RPC;
// `getSandbox(ns, id)` returns the client proxy. `RunSandbox` (apps/dispatcher)
// is a thin `extends Sandbox` so the binding resolves to a class wrangler can
// register as a Container.
//
// ============================================================================
// PR4-RISK — the flagged Containers-API surface (specs/pm/plan.md § 6)
// ============================================================================
//
// The plan flags `SandboxCloudflareLive` as "the most likely spot to discover a
// mismatch between the spec's Sandbox model and the real, evolving Containers
// API." Outcome of building it:
//
//   * `clone` + `exec` — the V0-critical surface — ARE fully implemented
//     against the current `@cloudflare/sandbox` (0.10.x) API. `exec` maps
//     1:1 to `sandbox.exec(command, { cwd, env, timeout })`; `git.clone` is
//     three `exec`s of its own — clone, SHA checkout, credential scrub. The
//     narrow `SandboxService` Tag (clone, exec) is exactly the small surface
//     the plan's mitigation asked for.
//
//     The SDK's `gitCheckout` is deliberately unused: it owns the clone's
//     object filter, and a filtered clone leaves a checkout that needs the
//     network — which this container, by design, can no longer reach once the
//     token is scrubbed. See `cloneCommand` in `sandbox-clone-url.ts`.
//
//   * `acquire` is a no-op handle — the SDK has no explicit "acquire a
//     container" step: `getSandbox(ns, id)` lazily provisions the container on
//     the first `exec`. The V0 model is one container per execution
//     (`id = executionId`), so `acquire` just returns that handle.
//
//   * `runDetached` / `waitForExit` / `waitForPort` — the detached-mode
//     surface `bootApp` rides on — landed in PR9, mapped onto the SDK's
//     `startProcess` / `Process.waitForExit` / `Process.waitForPort`. The V0
//     `Effect.die` stubs are gone: `cdp-acceptance` (V2) needs them.
//
// Container boot itself cannot be exercised in `vitest-pool-workers` (Miniflare
// has no container runtime without Docker), so the integration tests cover
// D1 / R2 / Workflow wiring; this Layer's `exec` / `clone` / detached mapping
// is verified by typecheck + `wrangler deploy --dry-run`. The end-to-end
// container smoke is a `wrangler dev` acceptance.
//
// Spec: specs/01-architecture.md § Sandbox, specs/03-dsl.md § sandbox.

import { getSandbox, type Sandbox, SessionTerminatedError } from "@cloudflare/sandbox";
import { Duration, Effect, Layer } from "effect";
import {
  CheckoutFailed,
  type Container,
  ContainerLaunchFailed,
  type DetachedHandle,
  ExecFailed,
  type ExecResult,
  ExecTimeout,
  type ExposeResult,
  ExposePortFailed,
  PortNeverOpened,
  ReadFileFailed,
  Sandbox as SandboxTag,
  type SandboxService,
  flattenCommand,
} from "@fractalboxdev/flare-dispatch-core";
import { previewSafeSandboxId } from "./preview-sandbox-id";
import { redact } from "./sandbox-output";
import { makeCheckCommandService } from "./check-command-live";
import { execLogFile } from "./log-names";
import type { CheckCommandOwner } from "@fractalboxdev/flare-dispatch-core";
import { resolveCloneToken, type SandboxGithubAuth } from "./sandbox-clone-auth";
import {
  CLONE_TIMEOUT_SEC,
  CLONE_TOKEN_ENV,
  cloneCommand,
  fetchCommitCommand,
  installationLookupSlug,
  repoUrl,
  shellQuote,
} from "./sandbox-clone-url";

/** Normalise a `command` (string | array) to a single shell string. */
const asCommand = flattenCommand;

/**
 * Cap the stdout/stderr *preview* carried inline in the `ExecResult`. The FULL
 * output is always written to R2 (`logPath`); only this tail rides in the
 * step's RETURN VALUE — which Cloudflare Workflows checkpoints and re-reads on
 * every engine replay. A multi-MB inline blob (a verbose Playwright run, a
 * browser-download progress stream) bloats the checkpoint and, when the engine
 * soft-restarts a step, the replay deserialization trips "Worker exceeded CPU
 * time limit". Keeping the inline tail small bounds the checkpoint; the
 * artifact/log uploads still surface the complete output. Matches the
 * `ExecResult.stdout` contract: "last N KB inlined; full log streamed to R2".
 */
const INLINE_TAIL_CHARS = 16 * 1024;
const inlineTail = (s: string, viewerUrl?: string): string =>
  s.length <= INLINE_TAIL_CHARS
    ? s
    : `…[${s.length - INLINE_TAIL_CHARS} chars truncated — ${
        viewerUrl !== undefined ? `full log: ${viewerUrl}` : "full log in R2"
      }]…\n${s.slice(s.length - INLINE_TAIL_CHARS)}`;

/**
 * Scrub `ExecOpts.redactValues` from captured text before it is persisted, so
 * an injected credential a command echoes never reaches a durable surface.
 * Exact-substring match; empty/omitted values is a no-op.
 */

/**
 * Re-raise a clone failure with the installation token scrubbed out of its
 * message.
 *
 * A BACKSTOP, not the primary guard. The token no longer travels in the clone
 * URL (see `CREDENTIAL_HELPER_ARGS`), so git has nothing to quote into the error
 * text it produces — but that text becomes `CheckoutFailed.cause` and is
 * persisted by Workflows as the attempt record, ADR-0006 puts installation
 * tokens on the substrate's never-log list, and a helper script's own stderr is
 * not something this layer authors. So the message is rewritten rather than the
 * original error re-thrown, for a token that arrives by a route the credential
 * design did not anticipate. The original
 * is deliberately NOT attached as `cause`: it still holds the raw text, and
 * attaching it would put the token right back into the record. The error's
 * `name` is preserved so a `GitError` still reads as one.
 */
const redactCloneFailure = (cause: unknown, token: string): Error => {
  const err = new Error(redact(cause instanceof Error ? cause.message : String(cause), [token]));
  if (cause instanceof Error) err.name = cause.name;
  return err;
};

/**
 * Bound the diagnostic string that rides on `ExecFailed.stderrTail` (and thus
 * on `ExecFailed.message`, which Workflows persists as the attempt record).
 * Prefer stdout/stderr when the thrown error carries them; else the message.
 */
export const STDERR_TAIL_MAX = 4 * 1024;
const diagnosticTail = (cause: unknown, redactValues?: readonly string[]): string => {
  let raw: string;
  if (cause instanceof Error) {
    const streams = cause as Error & { stdout?: unknown; stderr?: unknown };
    const parts = [streams.stderr, streams.stdout]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("\n");
    raw = parts.length > 0 ? parts : cause.message;
  } else {
    raw = String(cause);
  }
  raw = redact(raw, redactValues);
  return raw.length <= STDERR_TAIL_MAX
    ? raw
    : `…[${raw.length - STDERR_TAIL_MAX} chars truncated]…\n${raw.slice(-STDERR_TAIL_MAX)}`;
};

/** The subset of the SDK's `ExecResult` this layer consumes. */
interface RawExecResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Detect the shell's "could not enter the working directory" failure.
 *
 * When an `exec`'s `cwd` (the cloned workspace) is GONE at run time — the
 * per-execution container was reaped/recycled between the checkpointed
 * `checkout` step and this `exec` step, leaving a fresh, empty filesystem — the
 * SDK's shell prints `Failed to change directory to '<cwd>'` and exits non-zero
 * WITHOUT ever running the command. That is an INFRA failure, not a command
 * result. Folding it into a normal `ExecResult` is actively misleading: a
 * `failOnNonZeroExit` run (`oxlint`, `offload-test`) then renders it as "oxlint
 * found lint violations" / "tests failed" — a red verdict on a run that never
 * executed. Detecting it here lets `exec` raise `ExecFailed` instead, so it
 * surfaces as a generic, retryable "execution failed" — never a phantom finding.
 *
 * Tight by construction: only when a `cwd` was requested, the command exited
 * non-zero, produced NO stdout, and the shell's directory-change error is on
 * stderr. A real command that itself printed such a line would still have
 * produced stdout or a zero exit. (`SANDBOX_SLEEP_AFTER` in apps/dispatcher
 * keeps the container warm across the inter-step gap so this rarely fires; this
 * is the honesty backstop for the residual eviction/replay cases.)
 */
export const isWorkingDirFailure = (
  r: { readonly exitCode: number; readonly stdout: string; readonly stderr: string },
  cwd: string | undefined,
): boolean =>
  cwd !== undefined &&
  r.exitCode !== 0 &&
  r.stdout === "" &&
  /failed to change directory/i.test(r.stderr);

/**
 * Run a command and ALWAYS resolve to a result when the command *ran* —
 * regardless of its exit code or how its shell ended. Only a genuine
 * could-not-launch / timeout failure rejects (→ `ExecFailed`/`ExecTimeout`).
 *
 * The `@cloudflare/sandbox` SDK rejects `exec` in two cases that are really a
 * *completed* command, not an infra failure:
 *   - `CommandError` — the command exited non-zero (carries exitCode + the
 *     captured stdout/stderr).
 *   - `SessionTerminatedError` — the session's shell exited (the command ran
 *     `exit`, or its last process took the shell down). Carries the exitCode;
 *     stdout/stderr are gone with the session, but anything the command already
 *     wrote to disk (e.g. a Playwright `playwright-report/` + report.json) is
 *     intact for the run's artifact upload.
 *
 * Folding both back into a result is what lets a *failing* `playwright-demo`
 * still upload its `videoUri` (report/trace/video) and `logUri` instead of
 * dying with no output. A failing test is data, not an error.
 *
 * `CommandError` is not exported from the SDK package root, so it's matched by
 * `name` and its public getters (`exitCode`/`stdout`/`stderr`) are read off the
 * instance directly.
 */
const execToResult = async (
  box: Sandbox,
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutSec?: number },
): Promise<RawExecResult> => {
  try {
    const r = await box.exec(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: opts.timeoutSec === undefined ? undefined : opts.timeoutSec * 1000,
    });
    return {
      exitCode: r.exitCode,
      durationMs: r.duration,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  } catch (cause) {
    if (cause instanceof SessionTerminatedError) {
      return {
        exitCode: cause.exitCode ?? 1,
        durationMs: 0,
        stdout: "",
        stderr: `[session shell exited ${cause.exitCode ?? "?"} — stdout/stderr lost with the session; on-disk artifacts (report/trace/video) preserved]`,
      };
    }
    // `CommandError` (non-zero exit) — not exported, matched structurally.
    if (
      cause instanceof Error &&
      cause.name === "CommandError" &&
      typeof (cause as { exitCode?: unknown }).exitCode === "number"
    ) {
      const ce = cause as Error & {
        exitCode: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: ce.exitCode,
        durationMs: 0,
        stdout: ce.stdout ?? "",
        stderr: ce.stderr ?? "",
      };
    }
    throw cause; // genuine could-not-launch / timeout → classified by caller
  }
};

/**
 * Build the live `Sandbox` Layer bound to the Containers binding.
 *
 * One container per execution: the sandbox DO id is the `executionId`, so all
 * steps of one run share a filesystem. The R2 bucket is threaded so `exec`
 * streams each command's captured output to `logs/<execId>/<key>.ndjson` — the
 * `logPath` the `artifact.upload` step then promotes to a stable artifact URL.
 *
 * @param ns           the `RUNS_SANDBOX` DurableObjectNamespace<Sandbox>.
 * @param bucket       the R2 binding — exec log NDJSON sink.
 * @param executionId  the current execution; the sandbox id + R2 log prefix.
 * @param githubAuth   GitHub App credentials, plus the dispatch's installation
 *                     id when there was one. When present, `gitClone`
 *                     authenticates the GitHub HTTPS clone URL with a
 *                     short-lived installation token so private repositories
 *                     are reachable — resolving the installation for the repo
 *                     being cloned when the dispatch did not already name one
 *                     (see `sandbox-clone-auth.ts`). Absent only when the App
 *                     secrets are unconfigured (local dev): clones then go out
 *                     unauthenticated, reaching public repos only.
 * @param previewHostname  the Worker's public domain (e.g.
 *                     `flare-dispatch.<account>.workers.dev`) the SDK uses to
 *                     construct container preview URLs in `exposePort`. A
 *                     deploy-time property; absent, `exposePort` fails with
 *                     `ExposePortFailed` (the SDK cannot build a URL without it),
 *                     so a run that needs a reachable URL fails loudly rather
 *                     than handing the suite an unreachable `localhost`.
 */
export const makeSandboxCloudflareLive = <T extends Sandbox>(
  ns: DurableObjectNamespace<T>,
  bucket: R2Bucket,
  executionId: string,
  githubAuth?: SandboxGithubAuth,
  previewHostname?: string,
  /**
   * The tokened log-viewer base URL for this execution
   * (`https://<origin>/logs/<id>?t=<token>`). When set, the inline-truncation
   * breadcrumb in a checkpointed `ExecResult` points at the readable viewer
   * (deep-linked to the specific log file) instead of the dead-end "full log
   * in R2". `undefined` (no public origin / no log-link secret) keeps the
   * historical message. Built by the dispatcher (it owns the token secret).
   */
  logsViewerBase?: string,
  /**
   * Pin every container this execution acquires to a transport. The runtime
   * always passes one — `resolveSandboxTransport`'s repo pin, else the
   * Worker-wide `SANDBOX_TRANSPORT`, else `rpc` — because the SDK leaves an
   * unpinned container on `http`. `undefined` leaves the SDK default.
   *
   * WHY `rpc`. The SDK's streaming file APIs live only on the `rpc` client —
   * its own comment calls `rpc` the "primary container-control client" and
   * `http`/`websocket` the "route-based compatibility client". `writeFileStream`
   * is a bare `throw` off `rpc`, and the R2 cache's restore hands `writeFile` a
   * `ReadableStream`, which the SDK routes to `writeFileStream` — so off `rpc` a
   * stored archive cannot be applied, and the cache reports it `unapplied`
   * (cache-r2.ts § Transport).
   *
   * A container keeps the transport it started with for its whole life. The
   * SDK prefers a transport written to the DO's storage over the env-derived
   * default on cold start, and `setTransport` persists, so a container pinned
   * here stays pinned whatever the var later says. Ids are per execution, so a
   * changed pin or var takes effect on the next execution.
   */
  transport?: "http" | "websocket" | "rpc",
  checkOwner?: (container: Container) => CheckCommandOwner,
): Layer.Layer<SandboxTag> => {
  // The Durable Object / sandbox id. `getSandbox` routes the DO by this id AND
  // the SDK embeds it in the `exposePort` preview URL's DNS label, which must
  // be lowercase `[a-z0-9-]` and short — so the raw `executionId`
  // (`<run>:<Owner>_<repo>:<sha>`) makes `expose-app` throw `ExposePortFailed`.
  // Normalise once and use the SAME value for every `getSandbox` call of this
  // run (here + the cache/artifact layers via the `acquire` handle below);
  // routing by a different id would resolve to a different container. R2 log
  // keys keep the raw `executionId` for traceability. See preview-sandbox-id.ts.
  const sandboxId = previewSafeSandboxId(executionId);

  // The client for a given handle — the execution's own container when a caller
  // names none.
  //
  // This used to be one client resolved at Layer build, on the reasoning that
  // there is one container per execution. That reasoning was circular: `exec`
  // ignored the `container` handle it was passed, so a run COULD not have two
  // containers, so one client was enough. A run that acquired twice got the
  // same id back and its two acquisitions raced for one filesystem —
  // `git clone` wipes its target directory first, so five "isolated" stages
  // wiped each other's checkout and all five died `CheckoutFailed` in seconds.
  //
  // `getSandbox` is cheap (the container is provisioned lazily on first use),
  // so resolving per call costs nothing and makes the handle mean what every
  // signature in `SandboxService` already said it meant. The cache and artifact
  // layers have always routed by `container.id`; this brings the sandbox layer
  // in line with them.
  const boxFor = (container?: Container): Sandbox => getSandbox(ns, container?.id ?? sandboxId);

  /** Container ids whose transport this Layer has already pinned — see `acquire`. */
  const pinned = new Set<string>();

  // `exec` log keys are unique within a run: the first exec is `exec.ndjson`
  // (the name the plan's acceptance pins), subsequent execs `exec-2.ndjson`, …
  let execSeq = 0;
  const nextLogKey = (): string => {
    execSeq += 1;
    return `logs/${executionId}/${execLogFile(execSeq)}`;
  };

  /** Render captured stdout/stderr as NDJSON and stream it to R2. */
  const writeLog = async (
    key: string,
    command: string,
    stdout: string,
    stderr: string,
  ): Promise<void> => {
    const lines = [
      JSON.stringify({ stream: "meta", command }),
      ...stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.stringify({ stream: "stdout", line })),
      ...stderr
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.stringify({ stream: "stderr", line })),
    ];
    await bucket.put(key, `${lines.join("\n")}\n`, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  };

  /**
   * Best-effort capture of a detached process's logs to R2 on a failure path
   * (a boot that never opened its port, a launch that threw). A detached boot
   * leaves no other diagnostic — without this the `steps` row's `log_uri` is
   * `null` and a failed boot is undebuggable. Returns the R2 `logPath` on
   * success, or `undefined` if logs could not be fetched (e.g. the process had
   * already vanished) — a capture failure must never mask the original error,
   * so every step is swallowed.
   */
  const captureDetachedLog = (
    handleId: string,
    container?: Container,
  ): Effect.Effect<string | undefined> =>
    Effect.promise(async () => {
      try {
        const proc = await boxFor(container).getProcess(handleId);
        if (proc === null) return undefined;
        const logs = await proc.getLogs();
        const logPath = nextLogKey();
        await writeLog(logPath, proc.command, logs.stdout, logs.stderr);
        return logPath;
      } catch {
        return undefined;
      }
    });

  /**
   * Rewrite a checkout's `origin` back to its credential-free URL, so the
   * installation token the clone authenticated with does not outlive the clone.
   *
   * `git clone https://x-access-token:<token>@github.com/o/n.git` persists the
   * whole URL — token included — in `.git/config` as `remote.origin.url`, where
   * it is readable by every command the run afterwards executes INSIDE the
   * container, and by anything that captures the workspace. That is exactly the
   * "no long-lived credential reachable from inside a container, on the
   * filesystem" case ADR-0006 closes, and it now matters on this path for every
   * run rather than only the ones a webhook handed an installation id.
   *
   * `remote set-url` rather than unsetting: a remote with no URL breaks every
   * later `git fetch` the workload runs. The clean URL is the one derived from
   * the slug, never parsed back out of the dirty one — the layer already knows
   * what the remote should say. The `extraheader` and `credential` clauses cover
   * the other two documented ways a token gets persisted.
   *
   * THREE execs, not one chained string, and the split is the whole point. The
   * substrate's equivalent (`apps/substrate/src/engine/git-scrub.ts`) ends every
   * clause in `|| true` because it is deliberately best-effort. Chaining the
   * same shape here and then gating on the compound's exit code does not make it
   * load-bearing — it makes the gate DEAD: `a || true; b || true` exits with the
   * status of the last `|| true`, i.e. always 0, so a `remote set-url` that
   * really failed would report success and hand the workload a `.git/config`
   * still holding a live installation token.
   *
   * So: the rewrite runs alone and ungated-by-`|| true` (its exit code is the
   * signal); the two `config` clauses stay tolerant, because the section/key
   * being absent IS the desired end state; and the result is then VERIFIED
   * in-shell, without the URL ever being emitted (see below).
   */
  const scrubCloneCredential = async (
    targetDir: string,
    originUrl: string,
    // The container holding the checkout being scrubbed. A scrub that ran
    // against the execution's own container while the clone landed in a keyed
    // one would report success having removed nothing.
    container?: Container,
  ): Promise<void> => {
    const dir = shellQuote(targetDir);
    const url = shellQuote(originUrl);
    const target = boxFor(container);

    const setUrl = await target.exec(`git -C ${dir} remote set-url origin ${url}`);
    if (setUrl.exitCode !== 0) {
      throw new Error(
        `clone-credential scrub of ${targetDir} failed: 'git remote set-url' exited ${setUrl.exitCode} — refusing to hand the workload a checkout still holding an installation token: ${setUrl.stderr}`,
      );
    }

    // Tolerant by design: these no-op when the section/key was never written.
    await target.exec(
      [
        `git -C ${dir} config --local --remove-section credential || true`,
        `git -C ${dir} config --local --unset-all http.https://github.com/.extraheader || true`,
      ].join("; "),
    );

    // Verify what the remote actually says now — "the command exited 0" is a
    // weaker claim than "the remote no longer carries userinfo".
    //
    // The test runs INSIDE the shell and emits nothing. Reading the URL out to
    // stdout and inspecting it here would mean that, in exactly the case this
    // guard exists to catch (the scrub failed, the remote is still
    // authenticated), the token is what gets printed — into an `exec` result the
    // SDK may retain and any future capture of the container could reach. A
    // credential must not be emitted to prove it was removed. So the URL is
    // captured by a shell assignment, matched by `case`, and only an exit code
    // crosses back: 3 = could not read the remote, 4 = a credential survived.
    const verify = await target.exec(
      `url=$(git -C ${dir} config --local --get remote.origin.url) || exit 3; case "$url" in *@*) exit 4;; esac`,
    );
    if (verify.exitCode !== 0) {
      throw new Error(
        `clone-credential scrub of ${targetDir} could not be verified (exit ${verify.exitCode}: ${
          verify.exitCode === 4
            ? "remote.origin.url still carries an embedded credential"
            : "could not read remote.origin.url back"
        }) — refusing to hand the workload the checkout`,
      );
    }
  };

  const service: SandboxService = {
    // No explicit acquire in the SDK — the container is provisioned lazily.
    //
    // Unkeyed, this is the execution's own container: the normalised sandbox id
    // (NOT the raw executionId) so the cache + artifact layers, which call
    // `getSandbox(ns, container.id)`, route to the same DO.
    //
    // Keyed, it is a SECOND container for the same execution. The id runs
    // through the same normalisation, over `<executionId>:<key>`, so it
    // inherits the whole budget: DNS-safe, ≤ 40 chars, and digested rather than
    // truncated when it does not fit — which is what keeps two keys of one
    // execution, and the same key of two executions, from colliding onto one
    // filesystem. See preview-sandbox-id.ts for what tail-truncation cost when
    // that was got wrong.
    //
    // Nothing here provisions or leases: a keyed container costs nothing until
    // something execs in it, and it is the caller's to `destroy` — the
    // dispatcher's end-of-run teardown knows the execution's own id and cannot
    // know what a run named.
    acquire: (opts) =>
      Effect.gen(function* () {
        const id =
          opts.key === undefined ? sandboxId : previewSafeSandboxId(`${executionId}:${opts.key}`);
        // Pin the container's transport before anything runs in it, when the
        // caller passed one. See `transport` in this Layer's options for why
        // the pin is per container rather than left to the SDK default.
        //
        // ONCE PER CONTAINER, not once per acquire. `acquire` is also how a
        // caller derives an id without provisioning anything — `ensureWorkspace`
        // re-acquires on a rebuild, and `offload-test`'s stage reaper acquires
        // purely to name the container it is about to destroy. Without this memo
        // each of those would wake a Durable Object to re-assert a setting it
        // already has.
        //
        // Best-effort: a container that stays on the SDK default transport
        // works, it just cannot stream a file. Failing acquisition over a transport
        // preference would trade a slow cache for a dead run.
        if (transport !== undefined && !pinned.has(id)) {
          pinned.add(id);
          yield* Effect.promise(async () => {
            try {
              await getSandbox(ns, id).setTransport(transport);
            } catch (cause) {
              console.warn(
                `setTransport(${transport}) failed for ${id} — staying on the default: ${String(cause)}`,
              );
            }
          });
        }
        return { id } satisfies Container;
      }),

    // Best-effort and idempotent — destroying a container that was never
    // provisioned, or is already gone, is a success. A teardown failure must
    // never become the run's verdict; `sleepAfter` is the backstop.
    destroy: ({ container }) =>
      Effect.promise(async () => {
        try {
          await boxFor(container).destroy();
        } catch {
          /* already gone, or never provisioned */
        }
      }),

    gitClone: ({ repo, sha, container }) =>
      Effect.tryPromise({
        try: async () => {
          const targetDir = `/workspace/${repo.split("/").pop() ?? "repo"}`;
          const originUrl = repoUrl(repo);
          // Authenticate the clone URL whenever GitHub App credentials are
          // wired — which is every deploy that has the App secrets, INCLUDING
          // the Schedule path. The installation is resolved for THIS repo when
          // the dispatch did not already name one, because a run clones repos
          // the dispatch never named (an estate sweep) and an installation
          // covers one account. `resolveCloneToken` raises rather than return
          // nothing, so there is no path from "no installation" to a quiet
          // unauthenticated clone that 404s as a bare git error.
          //
          // The token is short-lived (~1h) and reaches the container only as an
          // environment variable on clone and optional missing-head fetch
          // execs, which a git credential helper reads to answer GitHub's
          // challenge (see
          // `CREDENTIAL_HELPER_ARGS`). It is never embedded in the clone URL, so
          // it is in neither the command string, git's stderr, nor
          // `.git/config`. Both authorized fetches finish before the scrub; the
          // clone brings down the complete history the run needs (see
          // `cloneCommand`). Operator-supplied custom URLs and SSH remotes skip
          // the whole path (see `installationLookupSlug`) — an App token cannot
          // authenticate them, so a clone of one is never blocked on a lookup.
          //
          // The lookup key is derived from the canonical clone URL, NOT from the
          // raw `repo`: a run may name its target as a full `https://github.com/…`
          // URL (`repoUrl` passes those through), and
          // `GET /repos/{owner}/{repo}/installation` takes the SLUG — handed a
          // URL it 404s, failing a clone of a repo that does have an
          // installation.
          const lookupRepo = installationLookupSlug(originUrl);
          const token =
            githubAuth !== undefined && lookupRepo !== undefined
              ? await resolveCloneToken(githubAuth, lookupRepo)
              : undefined;
          // Clear the target BEFORE cloning: `targetDir` is derived from the
          // repo name, so it is the same path for every execution of a repo,
          // and a container whose filesystem is not fresh still has the last
          // execution's tree at it.
          //
          // That is not theoretical. A consumer's run reported
          // `cargo test --workspace` → `Finished in 0.73s` with nothing
          // compiled, against a 14 GB `target/`, on a supposedly fresh clone
          // with no cache entry for its lockfile. A clean workspace cannot do
          // that. Two failures follow, and the quiet one is worse:
          //
          //   * DISK — the leftover build tree fills an 18 GB container disk,
          //     so the run dies on its first write with a bare `disk I/O error`
          //     that names neither the disk nor the workspace.
          //   * CORRECTNESS — the build tool reuses those artifacts. A run whose
          //     sources match the previous execution's rebuilds nothing and
          //     returns a verdict on another commit's code. A merge gate that
          //     tests the wrong tree and reports green is worse than a red one.
          //
          // `git clone` into a non-empty directory fails rather than merging,
          // so this is also what keeps a reused container from erroring on
          // checkout instead of running.
          const clear = await boxFor(container).exec(`rm -rf ${targetDir}`);
          if (clear.exitCode !== 0) {
            throw new Error(`rm -rf ${targetDir} exited ${clear.exitCode}: ${clear.stderr}`);
          }
          try {
            // Plain `git clone`, not the SDK's `gitCheckout`: the SDK owns the
            // clone's flags and offers no way to turn its object filter off, and
            // this checkout has to survive with no credential afterwards (see
            // `cloneCommand`). The URL git is given is the credential-free one;
            // the token rides in `env` and is read back by the credential
            // helper, so the command string holds only the variable's name.
            const cloned = await boxFor(container).exec(
              cloneCommand(originUrl, targetDir, token !== undefined),
              {
                timeout: CLONE_TIMEOUT_SEC * 1000,
                ...(token !== undefined ? { env: { [CLONE_TOKEN_ENV]: token } } : {}),
              },
            );
            if (cloned.exitCode !== 0) {
              throw new Error(`git clone exited ${cloned.exitCode}: ${cloned.stderr}`);
            }
            // The clone lands on the default branch; pin the exact SHA so the
            // run is reproducible.
            let checkout = await boxFor(container).exec(`git checkout ${shellQuote(sha)}`, {
              cwd: targetDir,
            });
            // `git clone` follows branch refs but omits GitHub's persistent
            // `refs/pull/*/head`. A merged PR's source branch can disappear
            // while its immutable head remains fetchable by object id. Fetch
            // only on a missing full SHA, while the installation credential is
            // still available, then pin that exact object before scrubbing.
            if (checkout.exitCode !== 0 && /^[a-f0-9]{40}$/i.test(sha)) {
              const fetched = await boxFor(container).exec(
                fetchCommitCommand(targetDir, sha, token !== undefined),
                {
                  timeout: CLONE_TIMEOUT_SEC * 1000,
                  ...(token !== undefined ? { env: { [CLONE_TOKEN_ENV]: token } } : {}),
                },
              );
              if (fetched.exitCode !== 0) {
                throw new Error(`git fetch ${sha} exited ${fetched.exitCode}: ${fetched.stderr}`);
              }
              checkout = await boxFor(container).exec(`git checkout ${shellQuote(sha)}`, {
                cwd: targetDir,
              });
            }
            if (checkout.exitCode !== 0) {
              throw new Error(
                `git checkout ${sha} exited ${checkout.exitCode}: ${checkout.stderr}`,
              );
            }
          } catch (cause) {
            // A failed clone can still have left a `.git` holding the
            // authenticated remote, so scrub before re-raising. The scrub must
            // not REPLACE the real diagnosis — but it must not vanish either:
            // container filesystems are reused across executions (see the
            // `rm -rf` note above), so a scrub that failed here leaves a live
            // token readable by whatever runs in this container next. Swallowing
            // that silently is the same class of quiet failure this PR exists to
            // remove, so it is appended to the (redacted) error instead.
            if (token !== undefined) {
              const scrubFailure = await scrubCloneCredential(targetDir, originUrl, container).then(
                () => undefined,
                (e: unknown) => (e instanceof Error ? e.message : String(e)),
              );
              const err = redactCloneFailure(cause, token);
              if (scrubFailure !== undefined) {
                // Logged as well as appended: `CheckoutFailed` is retryable in
                // the runs that call `ensureWorkspace`, so an attempt that fails
                // here and a later one that succeeds would carry this notice out
                // of the run's final result and into per-attempt history alone.
                console.warn(
                  `sandbox.clone: credential scrub failed for ${targetDir} — a token may remain in .git/config until the next attempt clears it`,
                );
                err.message = `${err.message}\n[post-failure credential scrub ALSO failed: ${redact(
                  scrubFailure,
                  [token],
                )} — this container may still hold an installation token in ${targetDir}/.git/config]`;
              }
              throw err;
            }
            throw cause;
          }
          // On the success path the scrub is load-bearing, not best effort: the
          // workload is about to run in this container, and it must not find a
          // live installation token in `.git/config`. A scrub that could not run
          // fails the checkout. Redacted like any other clone failure — this
          // throw becomes `CheckoutFailed.cause`, which Workflows persists.
          if (token !== undefined) {
            try {
              await scrubCloneCredential(targetDir, originUrl, container);
            } catch (cause) {
              throw redactCloneFailure(cause, token);
            }
          }
          return targetDir;
        },
        catch: (cause) => new CheckoutFailed({ repo, sha, cause }),
      }),

    exec: ({ command, cwd, env, timeoutSec, redactValues, container }) => {
      const cmd = asCommand(command);
      return Effect.tryPromise({
        // `tryPromise` failure path is `ExecFailed | ExecTimeout` — a command
        // that *could not run as a process*. A command that DID run — any exit
        // code, even one whose shell then exited — is a normal `ExecResult`,
        // folded back from the SDK's CommandError/SessionTerminatedError by
        // `execToResult` so a failing demo still uploads its report + log.
        try: async () => {
          const result = await execToResult(boxFor(container), cmd, { cwd, env, timeoutSec });
          // Scrub any injected secret VALUES before either persisted form
          // (the full R2 log below, and the inline tail further down) is
          // written — see `ExecOpts.redactValues`.
          const stdout = redact(result.stdout, redactValues);
          const stderr = redact(result.stderr, redactValues);
          const logPath = nextLogKey();
          // FULL output → R2 (the durable log the artifact step promotes). Kept
          // even on the working-dir-missing path below, so the failure is
          // diagnosable from the log viewer.
          // The command rides the meta line into R2, so it is a persisted
          // surface too. Scrubbing the streams beside it and leaving it in the
          // clear only holds while no command inlines a credential, and
          // `curl -H "Authorization: Bearer …"` is an ordinary thing for a
          // consumer's own CI to run (adr/0006 § never-log list).
          await writeLog(logPath, redact(cmd, redactValues), stdout, stderr);
          // A command whose shell could not even enter its working directory
          // never ran — the checkout did not survive to this exec (container
          // recycled between durable steps). Raise a real ExecFailed rather than
          // fold a phantom non-zero result a `failOnNonZeroExit` run would render
          // as a lint/test verdict (see `isWorkingDirFailure`). Built here
          // rather than in the `catch`, whose timeout regex would match the
          // `cwd` this message embeds.
          if (isWorkingDirFailure(result, cwd)) {
            throw new ExecFailed({
              exitCode: -1,
              stderrTail: diagnosticTail(
                new Error(
                  `working directory '${cwd}' was missing at exec time — the checkout did not survive to this step (container recycled). stderr: ${stderr.slice(0, 200)}`,
                ),
                redactValues,
              ),
            });
          }
          // Only a bounded TAIL is inlined in the step's return value, so the
          // Workflow checkpoint stays small (see `inlineTail`). When a viewer
          // base is configured, the truncation breadcrumb deep-links to this
          // exec's log file in the readable viewer.
          const file = logPath.slice(logPath.lastIndexOf("/") + 1);
          const viewerUrl = logsViewerBase !== undefined ? `${logsViewerBase}#${file}` : undefined;
          return {
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            logPath,
            stdout: inlineTail(stdout, viewerUrl),
            stderr: inlineTail(stderr, viewerUrl),
          };
        },
        catch: (cause): ExecFailed | ExecTimeout => {
          // The SDK throws on timeout; classify by message, fall back to a
          // generic launch failure. Prefer any stdout/stderr the throw carried
          // (some SDK errors attach them); else the Error message — this is
          // what Workflows persists via ExecFailed.message (#88).
          if (cause instanceof ExecFailed) return cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          if (/timed?\s*out|timeout/i.test(message)) {
            // `ExecTimeout.message` inlines the command and Workflows persists
            // that as the attempt record — a second durable surface, so it
            // takes the same scrub as the R2 log.
            return new ExecTimeout({
              timeoutSec: timeoutSec ?? 0,
              command: redact(cmd, redactValues),
            });
          }
          return new ExecFailed({
            exitCode: -1,
            stderrTail: diagnosticTail(cause, redactValues),
          });
        },
      });
    },

    ...(checkOwner !== undefined
      ? {
          checkCommand: makeCheckCommandService(
            executionId,
            sandboxId,
            checkOwner,
            bucket,
            writeLog,
            inlineTail,
          ),
        }
      : {}),

    // Full-content file read — the companion to `exec` for outputs larger
    // than the inlined stdout tail (see `inlineTail`). The SDK's `readFile`
    // streams the file over HTTP from the container, so multi-hundred-KB
    // text (a big `git diff --output`) arrives intact. The result is NOT
    // checkpointed here — bounding what flows into a Workflow checkpoint is
    // the CALLER's job (e.g. pr-review caps the diff inside its step).
    readFile: ({ path, container }) =>
      Effect.tryPromise({
        try: async () => {
          const result = await boxFor(container).readFile(path);
          if (!result.success) {
            throw new Error(`readFile ${path} reported success=false`);
          }
          return result.content;
        },
        catch: (cause) =>
          new ReadFileFailed({
            path,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),

    // Detached execution (PR9) — `bootApp`'s "start the app, return at once"
    // path. `startProcess` launches a long-running process; the run later
    // recovers it by id via `getProcess` to wait on its port / its exit.
    runDetached: ({ command, cwd, env, timeoutSec, container }) => {
      const cmd = asCommand(command);
      return Effect.tryPromise({
        try: async () => {
          const proc = await boxFor(container).startProcess(cmd, {
            cwd,
            env,
            timeout: timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
          return {
            id: proc.id,
            container: { id: executionId },
          } satisfies DetachedHandle;
        },
        // No container image in scope here — the failure is a process-launch
        // failure, the closest tag the `SandboxService` contract offers.
        catch: (cause) => new ContainerLaunchFailed({ image: "", cause }),
      });
    },

    waitForExit: ({ handle }) =>
      Effect.tryPromise({
        try: async (): Promise<ExecResult> => {
          const startedAt = Date.now();
          const proc = await boxFor(handle.container).getProcess(handle.id);
          if (proc === null) {
            throw new Error(`detached process ${handle.id} not found`);
          }
          const exit = await proc.waitForExit();
          const logs = await proc.getLogs();
          const logPath = nextLogKey();
          await writeLog(logPath, proc.command, logs.stdout, logs.stderr);
          return {
            exitCode: exit.exitCode,
            durationMs: Date.now() - startedAt,
            logPath,
            stdout: logs.stdout,
            stderr: logs.stderr,
          };
        },
        // `waitForExit` only fails its Effect on a timeout / a vanished
        // process — a non-zero exit is a normal `ExecResult` above.
        catch: (cause): ExecTimeout =>
          new ExecTimeout({
            timeoutSec: 0,
            command: `detached:${handle.id} — ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          }),
      }),

    waitForPort: ({ handle, port, timeoutSec }) => {
      // The SDK's own `timeout` option is passed through, but it is not
      // reliably honored — in practice a hung boot blocks far past the ceiling
      // (a single attempt, not retries). Enforce the ceiling at the Effect
      // layer with `Effect.timeoutFail` so the wait fails fast at `timeoutSec`
      // regardless of SDK behavior.
      const sdkWait = Effect.tryPromise({
        try: async () => {
          const proc = await boxFor(handle.container).getProcess(handle.id);
          if (proc === null) {
            throw new Error(`detached process ${handle.id} not found`);
          }
          // TCP mode: the app is "up" once the port accepts connections — it
          // need not yet answer 2xx at `/`.
          await proc.waitForPort(port, {
            mode: "tcp",
            timeout: timeoutSec === undefined ? undefined : timeoutSec * 1000,
          });
        },
        catch: (): PortNeverOpened => new PortNeverOpened({ port, timeoutSec: timeoutSec ?? 0 }),
      });

      const bounded =
        timeoutSec === undefined
          ? sdkWait
          : sdkWait.pipe(
              Effect.timeoutFail({
                duration: Duration.seconds(timeoutSec),
                onTimeout: () => new PortNeverOpened({ port, timeoutSec }),
              }),
            );

      // On any failure (SDK throw or the Effect-level timeout), best-effort
      // capture the detached process's logs and re-fail with the `logPath`
      // attached — the only diagnostic a failed detached boot leaves behind.
      return bounded.pipe(
        Effect.catchTag("PortNeverOpened", (err) =>
          captureDetachedLog(handle.id, handle.container).pipe(
            Effect.flatMap((logPath) =>
              Effect.fail(
                new PortNeverOpened({
                  port: err.port,
                  timeoutSec: err.timeoutSec,
                  logPath,
                }),
              ),
            ),
          ),
        ),
      );
    },

    exposePort: ({ port, name, container }) =>
      previewHostname === undefined
        ? Effect.fail(
            new ExposePortFailed({
              port,
              cause: "no preview hostname configured — cannot construct a public URL",
            }),
          )
        : Effect.tryPromise({
            try: async (): Promise<ExposeResult> => {
              // The SDK builds the preview URL from the Worker's domain
              // (`hostname`) + the port; the process bound to the container's
              // `localhost:<port>` becomes reachable at the returned URL.
              const { url } = await boxFor(container).exposePort(port, {
                hostname: previewHostname,
                name,
              });
              return { url };
            },
            catch: (cause) => new ExposePortFailed({ port, cause }),
          }).pipe(
            // The Workflow records only the tagged error; the underlying SDK
            // cause (e.g. `SandboxSecurityError: Preview URLs require lowercase
            // sandbox IDs`) is otherwise lost. Log it so a failed `expose-app`
            // is diagnosable from `wrangler tail` without DO-internal access.
            Effect.tapError((e) =>
              Effect.logError("exposePort failed", {
                port,
                sandboxId,
                previewHostname,
                cause: e.cause,
              }),
            ),
          ),
  };

  return Layer.succeed(SandboxTag, service);
};
