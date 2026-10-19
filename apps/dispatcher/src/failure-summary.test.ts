// Tests for the failure-path presentation extraction (issue #85).
//
// `failureSummaryMd` pulls the run-authored markdown out of a run's `Exit`
// (`AcceptanceFailed.summaryMd`, and `StepFailed.summaryMd` since the staged
// `offload-test` rundown needed a died-stage carrier); `appendFailureSummary`
// splices it under the generic "execution failed" line, bounded to GitHub's
// 65535-char check-run summary limit.

import { Cause, Exit, FiberId } from "effect";
import { describe, expect, it } from "vitest";
import {
  AcceptanceFailed,
  AdmissionTimedOut,
  ExecFailed,
  ExecTimeout,
  RunDurationExceeded,
  RunSkipped,
  SandboxProcessLost,
  SecretsMissing,
  SerialQueueTimedOut,
  StepFailed,
} from "@fractalboxdev/flare-dispatch-core";
import {
  CHECK_SUMMARY_MAX_CHARS,
  TRUNCATION_NOTE,
  admissionTimedOutMd,
  appendFailureSummary,
  failingStepMd,
  failureSummaryMd,
  runSkippedReason,
} from "./failure-summary";

describe("failureSummaryMd", () => {
  it("renders a RunDurationExceeded naming the ceiling it crossed (issue #42)", () => {
    const md = failureSummaryMd(
      Exit.fail(new RunDurationExceeded({ maxDurationSec: 1800, elapsedSec: 1800 })),
    );
    expect(md).toContain("Exceeded the run ceiling");
    expect(md).toContain("30 min");
    expect(md).toContain("`limits.maxDurationSec: 1800`");
  });

  it("renders a SandboxProcessLost as an infrastructure loss with no verdict", () => {
    const md = failureSummaryMd(Exit.fail(new SandboxProcessLost({ launches: 3 })));
    expect(md).toContain("lost the check process");
    expect(md).toContain("3 launches");
    expect(md).toContain("not a check failure");
  });
  it("extracts the markdown from a failed Exit carrying AcceptanceFailed.summaryMd", () => {
    const exit = Exit.fail(
      new AcceptanceFailed({
        exitCode: 1,
        summaryMd: "# product-demo — 0/2 chapters passed",
      }),
    );
    expect(failureSummaryMd(exit)).toBe("# product-demo — 0/2 chapters passed");
  });

  it("is undefined for an AcceptanceFailed without summaryMd", () => {
    expect(failureSummaryMd(Exit.fail(new AcceptanceFailed({ exitCode: 1 })))).toBeUndefined();
  });

  it("renders an AdmissionTimedOut as an infra-wait explanation (issue #109)", () => {
    const exit = Exit.fail(
      new AdmissionTimedOut({
        queuedForMs: 1_200_000,
        position: 3,
        poolBusy: 16,
      }),
    );
    const md = failureSummaryMd(exit);
    expect(md).toBe(
      admissionTimedOutMd(
        new AdmissionTimedOut({
          queuedForMs: 1_200_000,
          position: 3,
          poolBusy: 16,
        }),
      ),
    );
    // The summary must read as capacity back-pressure, never a test failure.
    expect(md).toContain("Timed out waiting for a sandbox slot");
    expect(md).toContain("queued for 20 min behind 3 run(s)");
    expect(md).toContain("16 sandbox slot(s) in use");
    expect(md).toContain("never started");
    expect(md).toContain("not a test failure");
  });

  it("renders a SerialQueueTimedOut as a wait behind a live peer, not a failure of this run", () => {
    const md = failureSummaryMd(
      Exit.fail(
        new SerialQueueTimedOut({
          group: "worker-deploy:o/n@main",
          holderRevision: "0123456789abcdef0123",
          waitedMs: 3_600_000,
        }),
      ),
    );
    expect(md).toContain("in-flight run of `worker-deploy:o/n@main`");
    expect(md).toContain("60 min behind `0123456789ab`");
    expect(md).toContain("never started");
  });

  it("does not render a superseded run as a failure — it is a skip", () => {
    const exit = Exit.fail(new RunSkipped({ reason: "superseded by 0123456789ab" }));
    expect(runSkippedReason(exit)).toBe("superseded by 0123456789ab");
  });

  it("renders ExecFailed with exit code + stderr tail", () => {
    const md = failureSummaryMd(Exit.fail(new ExecFailed({ exitCode: 7, stderrTail: "boom" })));
    expect(md).toContain("Exec failed");
    expect(md).toContain("exit `7`");
    expect(md).toContain("boom");
  });

  it("renders ExecTimeout with the command", () => {
    const md = failureSummaryMd(
      Exit.fail(new ExecTimeout({ timeoutSec: 30, command: "pnpm test --watch" })),
    );
    expect(md).toContain("Exec timed out");
    expect(md).toContain("30s");
    expect(md).toContain("pnpm test --watch");
  });

  it("renders StepFailed with the step name + cause", () => {
    const md = failureSummaryMd(
      Exit.fail(
        new StepFailed({
          step: "resolve-command",
          cause: "offload-test: no command",
        }),
      ),
    );
    expect(md).toContain("Step `resolve-command` failed");
    expect(md).toContain("offload-test: no command");
  });

  it("renders a StepFailed's summaryMd as real markdown, not a code fence", () => {
    // The dead-stage rundown (offload-test staged mode) rides `summaryMd`
    // precisely so its ✓/✗/⊘ lines and log links render — fencing them made
    // the links unclickable and the backticks literal.
    const rundown = [
      "Stage `b` — `run-b` — died (`ExecTimeout`) after ~600s.",
      "",
      "- ✓ `a` — 12.3s ([log ↗](https://example.com/step-a.log))",
      "- ✗ `b` — died (`ExecTimeout`) after ~600s",
      "- ⊘ `c` — skipped",
    ].join("\n");
    const md = failureSummaryMd(
      Exit.fail(
        new StepFailed({
          step: "exec-b",
          cause: "stage `b` (`run-b`) died: ExecTimeout after ~600s",
          summaryMd: rundown,
        }),
      ),
    );
    expect(md).toContain("Step `exec-b` failed");
    expect(md).toContain(rundown);
    // No fence anywhere — the rundown is spliced as markdown.
    expect(md).not.toContain("```");
  });

  it("renders SecretsMissing with the absent keys", () => {
    const md = failureSummaryMd(Exit.fail(new SecretsMissing({ keys: ["NPM_TOKEN", "FOO"] })));
    expect(md).toContain("Missing Worker secrets");
    expect(md).toContain("`NPM_TOKEN`");
    expect(md).toContain("`FOO`");
  });

  it("is undefined for a success Exit", () => {
    expect(failureSummaryMd(Exit.succeed({ ok: true }))).toBeUndefined();
  });

  it("is undefined for a defect (Cause.die — failureOption is none)", () => {
    expect(failureSummaryMd(Exit.failCause(Cause.die("unexpected")))).toBeUndefined();
  });

  it("is undefined for an interrupt", () => {
    expect(failureSummaryMd(Exit.failCause(Cause.interrupt(FiberId.none)))).toBeUndefined();
  });
});

