import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import {
  contextfulMeasures,
  NIGHTLY_ISSUE_LABEL,
  NIGHTLY_ISSUE_TITLE,
  nightlyIssueBody,
  parseNightlyParts,
  previousMeasured,
  checkRunUrl,
  rangeCommand,
  reportCommand,
  reportNightlyFailures,
  resolveNightlyIssue,
  runAttempt,
} from "./contextful-measures";

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
      const reportExec = handles.sandbox.execs.find((entry) =>
        entry.command.includes("measure-report"),
      );
      expect(reportExec?.env?.MEASURE_RUN_ID).toBe("contextful_measures_attempt-2");
      expect(reportExec?.env?.MEASURE_RUN_ATTEMPT).toBe("2");
      expect(reportExec?.env?.MEASURE_EXIT).toBe("0");
    }).pipe(Effect.provide(layer));
  });

  it.effect("measures the commit the schedule pinned without re-reading the branch head", () => {
    const pinned = "b".repeat(40);
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "measure --tier all": { exitCode: 0 }, "measure-report": { exitCode: 0 } },
      sandboxFiles: { "/workspace/contextful/measure-report.json": report },
    });
    return Effect.gen(function* () {
      const out = yield* contextfulMeasures.run({ ...input, sha: pinned });
      expect(out.commit).toBe(pinned);
      expect(handles.github.branchHeadCalls).toHaveLength(0);
      expect(handles.sandbox.clones).toEqual([{ repo: input.repo, sha: pinned }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("re-clones a recycled container inside the measure step and reports from it", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: {
        // The probe answers non-zero: the container was recycled after checkout
        // and took the clone with it.
        "test -d /workspace/contextful/.git": { exitCode: 1 },
        "measure --tier all": { exitCode: 0 },
        "measure-report": { exitCode: 0 },
      },
      sandboxFiles: { "/workspace/contextful/measure-report.json": report },
    });
    return Effect.gen(function* () {
      yield* contextfulMeasures.run(input);
      // The nightly discovery step probes the same workspace and rebuilds it too.
      expect(handles.sandbox.clones).toEqual([
        { repo: input.repo, sha },
        { repo: input.repo, sha },
        { repo: input.repo, sha },
      ]);
      expect(handles.github.appendMeasureNoteCalls).toHaveLength(1);
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

  describe("nightly tier", () => {
    const head = sha;
    const prior = "c".repeat(40);
    const older = "d".repeat(40);
    const unmeasured = "e".repeat(40);
    const rangeOut = (annotated: readonly string[], history: readonly string[]) =>
      [
        "#annotated",
        ...annotated.map((commit, i) => `${String(i).padStart(40, "f")} ${commit}`),
        "#first-parent",
        ...history,
      ].join("\n");
    const nightlyParts = (parts: readonly string[]) => ({
      "stages --parts --tier nightly": { exitCode: 0, stdout: `${parts.join("\n")}\n` },
    });
    const baseProgram = {
      "measure --tier all": { exitCode: 0 },
      "measure-report": { exitCode: 0 },
      "git notes --ref=measures list": {
        exitCode: 0,
        stdout: rangeOut([head, older, prior], [head, unmeasured, prior, older]),
      },
    };
    const allSucceed = {
      pollFn: (ids: readonly string[]) =>
        ids.map((executionId) => ({ executionId, status: "success" as const })),
    };

    it("names the nearest first-parent ancestor carrying a measures note, never the head", () => {
      expect(
        previousMeasured(rangeOut([head, older, prior], [head, unmeasured, prior, older]), head),
      ).toBe(prior);
      expect(previousMeasured(rangeOut([head], [head, unmeasured]), head)).toBeUndefined();
      expect(previousMeasured("", head)).toBeUndefined();
      expect(rangeCommand).toContain(
        'git rev-list --first-parent --max-count=400 "$MEASURE_COMMIT"',
      );
    });

    it("reads a consumer without --tier as unsupported and any other failure as invalid", () => {
      expect(
        parseNightlyParts({
          exitCode: 2,
          stdout: "",
          stderr: "error: unexpected argument '--tier' found\n\nUsage: contextful-ci stages",
        }),
      ).toEqual({ kind: "unsupported" });
      expect(parseNightlyParts({ exitCode: 101, stdout: "", stderr: "panicked" })).toEqual({
        kind: "invalid",
      });
      expect(parseNightlyParts({ exitCode: 0, stdout: "formal\nformal\n", stderr: "" })).toEqual({
        kind: "invalid",
      });
      expect(parseNightlyParts({ exitCode: 0, stdout: "\n", stderr: "" })).toEqual({
        kind: "parts",
        parts: [],
      });
      expect(
        parseNightlyParts({ exitCode: 0, stdout: "features.packages\nformal\n", stderr: "" }),
      ).toEqual({ kind: "parts", parts: ["features.packages", "formal"] });
    });

    it.effect("opens one issue, then comments on it for the next failure", () => {
      const { layer, handles } = makeCFRuntimeTest();
      const body = nightlyIssueBody({
        repo: input.repo,
        previous: prior,
        head,
        failures: [{ part: "formal", checkUrl: "https://github.com/x/y/commit/z/checks" }],
      });
      return Effect.gen(function* () {
        const first = yield* reportNightlyFailures({ repo: input.repo, body });
        const second = yield* reportNightlyFailures({ repo: input.repo, body });
        expect(first.opened).toBe(true);
        expect(second).toEqual({ ...first, opened: false });
        expect(handles.github.openIssueCalls).toHaveLength(1);
        expect(handles.github.openIssueCalls[0]?.labels).toEqual([NIGHTLY_ISSUE_LABEL]);
        expect(handles.github.commentOnIssueCalls).toEqual([
          { repo: input.repo, issue: first.number, body },
        ]);
        expect(handles.github.issuesCalls.every((call) => call.strict === true)).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.effect("dispatches every nightly part as its own check, ten per window", () => {
      const parts = Array.from({ length: 12 }, (_, i) => `features.p${i}`);
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: { ...baseProgram, ...nightlyParts(parts) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: allSucceed,
      });
      return Effect.gen(function* () {
        const out = yield* contextfulMeasures.run(input);
        expect(out).toMatchObject({ nightlyParts: 12, nightlyFailed: [] });
        const inputs = handles.childRuns.spawned.map(
          (spawn) => spawn.input as { checkLabel: string; command: string; sha: string },
        );
        expect(handles.childRuns.spawned.every((spawn) => spawn.run === "check")).toBe(true);
        expect(inputs.map((child) => child.checkLabel)).toEqual(parts);
        expect(inputs[0]?.command).toBe(
          "cargo run --locked -q -p contextful-ci -- gate --predecessors --stage features.p0",
        );
        expect(inputs.every((child) => child.sha === sha)).toBe(true);
        expect(handles.childRuns.admissionHandoffs).toBe(1);
        expect(
          handles.executions.steps
            .map((entry) => entry.name)
            .filter((name) => name.startsWith("spawn-nightly-")),
        ).toEqual(["spawn-nightly-0", "spawn-nightly-10"]);
        expect(handles.github.openIssueCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("files the change range and each failed part's check, and fails the run", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: { ...baseProgram, ...nightlyParts(["features.packages", "formal"]) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: {
          pollFn: (ids) =>
            ids.map((executionId, index) =>
              index === 1
                ? { executionId, status: "failure" as const, checkRunId: "777" }
                : { executionId, status: "success" as const, checkRunId: "776" },
            ),
        },
      });
      return Effect.gen(function* () {
        const result = yield* Effect.exit(contextfulMeasures.run(input));
        expect(Exit.isFailure(result)).toBe(true);
        expect(handles.github.appendMeasureNoteCalls).toHaveLength(1);
        expect(handles.github.openIssueCalls).toHaveLength(1);
        const issue = handles.github.openIssueCalls[0]!;
        expect(issue.title).toBe(NIGHTLY_ISSUE_TITLE);
        expect(issue.body).toContain(`\`${prior}\`..\`${head}\``);
        expect(issue.body).toContain(
          `https://github.com/fractalboxdev/contextful/compare/${prior}...${head}`,
        );
        expect(issue.body).toContain(
          "[`flare-dispatch/check:formal`](https://github.com/fractalboxdev/contextful/runs/777)",
        );
        expect(issue.body).not.toContain("features.packages");
      }).pipe(Effect.provide(layer));
    });

    it.effect("joins successful spawns after one part fails to dispatch", () => {
      const parts = Array.from({ length: 12 }, (_, i) => `features.p${i}`);
      let spawnedAtFirstPoll: number | undefined;
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: { ...baseProgram, ...nightlyParts(parts) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: {
          failSpawn: ({ input }) =>
            (input as { checkLabel: string }).checkLabel === "features.p1",
          pollFn: (ids, call) => {
            if (call === 0) spawnedAtFirstPoll = handles.childRuns.spawned.length;
            return ids.map((executionId, index) => ({
              executionId,
              status: call === 0 && index === 1 ? ("failure" as const) : ("success" as const),
            }));
          },
        },
      });
      return Effect.gen(function* () {
        const result = yield* Effect.exit(contextfulMeasures.run(input));
        expect(Exit.isFailure(result)).toBe(true);
        expect(spawnedAtFirstPoll).toBe(9);
        expect(handles.childRuns.spawned).toHaveLength(11);
        expect(handles.childRuns.polls).toBe(2);
        const body = handles.github.openIssueCalls[0]?.body;
        expect(body).toContain("`features.p1`: not dispatched:");
        expect(body).toContain("flare-dispatch/check:features.p2");
        expect(body).not.toContain("features.p0");
        expect(body).not.toContain("features.p10");
      }).pipe(Effect.provide(layer));
    });

    it.effect("comments on the open nightly issue instead of opening a second", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: {
          branchHeads: { "fractalboxdev/contextful:main": sha },
          issues: [
            {
              repo: input.repo,
              number: 41,
              title: NIGHTLY_ISSUE_TITLE,
              body: "",
              state: "open",
              labels: [NIGHTLY_ISSUE_LABEL],
              author: "flare-dispatch[bot]",
              authorAssociation: "NONE",
              url: "https://github.com/fractalboxdev/contextful/issues/41",
              commentCount: 0,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        },
        sandboxProgram: { ...baseProgram, ...nightlyParts(["formal"]) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: {
          pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "failure" as const })),
        },
      });
      return Effect.gen(function* () {
        yield* Effect.exit(contextfulMeasures.run(input));
        expect(handles.github.openIssueCalls).toHaveLength(0);
        expect(handles.github.commentOnIssueCalls.map((call) => call.issue)).toEqual([41]);
      }).pipe(Effect.provide(layer));
    });

    it("links a part to its own check-run, else to the head's checks page", () => {
      const repo = input.repo;
      expect(checkRunUrl({ repo, head, checkRunId: "777" })).toBe(
        "https://github.com/fractalboxdev/contextful/runs/777",
      );
      for (const checkRunId of [undefined, "noop"]) {
        expect(checkRunUrl({ repo, head, checkRunId })).toBe(
          `https://github.com/fractalboxdev/contextful/commit/${head}/checks`,
        );
      }
    });

    const openNightlyIssue = {
      repo: input.repo,
      number: 41,
      title: NIGHTLY_ISSUE_TITLE,
      body: "",
      state: "open" as const,
      labels: [NIGHTLY_ISSUE_LABEL],
      author: "flare-dispatch[bot]",
      authorAssociation: "NONE",
      url: "https://github.com/fractalboxdev/contextful/issues/41",
      commentCount: 0,
      createdAt: 0,
      updatedAt: 0,
    };

    it.effect("closes the streak's issue on a green night; the next failure opens a new one", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: {
          branchHeads: { "fractalboxdev/contextful:main": sha },
          issues: [openNightlyIssue],
        },
        sandboxProgram: { ...baseProgram, ...nightlyParts(["formal"]) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: allSucceed,
      });
      return Effect.gen(function* () {
        yield* contextfulMeasures.run(input);
        expect(handles.github.closeBotIssueCalls).toEqual([
          {
            repo: input.repo,
            issue: 41,
            label: NIGHTLY_ISSUE_LABEL,
            comment: expect.stringContaining(`passed on \`${head}\``),
          },
        ]);
        expect(handles.github.commentOnIssueCalls.map((call) => call.issue)).toEqual([41]);
        expect(handles.github.issues.find((i) => i.number === 41)?.state).toBe("closed");
        expect(handles.github.removeIssueLabelCalls).toHaveLength(0);
        expect(handles.github.closeIssueAsDuplicateCalls).toHaveLength(0);

        const next = yield* reportNightlyFailures({ repo: input.repo, body: "red again" });
        expect(next).toMatchObject({ opened: true });
        expect(next.number).not.toBe(41);
        expect(yield* resolveNightlyIssue({ repo: input.repo, head })).toEqual([next.number]);
        expect(handles.github.issues.find((i) => i.number === next.number)?.state).toBe("closed");
      }).pipe(Effect.provide(layer));
    });

    it.effect("closes nothing on a green night with no open streak issue", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: {
          branchHeads: { "fractalboxdev/contextful:main": sha },
          issues: [{ ...openNightlyIssue, state: "closed" as const }],
        },
        sandboxProgram: { ...baseProgram, ...nightlyParts(["formal"]) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: allSucceed,
      });
      return Effect.gen(function* () {
        yield* contextfulMeasures.run(input);
        expect(handles.github.closeBotIssueCalls).toHaveLength(0);
        expect(handles.github.commentOnIssueCalls).toHaveLength(0);
        expect(handles.github.removeIssueLabelCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("leaves a person's streak issue open and only drops its label", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { issues: [{ ...openNightlyIssue, author: "a-maintainer" }] },
      });
      return Effect.gen(function* () {
        expect(yield* resolveNightlyIssue({ repo: input.repo, head })).toEqual([41]);
        expect(handles.github.issues.find((i) => i.number === 41)?.state).toBe("open");
        expect(handles.github.commentOnIssueCalls.map((call) => call.issue)).toEqual([41]);
        expect(handles.github.removeIssueLabelCalls).toEqual([
          { repo: input.repo, issue: 41, label: NIGHTLY_ISSUE_LABEL },
        ]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("leaves another bot's matching issue untouched", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { issues: [{ ...openNightlyIssue, author: "other-app[bot]" }] },
      });
      return Effect.gen(function* () {
        yield* resolveNightlyIssue({ repo: input.repo, head });
        expect(handles.github.issues.find((i) => i.number === 41)?.state).toBe("open");
        expect(handles.github.commentOnIssueCalls).toHaveLength(0);
        expect(handles.github.removeIssueLabelCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("ends the streak when nightly discovery succeeds with no parts", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: {
          branchHeads: { "fractalboxdev/contextful:main": sha },
          issues: [openNightlyIssue],
        },
        sandboxProgram: { ...baseProgram, ...nightlyParts([]) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
      });
      return Effect.gen(function* () {
        const out = yield* contextfulMeasures.run(input);
        expect(out).toMatchObject({ nightlyParts: 0, nightlyFailed: [] });
        expect(handles.childRuns.spawned).toHaveLength(0);
        expect(handles.github.commentOnIssueCalls[0]?.body).toContain(`passed on \`${head}\``);
        expect(handles.github.issues.find((i) => i.number === 41)?.state).toBe("closed");
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails the parent when a nightly part is named measures", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: { ...baseProgram, ...nightlyParts(["measures"]) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: {
          pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "failure" as const })),
        },
      });
      return Effect.gen(function* () {
        const result = yield* Effect.exit(contextfulMeasures.run(input));
        expect(Exit.isFailure(result)).toBe(true);
        expect(handles.childRuns.spawned).toHaveLength(1);
        expect(handles.github.openIssueCalls[0]?.body).toContain("flare-dispatch/check:measures");
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports a window that outlives its deadline and still runs the next", () => {
      const parts = Array.from({ length: 12 }, (_, i) => `features.p${i}`);
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: { ...baseProgram, ...nightlyParts(parts) },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        // Each clock read advances an hour, so a window's deadline passes while
        // its children still run.
        io: { tickMs: 3_600_000 },
        childRuns: {
          pollFn: (ids) => ids.map((executionId) => ({ executionId, status: "running" as const })),
        },
      });
      return Effect.gen(function* () {
        const result = yield* Effect.exit(contextfulMeasures.run(input));
        expect(Exit.isFailure(result)).toBe(true);
        expect(handles.childRuns.spawned).toHaveLength(12);
        expect(handles.github.openIssueCalls).toHaveLength(1);
        const body = handles.github.openIssueCalls[0]!.body;
        for (const part of parts) {
          expect(body).toContain(
            `[\`flare-dispatch/check:${part}\`](https://github.com/fractalboxdev/contextful/commit/${head}/checks): did not settle before the window's deadline`,
          );
        }
      }).pipe(Effect.provide(layer));
    });

    it.effect("runs the tier and files the ledger failure when the report cannot be built", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: {
          ...baseProgram,
          "measure-report": { exitCode: 1, stderr: "no records" },
          ...nightlyParts(["formal"]),
        },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
        childRuns: allSucceed,
      });
      return Effect.gen(function* () {
        const result = yield* Effect.exit(contextfulMeasures.run(input));
        expect(Exit.isFailure(result)).toBe(true);
        expect(handles.github.appendMeasureNoteCalls).toHaveLength(0);
        expect(handles.childRuns.spawned).toHaveLength(1);
        expect(handles.github.openIssueCalls[0]?.body).toContain("- `measures`: build-report");
        expect(handles.github.removeIssueLabelCalls).toHaveLength(0);
        expect(handles.github.closeBotIssueCalls).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.effect("skips the tier and logs once when the consumer rejects --tier", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: {
          ...baseProgram,
          "stages --parts --tier nightly": {
            exitCode: 2,
            stderr:
              "error: unexpected argument '--tier' found\n\nUsage: contextful-ci stages --parts",
          },
        },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
      });
      return Effect.gen(function* () {
        const out = yield* contextfulMeasures.run(input);
        expect(out).toMatchObject({ nightlyParts: 0, nightlyFailed: [] });
        expect(handles.childRuns.spawned).toHaveLength(0);
        expect(handles.childRuns.admissionHandoffs).toBe(0);
        expect(handles.github.openIssueCalls).toHaveLength(0);
        expect(handles.io.logs.filter((entry) => entry.msg.includes("--tier"))).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports a failed nightly discovery like a failed part", () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: {
          ...baseProgram,
          "stages --parts --tier nightly": { exitCode: 101, stderr: "thread 'main' panicked" },
        },
        sandboxFiles: { "/workspace/contextful/measure-report.json": report },
      });
      return Effect.gen(function* () {
        const result = yield* Effect.exit(contextfulMeasures.run(input));
        expect(Exit.isFailure(result)).toBe(true);
        expect(handles.childRuns.spawned).toHaveLength(0);
        expect(handles.github.openIssueCalls[0]?.body).toContain("`stages --parts --tier nightly`");
      }).pipe(Effect.provide(layer));
    });
  });
});
