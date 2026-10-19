// @fractalboxdev/flare-dispatch-runtime-cf — SandboxFacadeLive: the `sandbox` capability over
// the substrate's service-binding facade.
//
// The same `SandboxService` contract `sandbox-cf.ts` implements against a
// Containers binding, implemented instead against `DispatcherFacade` — so a run
// body is unchanged and the dispatcher holds no container class, no DO binding
// and no grant vocabulary (ADR-0003).
//
// What moves across the boundary, and what does not:
//
//   * `acquire` / `gitClone` → `ensureSandbox`. The substrate clones from the
//     RECIPE, not from a command we send: the repository the egress policy is
//     asserted against has to be an input no model authored, and a clone driven
//     by consumer-side `git` would put the URL back in the workload's reach.
//   * `exec` → `execUnderGrant`, which runs the whole fence (stale-revoke,
//     ensure, apply grant, run, kill-before-revoke) inside the substrate. The
//     substrate dedupes on the idempotency key this layer derives, so the key
//     has to carry the ENCLOSING STEP as well as the command — see
//     `idempotencyKeyFor`.
//   * `readFile` → `readFile`. No grant, no command.
//   * `runDetached` / `waitForExit` / `waitForPort` / `exposePort` → typed
//     failures naming the gap. The facade DOES serve detached processes
//     (`startDetached` / `detachedStatus` / `stopDetached`, ADR-0012: such a
//     process holds no grant); what is missing is this adapter's wiring to it
//     and the run bodies still calling `sandbox.runDetached`. `exposePort` is
//     the one deliberate exclusion — preview URLs stay off the facade until the
//     substrate worker owns a proxy route. `grant-catalog.ts` keeps the runs
//     that need them off this path, so these branches are unreachable in
//     production — they exist so the failure is legible if that ever stops
//     being true. Each stub's own `cause` carries the specific reason.
//
// Logs: the substrate streams a command's full output to its own artifact mount
// and returns a bounded tail. This layer writes that tail to the dispatcher's
// R2 log key so `artifact.upload` (R2-source mode) and the log viewer keep
// working unchanged — a run's `logPath` still resolves. The full log lives in
// the substrate's per-execution artifact prefix.

import { Effect, Layer, Match, Option } from "effect";
import type {
  ApprovalAttestation,
  EnforcementPosition,
  GrantProfileName,
  SubstrateFacade,
  SubstrateRecipe,
  SubstrateRefusal,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  Cache as CacheTag,
  CheckoutFailed,
  type Container,
  ContainerBusy,
  ContainerLaunchFailed,
  CurrentStep,
  ExecFailed,
  type ExecResult,
  ExecTimeout,
  ExposePortFailed,
  PortNeverOpened,
  ReadFileFailed,
  Sandbox as SandboxTag,
  type SandboxService,
  flattenCommand,
} from "@fractalboxdev/flare-dispatch-core";
import { execLogFile } from "./log-names";

/** The workspace the substrate clones into — fixed, and not consumer-chosen. */
export const SUBSTRATE_WORKSPACE = "/workspace";

/**
 * How much of a command's output rides back through the facade. The substrate
 * keeps the full log; this is what gets written to the dispatcher's R2 key and
 * (clamped again) inlined into the Workflow checkpoint.
 */
const TAIL_BYTES = 256 * 1024;
const INLINE_TAIL_CHARS = 16 * 1024;

const inlineTail = (s: string, viewerUrl?: string): string =>
  s.length <= INLINE_TAIL_CHARS
    ? s
    : `…[${s.length - INLINE_TAIL_CHARS} chars truncated — ${
        viewerUrl !== undefined ? `full log: ${viewerUrl}` : "full log in the substrate's artifacts"
      }]…\n${s.slice(s.length - INLINE_TAIL_CHARS)}`;

/** Exact-substring scrub of injected secret values, before anything is persisted. */
const redact = (text: string, values?: readonly string[]): string => {
  if (values === undefined || values.length === 0) return text;
  let out = text;
  for (const value of values) {
    if (value.length === 0) continue;
    out = out.split(value).join("***");
  }
  return out;
};

