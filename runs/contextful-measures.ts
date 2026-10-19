import { Cause, Effect, Exit, Option, Schema } from "effect";
import {
  AcceptanceFailed,
  ChildRuns,
  artifact,
  defineRun,
  github,
  handoffChildAdmission,
  io,
  isTerminalChildStatus,
  sandbox,
  spawnChildRun,
  StepFailed,
  step,
  type ChildStatusRecord,
} from "@fractalboxdev/flare-dispatch-core";
import {
  ensureWorkspace,
  waitForChildrenDurably,
  workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { check } from "./check";

const REPO = "fractalboxdev/contextful";
const BRANCH = "main";
const MEASURE_RETRIES = 2;
const MEASURE_COMMAND = "cargo run --locked -q -p contextful-ci -- measure --tier all";
const REPORT_FILE = "measure-report.json";
const Input = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  firedAt: Schema.Number,
  /** The head the scheduled tick pinned; its check-run lands on this commit. */
  sha: Schema.optional(Schema.String),
  timeoutSec: Schema.optional(Schema.Number),
});
const Output = Schema.Struct({
  commit: Schema.String,
  exitCode: Schema.Number,
  reportUrl: Schema.String,
  /** Nightly-tier parts dispatched; zero when the consumer has no `--tier`. */
  nightlyParts: Schema.Number,
  nightlyFailed: Schema.Array(Schema.String),
});

/**
 * Contextful's `measure-report` owns the note line: it collects every record, red
 * tiers included, and annotates trend figures against the history under
 * `refs/notes/measures`, which a plain clone omits. A failed notes fetch leaves
 * no history, and the report then carries no annotation.
 */
export const reportCommand = `(git fetch -q origin +refs/notes/measures:refs/notes/measures || true) && cargo run --locked -q -p contextful-ci -- measure-report --commit "$MEASURE_COMMIT" --run-id "$MEASURE_RUN_ID" --run-attempt "$MEASURE_RUN_ATTEMPT" --exit-code "$MEASURE_EXIT" --out ${REPORT_FILE}`;

export const runAttempt = (executionId: string): number =>
  Number(executionId.match(/_attempt-(\d+)$/)?.[1] ?? 1);

/** The consumer's nightly-tier parts: the suites that sit outside the per-PR required set. */
export const NIGHTLY_DISCOVER =
  "cargo run --locked -q -p contextful-ci -- stages --parts --tier nightly";
const PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const MAX_NIGHTLY_PARTS = 64;
const MAX_PART_LIST_BYTES = 4096;
/** Nightly parts dispatched together; the next window spawns once this one settles. */
export const NIGHTLY_WINDOW = 10;
/** Each nightly part's exec deadline, the same sandbox wall clock a gate part gets. */
const NIGHTLY_TIMEOUT_SEC = 2700;
/** The longest admission queue age `check` accepts. */
const NIGHTLY_QUEUE_SEC = 90 * 60;
/** First-parent commits searched for the previous measured commit. */
const RANGE_DEPTH = 400;
export const NIGHTLY_ISSUE_LABEL = "nightly-tier";
export const NIGHTLY_ISSUE_TITLE = "Nightly tier failing on main";

export const nightlyPartCommand = (part: string): string =>
  `cargo run --locked -q -p contextful-ci -- gate --predecessors --stage ${part}`;

/**
 * Every measured commit carries a `refs/notes/measures` note, red tiers included,
 * so the nearest first-parent ancestor with a note is the previous night's head.
 * The note lives in the consumer's own history and outlives any dispatcher state.
 */
export const rangeCommand = `(git fetch -q origin +refs/notes/measures:refs/notes/measures || true) && echo '#annotated' && (git notes --ref=measures list || true) && echo '#first-parent' && git rev-list --first-parent --max-count=${RANGE_DEPTH} "$MEASURE_COMMIT"`;

/** The nearest first-parent ancestor of `head` that carries a measures note. */
export const previousMeasured = (stdout: string, head: string): string | undefined => {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const annotatedAt = lines.indexOf("#annotated");
  const historyAt = lines.indexOf("#first-parent");
  if (annotatedAt === -1 || historyAt < annotatedAt) return undefined;
  const annotated = new Set(
    lines
      .slice(annotatedAt + 1, historyAt)
      .map((line) => line.split(/\s+/)[1]?.toLowerCase())
      .filter((sha): sha is string => sha !== undefined && /^[a-f0-9]{40}$/.test(sha)),
  );
  return lines
    .slice(historyAt + 1)
    .map((line) => line.toLowerCase())
    .find((sha) => /^[a-f0-9]{40}$/.test(sha) && sha !== head.toLowerCase() && annotated.has(sha));
};

