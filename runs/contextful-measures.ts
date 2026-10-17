import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  defineRun,
  github,
  io,
  sandbox,
  StepFailed,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

const REPO = "fractalboxdev/contextful";
const BRANCH = "main";
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
  limits: { maxDurationSec: 21600, admissionMaxQueueAgeSec: 21600 },
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
      const measured = yield* step(
        "measure",
        () =>
          sandbox.exec({
            container: ws.container,
            cwd: ws.dir,
            command: MEASURE_COMMAND,
            timeoutSec,
          }),
        { timeoutSec: timeoutSec + 100, retries: 0 },
      );
      // A red tier still gets a note. Only report construction or note writing
      // prevents history from being attached.
      const report = yield* step("build-report", () =>
        sandbox.exec({
          container: ws.container,
          cwd: ws.dir,
          command: reportCommand,
          env: {
            MEASURE_COMMIT: commit,
            MEASURE_RUN_ID: runId,
            MEASURE_RUN_ATTEMPT: String(runAttempt(runId)),
            MEASURE_EXIT: String(measured.exitCode),
          },
          timeoutSec: 60,
        }),
      );
      if (report.exitCode !== 0) {
        return yield* Effect.fail(new StepFailed({ step: "build-report", cause: report.stderr }));
      }
      const reportPath = `${ws.dir}/${REPORT_FILE}`;
      const reportUrl = yield* step("upload-report", () =>
        artifact.upload({
          name: REPORT_FILE,
          path: reportPath,
          container: ws.container,
          contentType: "application/json",
          signedUrlTTL: "30 days",
        }),
      );
      const reportText = yield* step("read-report", () =>
        sandbox
          .readFile({ path: reportPath, container: ws.container })
          .pipe(
            Effect.catchTag("ReadFileFailed", (error) =>
              Effect.fail(new StepFailed({ step: "read-report", cause: error.message })),
            ),
          ),
      );
      yield* step("append-note", () =>
        github.appendMeasureNote({
          repo: REPO,
          commit,
          text: reportText.trim(),
        }),
      );
      if (measured.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: measured.exitCode,
            summaryMd: `Measures exited ${measured.exitCode}; the report is attached to ${commit} under refs/notes/measures.`,
          }),
        );
      }
      return { commit, exitCode: measured.exitCode, reportUrl };
    }),
});
