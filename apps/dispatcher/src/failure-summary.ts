// FlareDispatch Dispatcher — failure-path presentation (issue #85).
//
// A failed run used to post a bare "✗ <run> — execution failed." check-run
// summary, hiding the diagnosis a run may already have built (e.g.
// `product-demo`'s per-chapter table, persisted only to R2). The typed error
// channel now carries that presentation — `AcceptanceFailed.summaryMd` — and
// this module is the dispatcher half: pull the markdown out of the run's
// `Exit` and splice it under the generic line, bounded to GitHub's check-run
// summary limit. Pure + dependency-free so the workflow's failure arm stays
// unit-testable without simulating a Workflow.

import { Cause, Exit, Match, Option } from "effect";
import type {
  AdmissionTimedOut,
  ExecFailed,
  ExecTimeout,
  RunDurationExceeded,
  RunError,
  SandboxProcessLost,
  SecretsMissing,
  SerialQueueTimedOut,
  StepFailed,
} from "@fractalboxdev/flare-dispatch-core";

/**
 * GitHub caps a check-run's `output.summary` at 65535 characters — a longer
 * payload 422s the whole update, which would mask the verdict itself.
 * `appendFailureSummary` truncates so the verdict always lands, however
 * chatty the run's summary was.
 */
export const CHECK_SUMMARY_MAX_CHARS = 65_535;

/** Appended when the run's markdown is cut — exported for the boundary test. */
export const TRUNCATION_NOTE = "\n\n_… summary truncated to fit the check-run limit._";

/** Cap stderr / cause tails so one noisy step cannot dominate the summary. */
const TAIL_MAX_CHARS = 4_000;

const clip = (s: string, max = TAIL_MAX_CHARS): string =>
  s.length <= max ? s : `${s.slice(0, max)}\n_… truncated._`;

/**
 * Render an `AdmissionTimedOut` for the check-run summary. The run never
 * started — no container booted, no test ran — so the red check must read as
 * capacity back-pressure (infra wait), unmistakably NOT a test failure
 * (issue #109).
 */
export const admissionTimedOutMd = (e: AdmissionTimedOut): string =>
  `⏳ **Timed out waiting for a sandbox slot** — queued for ` +
  `${Math.round(e.queuedForMs / 60_000)} min behind ${e.position} run(s) ` +
  `(${e.poolBusy} sandbox slot(s) in use).\n\n` +
  `The execution **never started**: the container pool stayed saturated for ` +
  `the whole wait, so this is capacity back-pressure — **not a test ` +
  `failure**. Re-run once in-flight runs drain.`;

/**
 * Render a `SerialQueueTimedOut`: the run never started, because one peer of
 * its group held it — and kept heartbeating — for the whole wait.
 */
export const serialQueueTimedOutMd = (e: SerialQueueTimedOut): string =>
  `⏳ **Timed out waiting for an in-flight run of \`${e.group}\`** — queued for ` +
  `${Math.round(e.waitedMs / 60_000)} min behind ` +
  `${e.holderRevision !== "" ? `\`${e.holderRevision.slice(0, 12)}\`` : "a peer"}.\n\n` +
  `The execution **never started**. Runs of this group never overlap, and the ` +
  `holder was still alive when the wait gave up. Re-run once it finishes.`;

/**
 * Render a `RunDurationExceeded`: the run started and was cut at its declared
 * wall-clock ceiling (issue #42), whatever its steps were still doing.
 */
export const runDurationExceededMd = (e: RunDurationExceeded): string =>
  `⏱ **Exceeded the run ceiling** of ${Math.round(e.maxDurationSec / 60)} min ` +
  `(\`limits.maxDurationSec: ${e.maxDurationSec}\`).\n\n` +
  `The run was stopped and its sandbox destroyed. Retries inside the run share ` +
  `this one ceiling; a suite that needs longer needs a larger \`maxDurationSec\`.`;

/**
 * Render a `SandboxProcessLost`: the check command ran, but every launch's
 * process vanished with its container, so no exit status exists to report.
 */
export const sandboxProcessLostMd = (e: SandboxProcessLost): string =>
  `🔌 **The sandbox lost the check process** on each of ${e.launches} launches ` +
  `(container recycled or its supervisor gone).\n\n` +
  `No exit status was produced, so this is an infrastructure loss — **not a ` +
  `check failure**. Re-run once the container pool drains.`;

const execFailedMd = (e: ExecFailed): string =>
  `**Exec failed** (exit \`${e.exitCode}\`):\n\n\`\`\`\n${clip(e.stderrTail)}\n\`\`\``;

const execTimeoutMd = (e: ExecTimeout): string =>
  `**Exec timed out** after \`${e.timeoutSec}s\`:\n\n\`${clip(e.command, 500)}\``;

const stepFailedMd = (e: StepFailed): string => {
  // Run-authored presentation wins over the fenced cause — same contract as
  // `AcceptanceFailed.summaryMd`. A `StepFailed` that carries markdown (the
  // dead-stage ✓/✗/⊘ rundown with its log links) must render AS markdown;
  // fencing it turned the links literal and unclickable. The raw cause still
  // lands in the Workflow error record, so nothing diagnostic is lost.
  if (e.summaryMd !== undefined && e.summaryMd.trim() !== "") {
    return `**Step \`${e.step}\` failed**\n\n${e.summaryMd}`;
  }
  const cause =
    typeof e.cause === "string"
      ? e.cause
      : e.cause instanceof Error
        ? e.cause.message
        : JSON.stringify(e.cause);
  return `**Step \`${e.step}\` failed**:\n\n\`\`\`\n${clip(String(cause ?? "unknown"))}\n\`\`\``;
};

const secretsMissingMd = (e: SecretsMissing): string =>
  `**Missing Worker secrets**: ${e.keys.map((k) => `\`${k}\``).join(", ")}\n\n` +
  `Set them with \`wrangler secret put <NAME>\` — do not put credentials in dispatch \`env\`.`;