export type NightlyDiscovery =
  | { readonly kind: "parts"; readonly parts: readonly string[] }
  | { readonly kind: "unsupported" }
  | { readonly kind: "invalid" };

/**
 * A consumer that predates `--tier` rejects the flag; it has no nightly tier, so
 * the run measures as before. Any other failure is a discovery failure, which the
 * run reports like a failed part.
 */
export const parseNightlyParts = (result: {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}): NightlyDiscovery => {
  if (result.exitCode !== 0) {
    return /(unexpected|unrecognized|unknown) (argument|option|flag) '?--tier\b/i.test(
      result.stderr,
    )
      ? { kind: "unsupported" }
      : { kind: "invalid" };
  }
  if (new TextEncoder().encode(result.stdout).length > MAX_PART_LIST_BYTES)
    return { kind: "invalid" };
  const trimmed = result.stdout.trim();
  if (trimmed === "") return { kind: "parts", parts: [] };
  const parts = trimmed.split(/\r?\n/).map((part) => part.trim());
  if (
    parts.length > MAX_NIGHTLY_PARTS ||
    parts.some((part) => !PART_PATTERN.test(part)) ||
    new Set(parts).size !== parts.length
  )
    return { kind: "invalid" };
  return { kind: "parts", parts };
};

export type NightlyFailure = {
  readonly part: string;
  readonly checkUrl?: string;
  /** Why the part has no verdict of its own, when it has none. */
  readonly note?: string;
};

/**
 * A failed part's own check-run page, from the id its child row records; the
 * head's checks page stands in while the child has posted no check-run.
 */
export const checkRunUrl = (opts: {
  readonly repo: string;
  readonly head: string;
  readonly checkRunId: string | undefined;
}): string =>
  opts.checkRunId !== undefined && /^\d+$/.test(opts.checkRunId)
    ? `https://github.com/${opts.repo}/runs/${opts.checkRunId}`
    : `https://github.com/${opts.repo}/commit/${opts.head}/checks`;

/** The issue body: the change range from the previous measured commit, then each failed part. */
export const nightlyIssueBody = (opts: {
  readonly repo: string;
  readonly previous: string | undefined;
  readonly head: string;
  readonly failures: readonly NightlyFailure[];
}): string => {
  const range =
    opts.previous === undefined
      ? `No earlier measured commit lies within ${RANGE_DEPTH} first-parent commits of \`${opts.head}\`.`
      : `\`${opts.previous}\`..\`${opts.head}\` ([compare](https://github.com/${opts.repo}/compare/${opts.previous}...${opts.head}))`;
  const parts = opts.failures.map(({ part, checkUrl, note }) => {
    const name =
      checkUrl === undefined ? `\`${part}\`` : `[\`flare-dispatch/check:${part}\`](${checkUrl})`;
    return note === undefined ? `- ${name}` : `- ${name}: ${note}`;
  });
  return [
    `The nightly tier failed on \`${opts.head}\`.`,
    "",
    `**Change range:** ${range}`,
    "",
    "**Failed parts:**",
    ...parts,
  ].join("\n");
};

const openNightlyIssues = (repo: string) =>
  github
    .issues({ repo, state: "open", labels: [NIGHTLY_ISSUE_LABEL], strict: true })
    .pipe(Effect.map((open) => open.filter((issue) => issue.title === NIGHTLY_ISSUE_TITLE)));

/**
 * One labelled open issue carries a red streak. A later failure comments on it,
 * so the streak is one thread; the read is strict because a truncated list would
 * read as "no issue yet" and duplicate it.
 */
export const reportNightlyFailures = (opts: { readonly repo: string; readonly body: string }) =>
  Effect.gen(function* () {
    const existing = (yield* openNightlyIssues(opts.repo))[0];
    if (existing !== undefined) {
      yield* github.commentOnIssue({ repo: opts.repo, issue: existing.number, body: opts.body });
      return { number: existing.number, url: existing.url, opened: false };
    }
    const created = yield* github.openIssue({
      repo: opts.repo,
      title: NIGHTLY_ISSUE_TITLE,
      body: opts.body,
      labels: [NIGHTLY_ISSUE_LABEL],
    });
    return { number: created.number, url: created.url, opened: true };
  });

/**
 * A green night ends the streak: the streak's issue records the passing head and
 * closes as completed, so the next failure opens a new issue. The close goes
 * through `closeBotIssue`, which closes only a bot-opened issue carrying
 * `nightly-tier`; an issue a person opened with the same title and label instead
 * loses the label and stays open for that person.
 */