describe("runSkippedReason", () => {
  it("extracts the reason from a RunSkipped failure (issue #21)", () => {
    const exit = Exit.fail(
      new RunSkipped({
        reason:
          "the PR diff exceeds the model's context window even after truncation, so the review could not run",
      }),
    );
    expect(runSkippedReason(exit)).toBe(
      "the PR diff exceeds the model's context window even after truncation, so the review could not run",
    );
  });

  it("is undefined for other typed run errors (they stay red)", () => {
    expect(
      runSkippedReason(Exit.fail(new ExecFailed({ exitCode: 7, stderrTail: "boom" }))),
    ).toBeUndefined();
  });

  it("is undefined for a success Exit", () => {
    expect(runSkippedReason(Exit.succeed({ ok: true }))).toBeUndefined();
  });

  it("is undefined for a defect (Cause.die — failureOption is none)", () => {
    expect(runSkippedReason(Exit.failCause(Cause.die("unexpected")))).toBeUndefined();
  });

  it("is undefined for an interrupt", () => {
    expect(runSkippedReason(Exit.failCause(Cause.interrupt(FiberId.none)))).toBeUndefined();
  });
});

describe("appendFailureSummary", () => {
  const generic = "✗ product-demo — execution failed.";

  it("returns the generic line untouched when there is no summary", () => {
    expect(appendFailureSummary(generic, undefined)).toBe(generic);
  });

  it("returns the generic line untouched for a whitespace-only summary", () => {
    expect(appendFailureSummary(generic, "  \n ")).toBe(generic);
  });

  it("appends the summary beneath the generic line, blank-line separated", () => {
    expect(appendFailureSummary(generic, "| Chapter | Result |")).toBe(
      `${generic}\n\n| Chapter | Result |`,
    );
  });

  // The #85 seam: a generic line that already carries the signed log-link
  // suffix, plus a StepFailed-borne staged rundown whose own lines carry
  // per-stage log links. Both surfaces append to the same summary, so pin
  // that they compose — links from both survive, blank-line separated, and
  // the rundown is spliced as markdown rather than fenced.
  it("composes a link-bearing generic line with a link-bearing staged rundown", () => {
    const genericWithLinks = `✗ offload-test — execution failed. ([view log ↗](https://x/logs/i?t=t) · [dashboard ↗](https://dash/i))`;
    const rundown = [
      "- ✓ `a` — 12.3s ([log ↗](https://x/v1/artifacts/i/step-a.log))",
      "- ✗ `b` — died (`ExecTimeout`) after ~600s",
      "- ⊘ `c` — skipped",
    ].join("\n");
    const combined = appendFailureSummary(genericWithLinks, rundown);
    expect(combined).toBe(`${genericWithLinks}\n\n${rundown}`);
    expect(combined).toContain("[view log ↗]");
    expect(combined).toContain("[log ↗](https://x/v1/artifacts/i/step-a.log)");
    expect(combined).not.toContain("```");
    expect(combined.length).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_CHARS);
  });

  it("truncates an oversized summary so the total stays within GitHub's limit", () => {
    const huge = "x".repeat(CHECK_SUMMARY_MAX_CHARS + 1000);
    const combined = appendFailureSummary(generic, huge);
    expect(combined.length).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_CHARS);
    expect(combined.startsWith(`${generic}\n\n`)).toBe(true);
    expect(combined).toContain("summary truncated");
  });

  it("does not leave a lone high surrogate when the cut lands inside an astral char", () => {
    // Position an astral (two-UTF-16-unit) char so the truncation boundary
    // falls between its surrogate halves.
    const budget =
      CHECK_SUMMARY_MAX_CHARS - generic.length - "\n\n".length - TRUNCATION_NOTE.length;
    const md = "x".repeat(budget - 1) + "😀".repeat(2000);
    const combined = appendFailureSummary(generic, md);

    expect(combined.length).toBeLessThanOrEqual(CHECK_SUMMARY_MAX_CHARS);
    expect(combined.endsWith(TRUNCATION_NOTE)).toBe(true);
    // The char immediately before the truncation note must not be a lone
    // high surrogate (the split pair's first half).
    const beforeNote = combined.slice(0, combined.length - TRUNCATION_NOTE.length);
    expect(/[\uD800-\uDBFF]$/.test(beforeNote)).toBe(false);
  });

  it("keeps a within-limit summary verbatim (no truncation note)", () => {
    const md = "y".repeat(1000);
    const combined = appendFailureSummary(generic, md);
    expect(combined).toBe(`${generic}\n\n${md}`);
    expect(combined).not.toContain("summary truncated");
  });
});

describe("failingStepMd", () => {
  it("names the recorded step and the tag it failed with", () => {
    const md = failingStepMd(Exit.fail(new ExecFailed({ exitCode: 101, stderrTail: "x" })), {
      name: "measure",
      errorTag: "ExecFailed",
    });
    expect(md).toBe("**Failing step:** `measure` — `ExecFailed`");
  });

  it("takes the step a StepFailed names when no step row recorded the failure", () => {
    const md = failingStepMd(
      Exit.fail(new StepFailed({ step: "build-report", cause: "exit 2" })),
      undefined,
    );
    expect(md).toBe("**Failing step:** `build-report` — `StepFailed`");
  });

  it("ignores a step row whose tag differs from the run's failure", () => {
    const md = failingStepMd(Exit.fail(new SecretsMissing({ keys: ["K"] })), {
      name: "checkout",
      errorTag: "ExecFailed",
    });
    expect(md).toBe("**Failed outside any step** — `SecretsMissing`");
  });

  it("is undefined for a success Exit", () => {
    expect(failingStepMd(Exit.succeed(1), undefined)).toBeUndefined();
  });
});