/** Normalise a `command` (string | array) to a single shell string. */
const asCommand = flattenCommand;

/** Lowercase hex SHA-256. */
const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * A refusal rendered for a log line or an error tail — never an opaque throw.
 *
 * `discriminatorsExhaustive` rather than a `switch`: the contract's refusal
 * union is the substrate's to grow, and a new kind must break this build rather
 * than fall through to `undefined` in a check-run summary a human is reading to
 * find out why their run stopped.
 */
export const describeRefusal: (refusal: SubstrateRefusal) => string =
  Match.type<SubstrateRefusal>().pipe(
    Match.discriminatorsExhaustive("kind")({
      "admission-refused": (r) =>
        r.timedOut
          ? `substrate admission timed out: queued ${r.queuedForMs ?? 0}ms behind pool ${r.pool} at ${r.poolBusy}/${r.cap} busy`
          : `substrate admission refused: pool ${r.pool} is ${r.poolBusy}/${r.cap} busy`,
      "approval-required": (r) =>
        `substrate refused an irreversible command: the run definition does not pre-assert "${r.rule}"`,
      "attestation-rejected": (r) => `substrate rejected the approval attestation: ${r.reason}`,
      "budget-stop": (r) =>
        `substrate budget stop (${r.scope}): $${r.meter.spentUsd} of $${r.meter.capUsd}`,
      "recipe-rejected": (r) => `substrate rejected the recipe: ${r.reason}`,
      "ticket-rejected": (r) => `substrate admission ticket rejected: ${r.reason}`,
      "sandbox-unavailable": (r) => `substrate sandbox unavailable: ${r.reason}`,
    }),
  );

export type SandboxFacadeOptions = {
  /** The `SUBSTRATE` service binding, entrypoint `DispatcherFacade`. */
  readonly facade: SubstrateFacade;
  /** R2 binding — where this layer writes each command's returned tail. */
  readonly bucket: R2Bucket;
  /** This execution's ULID: the sandbox key, the R2 log prefix, the attestation's taskId. */
  readonly executionId: string;
  /** The run being executed — selects its catalog entry's grant and pre-assertions. */
  readonly run: string;
  /** repo/sha the dispatch named. The substrate clones from this, never from a command. */
  readonly repo: string;
  readonly sha: string;
  /** Profiles selected by the run's reviewed catalog entry (never by a payload). */
  readonly profiles: readonly GrantProfileName[];
  /** Concrete dynamic hosts, already checked against the run definition's pattern. */
  readonly targets?: readonly string[];
  /** Rollout position for this run (ADR-0005). */
  readonly enforcement: EnforcementPosition;
  readonly lfs?: boolean;
  /**
   * Mints the `approvedBy: "run-definition"` attestation for a command the run's
   * definition pre-asserts, or `undefined` (ADR-0007). Passed as a closure so
   * the catalog stays in the dispatcher and this layer stays run-agnostic.
   */
  readonly approvalFor?: (
    command: string,
    scope: { taskId: string; ordinal: number },
  ) => Promise<ApprovalAttestation | undefined>;
  /** Tokened log-viewer base for the truncation breadcrumb. */
  readonly logsViewerBase?: string;
};

/**
 * Build the live `Sandbox` Layer bound to the substrate facade.
 *
 * The recipe is built once and rides every call: it is what makes
 * restore-or-rebuild decidable without the substrate ever reading state back
 * from a consumer, and it is the input the egress grant is derived from.
 */