export const resolveNightlyIssue = (opts: { readonly repo: string; readonly head: string }) =>
  Effect.gen(function* () {
    const open = yield* openNightlyIssues(opts.repo);
    const comment = `The nightly tier passed on \`${opts.head}\`. This streak has ended; the next failure opens a new issue.`;
    for (const issue of open) {
      const result = yield* github.closeBotIssue({
        repo: opts.repo,
        issue: issue.number,
        label: NIGHTLY_ISSUE_LABEL,
        comment,
      });
      if (result.closed || result.reason !== "human-owned") continue;
      yield* github.commentOnIssue({ repo: opts.repo, issue: issue.number, body: comment });
      yield* github.removeIssueLabel({
        repo: opts.repo,
        issue: issue.number,
        label: NIGHTLY_ISSUE_LABEL,
      });
    }
    return open.map((issue) => issue.number);
  });

/** A tagged failure's tag and message, for an issue line or a run summary. */
const describeFailure = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.squash(cause);
  if (!(failure instanceof Error)) return String(failure);
  const tag = (failure as { _tag?: unknown })._tag;
  const label = typeof tag === "string" ? tag : failure.name;
  return failure.message.length > 0 && failure.message !== label
    ? `${label}: ${failure.message.slice(0, 200)}`
    : label;
};

