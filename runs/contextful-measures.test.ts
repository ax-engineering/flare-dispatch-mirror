import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulMeasures, reportCommand, runAttempt } from "./contextful-measures";

const sha = "a".repeat(40);
const input = {
  repo: "fractalboxdev/contextful",
  ref: "refs/heads/main",
  firedAt: Date.UTC(2026, 9, 6, 2, 17),
};
const report = JSON.stringify({
  commit: sha,
  run_id: "contextful-measures:1791253020000",
  run_attempt: 1,
  exit_code: 0,
  records: [],
});

describe("contextful-measures", () => {
  it("allows a scheduled measurement to queue behind a full sandbox pool", () => {
    expect(contextfulMeasures.limits.admissionMaxQueueAgeSec).toBe(21600);
  });
  it("delegates the note line to contextful-ci measure-report with the execution attempt", () => {
    expect(reportCommand).toContain("+refs/notes/measures:refs/notes/measures || true");
    expect(reportCommand).toContain(
      'contextful-ci -- measure-report --commit "$MEASURE_COMMIT" --run-id "$MEASURE_RUN_ID" --run-attempt "$MEASURE_RUN_ATTEMPT" --exit-code "$MEASURE_EXIT" --out measure-report.json',
    );
    expect(runAttempt("contextful_measures_attempt-2")).toBe(2);
    expect(runAttempt("contextful_measures_daily")).toBe(1);
  });
  it.effect("measures the resolved default-branch SHA and attaches its report", () => {
    const { layer, handles } = makeCFRuntimeTest({
      executionId: "contextful_measures_attempt-2",
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: { "measure --tier all": { exitCode: 0 }, "measure-report": { exitCode: 0 } },
      sandboxFiles: { "/workspace/contextful/measure-report.json": report },
    });
    return Effect.gen(function* () {
      const out = yield* contextfulMeasures.run(input);
      expect(out.commit).toBe(sha);
      expect(handles.sandbox.clones).toEqual([{ repo: input.repo, sha }]);
      expect(handles.github.appendMeasureNoteCalls).toEqual([
        { repo: input.repo, commit: sha, text: report },
      ]);
      expect(handles.artifact.uploads[0]?.name).toBe("measure-report.json");
      const reportExec = handles.sandbox.execs.find((entry) => entry.command.includes("measure-report"));
      expect(reportExec?.env?.MEASURE_RUN_ID).toBe("contextful_measures_attempt-2");
      expect(reportExec?.env?.MEASURE_RUN_ATTEMPT).toBe("2");
      expect(reportExec?.env?.MEASURE_EXIT).toBe("0");
    }).pipe(Effect.provide(layer));
  });

  it.effect("attaches a report even when a measure tier is red", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: { "measure --tier all": { exitCode: 3 }, "measure-report": { exitCode: 0 } },
      sandboxFiles: { "/workspace/contextful/measure-report.json": report },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulMeasures.run(input));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.github.appendMeasureNoteCalls).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });
});