export const makeSandboxFacadeLive = (opts: SandboxFacadeOptions): Layer.Layer<SandboxTag> => {
  const [owner = "", name = ""] = opts.repo.split("/");
  const recipe: SubstrateRecipe = {
    // The recipe version is what a restore is keyed to. The sha is the tree the
    // run is about, so a new commit is a new version rather than a stale
    // restore — hashing it to a number keeps the field an integer without
    // pretending the sha is one.
    version: [...opts.sha].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 2_147_483_647, 7),
    repo: { owner, name, ref: opts.sha },
    profiles: opts.profiles,
    ...(opts.targets !== undefined && opts.targets.length > 0 ? { targets: opts.targets } : {}),
    enforcement: opts.enforcement,
    ...(opts.lfs === true ? { lfs: true } : {}),
  };

  const key = opts.executionId;

  // Log keys come from the shared grammar (log-names.ts), so the viewer, the
  // artifact route and the `logs/<exec>/exec.ndjson` acceptance all resolve.
  let execSeq = 0;
  const nextLogKey = (): string => {
    execSeq += 1;
    return `logs/${opts.executionId}/${execLogFile(execSeq)}`;
  };

  const writeLog = async (key: string, command: string, tail: string): Promise<void> => {
    const lines = [
      JSON.stringify({ stream: "meta", command }),
      ...tail
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.stringify({ stream: "stdout", line })),
    ];
    await opts.bucket.put(key, `${lines.join("\n")}\n`, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  };

  /**
   * The idempotency key one command runs under.
   *
   * Scoped to the enclosing durable step, then to the command text and its
   * working directory. Both halves are load-bearing.
   *
   * A COUNTER is not replay-stable (a memoized durable step never
   * re-enters this layer, so the sequence a replay sees is not the one the
   * first attempt saw), and a retried step MUST arrive with the same key or the
   * substrate re-runs work that is not idempotent. The STEP NAME is the one
   * value that is both stable across retries of a unit of work and distinct
   * across units, which is why it is the scope rather than a number. The
   * COMMAND + CWD below it keep a step that re-issues its own command (a retry
   * inside one body) joining its own receipt.
   *
   * Without the step scope, two steps running the identical command in one
   * execution collapse: the substrate returns the first receipt — exit code,
   * duration and log — and the second command never runs. A staged suite whose
   * stages share a command is exactly that shape.
   *
   * `Option.none()` (an exec outside any `step(...)`) falls back to the
   * pre-scope key, so nothing that never had a step name changes identity.
   *
   * The residual is the converse case INSIDE one step: two `exec` calls with
   * the same command and cwd there still share a key. That is what dedupe is
   * for (a step body re-running on retry), and a step that means to run one
   * command twice should say so with two steps — failing toward not re-running
   * is the safe direction for a `wrangler deploy`.
   */
  const idempotencyKeyFor = async (
    command: string,
    stepName: Option.Option<string>,
    cwd?: string,
  ): Promise<string> =>
    `${opts.executionId}:${(
      await sha256Hex(`${Option.getOrElse(stepName, () => "")}\0${cwd ?? ""}\0${command}`)
    ).slice(0, 32)}`;

  const service: SandboxService = {
    // The container is provisioned by the substrate on ensure; the handle is
    // the sandbox key, which is also what the facade namespaces per consumer.
    //
    // A `key` is REFUSED rather than ignored. The substrate namespaces one
    // sandbox per consumer execution, so there is no second container to hand
    // back — and silently returning the first would recreate exactly the defect
    // this option exists to fix: two acquisitions sharing one filesystem, with
    // `git clone` wiping its target directory out from under the other. A run
    // that needs isolated containers has to know it is not getting them.
    acquire: (acquireOpts) =>
      Effect.tryPromise({
        try: async () => {
          if (acquireOpts.key !== undefined) {
            throw new ContainerLaunchFailed({
              image: "substrate",
              cause: `the substrate backend has one sandbox per execution — \`acquire({ key: "${acquireOpts.key}" })\` cannot be honoured here`,
            });
          }
          const outcome = await opts.facade.ensureSandbox(key, recipe, { mode: "refuse" });
          if (!outcome.ok) throw outcome.refusal;
          return { id: key } satisfies Container;
        },
        catch: (cause): ContainerLaunchFailed | ContainerBusy => {
          // The keyed-acquire refusal above is already the typed error; pass it
          // through rather than re-describing it as a substrate refusal.
          if (cause instanceof ContainerLaunchFailed) return cause;
          const refusal = cause as SubstrateRefusal;
          // A full pool is a wait, not a broken container — `ContainerBusy` is
          // the error the Workflow already renders as an infra wait rather
          // than a red verdict.
          if (refusal?.kind === "admission-refused")
            return new ContainerBusy({
              containerId: key,
              holder: `${refusal.pool} pool ${refusal.poolBusy}/${refusal.cap}`,
              waitedMs: refusal.queuedForMs ?? 0,
            });
          return new ContainerLaunchFailed({
            image: "substrate",
            cause: refusal?.kind ? describeRefusal(refusal) : cause,
          });
        },
      }),

    // The substrate owns this sandbox's lifecycle — the dispatcher's teardown
    // on this path is `abort(key)`, which kills and stops and releases the
    // admission slot with it. A per-container destroy would be a second, weaker
    // opinion about when that happens, so this is deliberately a no-op rather
    // than a partial imitation.
    destroy: () => Effect.void,

    // No clone command is sent: `ensureSandbox` restores or rebuilds the tree
    // the recipe describes, and the recipe already names the repo and the sha.
    gitClone: ({ repo, sha }) =>
      Effect.tryPromise({
        try: async () => {
          if (repo !== opts.repo || sha !== opts.sha)
            throw new Error(
              `substrate clones from the recipe: this execution is pinned to ${opts.repo}@${opts.sha}, not ${repo}@${sha}`,
            );
          const outcome = await opts.facade.ensureSandbox(key, recipe, { mode: "refuse" });
          if (!outcome.ok) throw new Error(describeRefusal(outcome.refusal));
          return SUBSTRATE_WORKSPACE;
        },
        catch: (cause) => new CheckoutFailed({ repo, sha, cause }),
      }),

    exec: ({ command, cwd, timeoutSec, redactValues }) => {
      const cmd = asCommand(command);
      // Read the enclosing step BEFORE the Promise boundary — `serviceOption`
      // needs the fiber's context, and `tryPromise`'s callback has none. The
      // Tag is optional (`R` stays `never`, so `SandboxService` is unchanged),
      // which is what lets an exec outside any step keep working.
      return Effect.serviceOption(CurrentStep).pipe(
        Effect.map(Option.map((s) => s.name)),
        Effect.flatMap((stepName) =>
          Effect.tryPromise({
            try: async (): Promise<ExecResult> => {
              const idempotencyKey = await idempotencyKeyFor(cmd, stepName, cwd);
              const approval = await opts.approvalFor?.(cmd, {
                taskId: opts.executionId,
                // One ordinal per command in this execution, which is what scopes
                // an attestation to a step rather than to the run.
                ordinal: execSeq,
              });
              const outcome = await opts.facade.execUnderGrant(key, {
                recipe,
                command: cmd,
                idempotencyKey,
                // The substrate writes under its own per-execution artifact prefix;
                // the name only has to be stable and unique within the execution.
                logPath: `exec-${idempotencyKey.slice(-8)}.log`,
                ...(timeoutSec !== undefined ? { timeoutMs: timeoutSec * 1000 } : {}),
                tailBytes: TAIL_BYTES,
                ...(approval !== undefined ? { approval } : {}),
              });
              if (!outcome.ok) throw outcome.refusal;

              const tail = redact(outcome.receipt.tail, redactValues);
              const logPath = nextLogKey();
              // Scrubbed for the same reason the tail above is: the meta line
              // is a persisted R2 surface. Note this is the LOG's copy — the
              // command handed to `execUnderGrant` above stays verbatim,
              // because that one has to run.
              await writeLog(logPath, redact(cmd, redactValues), tail);
              const file = logPath.slice(logPath.lastIndexOf("/") + 1);
              const viewerUrl =
                opts.logsViewerBase !== undefined ? `${opts.logsViewerBase}#${file}` : undefined;
              return {
                exitCode: outcome.receipt.exitCode,
                durationMs: outcome.receipt.durationMs,
                logPath,
                // The substrate merges stdout and stderr into one artifact stream,
                // so the split the SDK path reported is not recoverable here.
                stdout: inlineTail(tail, viewerUrl),
                stderr: "",
              };
            },
            catch: (cause): ExecFailed => {
              const refusal = cause as SubstrateRefusal;
              return new ExecFailed({
                exitCode: -1,
                stderrTail: redact(
                  refusal?.kind
                    ? describeRefusal(refusal)
                    : cause instanceof Error
                      ? cause.message
                      : String(cause),
                  redactValues,
                ),
              });
            },
          }),
        ),
      );
    },

    readFile: ({ path }) =>
      Effect.tryPromise({
        try: async () => {
          const outcome = await opts.facade.readFile(key, path);
          if (!outcome.ok) throw new Error(describeRefusal(outcome.refusal));
          return outcome.content;
        },
        catch: (cause) =>
          new ReadFileFailed({
            path,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),

    // `runDetached` and `waitForPort` below still fail, and must: this adapter
    // is not wired to the facade's detached surface and the run bodies still
    // call `sandbox.runDetached`. Only the REASON has changed. The facade now
    // serves `startDetached` / `detachedStatus` / `stopDetached` (ADR-0012: a
    // detached process holds no grant), so a message saying the surface does
    // not exist sends whoever reads it off to build something already there.
    // `grant-catalog.ts`'s `detached-process` gap states the real clearing
    // condition — the run body moves off `sandbox.runDetached` — and stays.
    // (`waitForExit` below fails for a different reason again: see its own
    // comment. `exposePort` is a separate gap entirely.)
    //
    // Closing the gap for a run takes three things, not one: this adapter
    // wired, that run's body moved over, and its `rollout` graduated through a
    // clean `report` window and on to `enforce` (`adoption-runbook.md` § 3–4).
    // Moving where untrusted code executes is that runbook's decision to make.
    runDetached: () =>
      Effect.fail(
        new ContainerLaunchFailed({
          image: "substrate",
          cause:
            "this adapter is not wired to the facade's detached surface — the facade serves `startDetached` (ADR-0012: a detached process holds no grant), but this run still calls `sandbox.runDetached`. Kept off the facade by grant-catalog.ts until the run body moves over",
        }),
      ),

    // Correct to fail, and it is not a gap: ADR-0012 gives the facade no
    // `waitForExit` on purpose. A consumer polls the SUBSTRATE FACADE's
    // `detachedStatus` from its own durable steps — that method is on
    // `SubstrateFacade`, not on this `Sandbox` port, so naming it unqualified
    // sends a reader grepping the port for something that was never there.
    // A Worker call that blocks for twenty minutes is not a call.
    waitForExit: ({ handle }) =>
      Effect.fail(
        new ExecTimeout({
          timeoutSec: 0,
          command: `detached:${handle.id} — the facade has no waitForExit by design; poll the substrate facade's detachedStatus from a durable step (ADR-0012)`,
        }),
      ),

    // `PortNeverOpened` carries no free-text cause, so the gap is named on the
    // log line instead of vanishing into a bare timeout a reader would chase.
    waitForPort: ({ port, timeoutSec }) =>
      Effect.logError(
        `waitForPort(${port}) is unreachable on the substrate facade — the fenced-exec localhost poll that grant-catalog.ts names as its replacement does not exist yet`,
      ).pipe(
        Effect.andThen(Effect.fail(new PortNeverOpened({ port, timeoutSec: timeoutSec ?? 0 }))),
      ),

    exposePort: ({ port }) =>
      Effect.fail(
        new ExposePortFailed({
          port,
          cause:
            "the substrate facade exposes no container port — preview URLs belong to the container-owning worker",
        }),
      ),
  };

  return Layer.succeed(SandboxTag, service);
};

/**
 * The `cache` capability on the facade path: always a miss, never a save.
 *
 * The R2 dep cache packs and extracts tar archives by exec'ing inside the
 * container and streaming the bytes out over the DO binding — a surface the
 * facade does not expose, and one that would reach the WRONG container if it
 * used the dispatcher's own namespace while the run executes on the substrate.
 *
 * Degrading rather than failing is the right trade: a miss means the install
 * runs against the registry (`js-install` / `rust-install` admit exactly that),
 * so a cached run is slower on the facade, not broken. The substrate keeps its
 * own workspace snapshots per recipe version, which covers the inter-step case
 * this cache was never about.
 */
export const CacheOnFacade: Layer.Layer<CacheTag> = Layer.succeed(CacheTag, {
  restoreOr: ({ onMiss }) => Effect.asVoid(onMiss()),
  save: ({ key }) =>
    Effect.logDebug(`cache: skipping save for ${key} — no archive surface on the facade path`),
});