export const contextfulMeasures = defineRun({
  name: "contextful-measures",
  version: "1.0.0",
  schedules: [
    {
      cron: "17 2 * * *",
      idempotencyKey: ({ firedAt }) =>
        `contextful-measures:${new Date(firedAt).toISOString().slice(0, 10)}`,
      inputs: ({ firedAt }): typeof Input.Type => ({
        repo: REPO,
        ref: `refs/heads/${BRANCH}`,
        firedAt,
      }),
    },
  ],
  serialize: (input) => ({
    group: `${input.repo}:measures-history`,
    revision: String(input.firedAt),
  }),
  inputs: Input,
  outputs: Output,
  // The measure ceiling (≤ 20100 s) plus nightly windows, each bounded by its
  // parts' queue age and the check run's own ceiling.
  limits: { maxDurationSec: 30 * 3600, admissionMaxQueueAgeSec: 21600 },
  run: (input) =>
    Effect.gen(function* () {
      if (input.repo !== REPO || input.ref !== `refs/heads/${BRANCH}`) {
        return yield* Effect.fail(
          new StepFailed({
            step: "scope",
            cause: "measures target must be the Contextful default branch",
          }),
        );
      }
      // The tick's pinned head, else HEAD at execution time.
      const commit =
        input.sha ??
        (yield* step("resolve-head", () => github.branchHead({ repo: REPO, branch: BRANCH })));
      const executionId = yield* io.executionId;
      const runId = executionId || `contextful-measures:${input.firedAt}`;
      // The ledger runs 65 entries in sequence and compiles its own test
      // binaries. Allow the operator to raise or lower the command ceiling.
      const timeoutSec = Math.max(300, Math.min(input.timeoutSec ?? 18000, 20000));
      const ws = yield* step("checkout", () => workspace({ repo: REPO, sha: commit }));
      // A container recycled mid-measure answers `ExecFailed` (exit -1) and takes
      // the checkout with it, so the retry rebuilds the workspace inside the step
      // before measuring again, and the report steps read the workspace it measured.
      // A measure that exhausts its retries still lets the nightly tier run.
      const measuredExit = yield* Effect.exit(
        step(
          "measure",
          () =>
            ensureWorkspace({ current: ws, repo: REPO, sha: commit }).pipe(
              Effect.flatMap((current) =>
                sandbox
                  .exec({
                    container: current.container,
                    cwd: current.dir,
                    command: MEASURE_COMMAND,
                    timeoutSec,
                  })
                  .pipe(
                    Effect.map((result) => ({ exitCode: result.exitCode, workspace: current })),
                  ),
              ),
            ),
          {
            timeoutSec: timeoutSec + 100,
            retries: MEASURE_RETRIES,
            retryOn: ["ExecFailed", "CheckoutFailed"],
          },
        ),
      );
      const measured = Exit.isSuccess(measuredExit) ? measuredExit.value : undefined;
      const ledgerFailures: NightlyFailure[] = Exit.isFailure(measuredExit)
        ? [{ part: "measures", note: `measure: ${describeFailure(measuredExit.cause)}` }]
        : [];
      // A red tier still gets a note. Only report construction or note writing
      // prevents history from being attached; either failure is reported with the
      // nightly tier, which runs regardless.
      const at = (name: string) =>
        Effect.mapError((error: unknown) => ({ step: name, cause: Cause.fail(error) }));
      const ledger =
        measured === undefined
          ? undefined
          : yield* Effect.exit(
              Effect.gen(function* () {
                const report = yield* step("build-report", () =>
                  sandbox.exec({
                    container: measured.workspace.container,
                    cwd: measured.workspace.dir,
                    command: reportCommand,
                    env: {
                      MEASURE_COMMIT: commit,
                      MEASURE_RUN_ID: runId,
                      MEASURE_RUN_ATTEMPT: String(runAttempt(runId)),
                      MEASURE_EXIT: String(measured.exitCode),
                    },
                    timeoutSec: 60,
                  }),
                ).pipe(at("build-report"));
                if (report.exitCode !== 0) {
                  return yield* Effect.fail({
                    step: "build-report",
                    cause: Cause.fail(
                      new StepFailed({ step: "build-report", cause: report.stderr }),
                    ),
                  });
                }
                const reportPath = `${measured.workspace.dir}/${REPORT_FILE}`;
                const url = yield* step("upload-report", () =>
                  artifact.upload({
                    name: REPORT_FILE,
                    path: reportPath,
                    container: measured.workspace.container,
                    contentType: "application/json",
                    signedUrlTTL: "30 days",
                  }),
                ).pipe(at("upload-report"));
                const reportText = yield* step("read-report", () =>
                  sandbox
                    .readFile({ path: reportPath, container: measured.workspace.container })
                    .pipe(
                      Effect.catchTag("ReadFileFailed", (error) =>
                        Effect.fail(new StepFailed({ step: "read-report", cause: error.message })),
                      ),
                    ),
                ).pipe(at("read-report"));
                yield* step("append-note", () =>
                  github.appendMeasureNote({
                    repo: REPO,
                    commit,
                    text: reportText.trim(),
                  }),
                ).pipe(at("append-note"));
                return url;
              }),
            );
      if (ledger !== undefined && Exit.isFailure(ledger)) {
        const failed = Cause.failureOption(ledger.cause);
        ledgerFailures.push({
          part: "measures",
          note: Option.isSome(failed)
            ? `${failed.value.step}: ${describeFailure(failed.value.cause)}`
            : describeFailure(ledger.cause),
        });
      }
      const reportUrl = ledger !== undefined && Exit.isSuccess(ledger) ? ledger.value : undefined;
      // The measured workspace has contextful-ci built, so the range and the
      // nightly discovery reuse it rather than compiling it again elsewhere.
      const base = measured?.workspace ?? ws;
      const discoveredExit = yield* Effect.exit(
        step(
          "discover-nightly",
          () =>
            ensureWorkspace({ current: base, repo: REPO, sha: commit }).pipe(
              Effect.flatMap((current) =>
                Effect.all([
                  sandbox.exec({
                    container: current.container,
                    cwd: current.dir,
                    command: rangeCommand,
                    env: { MEASURE_COMMIT: commit },
                    timeoutSec: 120,
                  }),
                  sandbox.exec({
                    container: current.container,
                    cwd: current.dir,
                    command: NIGHTLY_DISCOVER,
                    timeoutSec: 1800,
                  }),
                ]),
              ),
              // Only the bounded fields reach the checkpoint.
              Effect.map(([range, parts]) => ({
                previous: range.exitCode === 0 ? previousMeasured(range.stdout, commit) : undefined,
                exitCode: parts.exitCode,
                stdout: parts.stdout.slice(0, MAX_PART_LIST_BYTES + 1),
                stderr: parts.stderr.slice(-MAX_PART_LIST_BYTES),
              })),
            ),
          { timeoutSec: 2100, retries: MEASURE_RETRIES, retryOn: ["ExecFailed", "CheckoutFailed"] },
        ),
      );
      const discovered = Exit.isSuccess(discoveredExit) ? discoveredExit.value : undefined;
      const nightly: NightlyDiscovery =
        discovered === undefined ? { kind: "invalid" } : parseNightlyParts(discovered);
      if (nightly.kind === "unsupported") {
        yield* io.log("warn", "contextful-ci has no --tier; the nightly tier is skipped", {
          commit,
        });
      }
      const parts = nightly.kind === "parts" ? nightly.parts : [];
      const nightlyFailures: NightlyFailure[] = [];
      if (nightly.kind === "invalid") {
        nightlyFailures.push({
          part: "stages --parts --tier nightly",
          ...(Exit.isFailure(discoveredExit)
            ? { note: describeFailure(discoveredExit.cause) }
            : {}),
        });
      }
      if (parts.length > 0) {
        // The parent's own sandbox work ends here: its container and admission
        // slot go to the parts rather than idling through the wait. Either
        // release failing costs capacity, never the tier.
        yield* Effect.exit(
          step("release-measure-container", () => sandbox.destroy({ container: base.container })),
        );
        yield* Effect.exit(step("handoff-admission", () => handoffChildAdmission()));
      }
      for (let offset = 0; offset < parts.length; offset += NIGHTLY_WINDOW) {
        const window = parts.slice(offset, offset + NIGHTLY_WINDOW);
        const spawned = yield* step(`spawn-nightly-${offset}`, () =>
          Effect.forEach(
            window,
            (part) =>
              spawnChildRun({
                run: "check",
                input: {
                  repo: REPO,
                  sha: commit,
                  checkLabel: part,
                  command: nightlyPartCommand(part),
                  failOnNonZeroExit: true,
                  timeoutSec: NIGHTLY_TIMEOUT_SEC,
                  admissionMaxQueueAgeSec: NIGHTLY_QUEUE_SEC,
                  install: false,
                  secrets: [],
                },
              }).pipe(
                Effect.matchCause({
                  onFailure: (cause) => ({ part, note: `not dispatched: ${describeFailure(cause)}` }),
                  onSuccess: (handle) => ({ part, executionId: handle.executionId }),
                }),
              ),
            { concurrency: window.length },
          ),
        );
        const launched: { part: string; executionId: string }[] = [];
        for (const result of spawned) {
          if ("executionId" in result) launched.push(result);
          else nightlyFailures.push(result);
        }
        if (launched.length === 0) continue;
        const ids = launched.map((result) => result.executionId);
        const waited = yield* Effect.exit(
          waitForChildrenDurably({
            name: `await-nightly-${offset}`,
            ids,
            timeout: `${(NIGHTLY_QUEUE_SEC + check.limits.maxDurationSec) / 60} minutes`,
          }),
        );
        // A window that outlives its deadline reads its children once more, so a
        // settled part keeps its verdict and an unsettled one is reported as such.
        const results = Exit.isSuccess(waited)
          ? waited.value
          : yield* step(`settle-nightly-${offset}`, () =>
              Effect.flatMap(ChildRuns, (children) => children.poll({ ids })),
            ).pipe(
              Effect.orElseSucceed(() =>
                ids.map((executionId): ChildStatusRecord => ({ executionId, status: "missing" })),
              ),
            );
        results.forEach((result, index) => {
          if (result.status === "success") return;
          nightlyFailures.push({
            part: launched[index]!.part,
            checkUrl: checkRunUrl({ repo: REPO, head: commit, checkRunId: result.checkRunId }),
            ...(isTerminalChildStatus(result.status)
              ? {}
              : { note: "did not settle before the window's deadline" }),
          });
        });
      }
      const failures = [...ledgerFailures, ...nightlyFailures];
      if (failures.length > 0) {
        yield* step("report-nightly", () =>
          reportNightlyFailures({
            repo: REPO,
            body: nightlyIssueBody({
              repo: REPO,
              previous: discovered?.previous,
              head: commit,
              failures,
            }),
          }),
        );
      } else if (nightly.kind === "parts") {
        yield* step("resolve-nightly", () => resolveNightlyIssue({ repo: REPO, head: commit }));
      }
      const nightlyFailed = nightlyFailures.map((failure) => failure.part);
      if (
        measured === undefined ||
        reportUrl === undefined ||
        measured.exitCode !== 0 ||
        nightlyFailed.length > 0
      ) {
        const lines = [
          ...ledgerFailures.map((failure) => `Measures failed at ${failure.note}.`),
          ...(measured !== undefined && measured.exitCode !== 0
            ? [
                reportUrl === undefined
                  ? `Measures exited ${measured.exitCode}.`
                  : `Measures exited ${measured.exitCode}; the report is attached to ${commit} under refs/notes/measures.`,
              ]
            : []),
          ...(nightlyFailed.length > 0
            ? [`Nightly parts failed: ${nightlyFailed.join(", ")}`]
            : []),
        ];
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: measured?.exitCode || 1,
            summaryMd: lines.join("\n"),
          }),
        );
      }
      return {
        commit,
        exitCode: measured.exitCode,
        reportUrl,
        nightlyParts: parts.length,
        nightlyFailed,
      };
    }),
});