/**
 * Extract a `RunSkipped` failure's reason from a run's `Exit`. `undefined` on
 * success, on a defect/interrupt, and on any other typed failure. A skipped
 * run bowed out for a capacity reason (the work was impossible to attempt, not
 * attempted-and-failed) — the workflow maps it to a `neutral` check-run
 * conclusion + a `skipped` executions row instead of a red `failure`.
 */
export const runSkippedReason = (exit: Exit.Exit<unknown, RunError>): string | undefined =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onNone: () => undefined,
        onSome: (failure) =>
          Match.value(failure).pipe(
            Match.tag("RunSkipped", (e) => e.reason),
            Match.orElse(() => undefined),
          ),
      }),
  });

/**
 * Extract the run-authored failure markdown from a run's `Exit`, when one is
 * present. `undefined` on success, on a defect/interrupt (`Cause.failureOption`
 * is none — there is no typed failure to read), and on typed failures we have
 * not opted into rendering. `AcceptanceFailed` carries run-authored markdown;
 * `AdmissionTimedOut` / `RunDurationExceeded` / `SandboxProcessLost` / `ExecFailed` / `ExecTimeout` / `StepFailed` /
 * `SecretsMissing` render structured infra explanations so a red check is not
 * only a Cloudflare workflow link.
 *
 * `Cause.failureOption` picks the LEFTMOST failure, so a multi-error Cause
 * (parallel/sequential composition) surfaces at most one summary — and
 * degrades to the generic line when that leftmost failure carries none. By
 * design: a run fails with one typed error in practice.
 */
export const failureSummaryMd = (exit: Exit.Exit<unknown, RunError>): string | undefined =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onNone: () => undefined,
        onSome: (failure) =>
          Match.value(failure).pipe(
            Match.tag("AcceptanceFailed", (e) => e.summaryMd),
            Match.tag("AdmissionTimedOut", (e) => admissionTimedOutMd(e)),
            Match.tag("SerialQueueTimedOut", (e) => serialQueueTimedOutMd(e)),
            Match.tag("RunDurationExceeded", (e) => runDurationExceededMd(e)),
            Match.tag("SandboxProcessLost", (e) => sandboxProcessLostMd(e)),
            Match.tag("ExecFailed", (e) => execFailedMd(e)),
            Match.tag("ExecTimeout", (e) => execTimeoutMd(e)),
            Match.tag("StepFailed", (e) => stepFailedMd(e)),
            Match.tag("SecretsMissing", (e) => secretsMissingMd(e)),
            Match.orElse(() => undefined),
          ),
      }),
  });

/** The last `steps` row an execution recorded as `failure`. */
export type FailedStepRow = { readonly name: string; readonly errorTag: string | null };

/**
 * Name the step a failed run died in and the tag it failed with — the line a
 * scheduled run's check-run carries in place of a row only D1 holds. The tag is
 * the run's typed failure; the step is the one a `StepFailed` names, else the
 * last failed `steps` row when that row recorded the same tag. A failure no
 * step recorded reads as outside any step. `undefined` on success and on a
 * defect or interrupt, which carry no tag.
 */
export const failingStepMd = (
  exit: Exit.Exit<unknown, RunError>,
  failedStep: FailedStepRow | undefined,
): string | undefined =>
  Exit.match(exit, {
    onSuccess: () => undefined,
    onFailure: (cause) =>
      Option.match(Cause.failureOption(cause), {
        onNone: () => undefined,
        onSome: (failure) => {
          // `_tag` read as data for the label, as `describeFailure` in core's step.ts does.
          const tag = (failure as { _tag?: unknown })._tag;
          if (typeof tag !== "string") return undefined;
          const stepName = Match.value(failure).pipe(
            Match.tag("StepFailed", (e) => e.step),
            Match.orElse(() => (failedStep?.errorTag === tag ? failedStep.name : undefined)),
          );
          return stepName === undefined
            ? `**Failed outside any step** — \`${tag}\``
            : `**Failing step:** \`${stepName}\` — \`${tag}\``;
        },
      }),
  });

/**
 * Append a run's failure markdown beneath the generic failure line (blank-line
 * separated, so the markdown renders as its own block), truncating the
 * markdown — never the verdict line — to keep the combined summary within
 * `CHECK_SUMMARY_MAX_CHARS`.
 */
export const appendFailureSummary = (
  genericLine: string,
  summaryMd: string | undefined,
): string => {
  if (summaryMd === undefined || summaryMd.trim() === "") return genericLine;
  const combined = `${genericLine}\n\n${summaryMd}`;
  if (combined.length <= CHECK_SUMMARY_MAX_CHARS) return combined;
  const budget =
    CHECK_SUMMARY_MAX_CHARS - genericLine.length - "\n\n".length - TRUNCATION_NOTE.length;
  // A generic line that alone exhausts the limit cannot happen today (it is a
  // single sentence), but guard anyway: drop the summary rather than the line.
  if (budget <= 0) return genericLine.slice(0, CHECK_SUMMARY_MAX_CHARS);
  // `slice` counts UTF-16 units, so the cut can land inside a surrogate pair —
  // strip a trailing lone high surrogate so the checks payload stays
  // well-formed (a mangled pair can 422 the whole update).
  const truncated = summaryMd.slice(0, budget).replace(/[\uD800-\uDBFF]$/, "");
  return `${genericLine}\n\n${truncated}${TRUNCATION_NOTE}`;
};
