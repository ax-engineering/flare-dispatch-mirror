import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, TestClock } from "effect";
import { describe, expect } from "vitest";
import { ChildRuns, GitHubApiError, Github, IO, Sandbox, StepRunner, type CheckCommandService } from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulRelease, contextfulReleaseCell, contextfulReleaseFormula, RELEASE_WINDOW, SPAWN_ORDER } from "./contextful-release";

const sha = "a".repeat(40);
const repo = "fractalboxdev/contextful";

/**
 * The cell verdict a failed release reports: a typed `AcceptanceFailed` whose
 * markdown the check-run renders, one bullet line per outcome.
 */
const verdictOf = (exit: Exit.Exit<unknown, unknown>): readonly string[] | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause)) as
    { _tag?: string; exitCode?: number; summaryMd?: string } | undefined;
  expect(failure?._tag).toBe("AcceptanceFailed");
  expect(failure?.exitCode).toBe(1);
  return failure?.summaryMd?.split("\n").filter((line) => line.startsWith("- "));
};

describe("contextful-release", () => {
  it("subscribes only to live version-tag pushes from the release repository", () => {
    const trigger = contextfulRelease.triggers![0]!;
    const base = { repository: { full_name: repo }, ref: "refs/tags/v0.5.0", after: sha };
    expect(trigger.gate!({ payload: base })).toBe(true);
    expect(trigger.gate!({ payload: { ...base, after: "0".repeat(40) } })).toBe(false);
    expect(trigger.gate!({ payload: { ...base, ref: "refs/heads/main" } })).toBe(false);
    expect(trigger.gate!({ payload: { ...base, repository: { full_name: "other/repo" } } })).toBe(false);
    expect(trigger.inputs({ payload: base })).toEqual({ repo, tag: "v0.5.0", sha, dryRun: false });
    expect(trigger.gate!({ payload: { ...base, ref: "refs/tags/dry-run/v0.5.0" } })).toBe(false);
  });

  it("subscribes to dry-run tag pushes as a dry run of the named version", () => {
    const [live, dry] = contextfulRelease.triggers!;
    const base = { repository: { full_name: repo }, ref: "refs/tags/dry-run/v0.5.0", after: sha };
    expect(dry!.gate!({ payload: base })).toBe(true);
    expect(dry!.gate!({ payload: { ...base, after: "0".repeat(40) } })).toBe(false);
    expect(dry!.gate!({ payload: { ...base, ref: "refs/tags/v0.5.0" } })).toBe(false);
    expect(dry!.gate!({ payload: { ...base, ref: "refs/heads/dry-run/v0.5.0" } })).toBe(false);
    expect(dry!.gate!({ payload: { ...base, repository: { full_name: "other/repo" } } })).toBe(false);
    expect(dry!.inputs({ payload: base })).toEqual({ repo, tag: "v0.5.0", sha, dryRun: true });
    expect(dry!.idempotencyKey!({ payload: base })).toBe(`contextful-release-dry:refs/tags/dry-run/v0.5.0:${sha}`);
    expect(dry!.idempotencyKey!({ payload: base })).not.toBe(
      live!.idempotencyKey!({ payload: { ...base, ref: "refs/tags/v0.5.0" } }));
  });

  it.effect("builds and stages a dry-run cell without publishing", () => {
    const profile = "contextful-control";
    const target = "aarch64-unknown-linux-musl";
    const stem = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile, target, archive: `${stem}.tar.gz`,
      sha256: "a".repeat(64), sbom: `${stem}.cdx.json` });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${stem}.release.json`]: manifest,
        [`/workspace/contextful/dist/${stem}.tar.gz.sha256`]: `${"a".repeat(64)}  ${stem}.tar.gz\n` },
    });
    return Effect.gen(function* () {
      const result = yield* contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 0, dryRun: true });
      expect(result.assets).toEqual([`${stem}.tar.gz`, `${stem}.tar.gz.sha256`, `${stem}.cdx.json`]);
      expect(result.imageLayer).toBeUndefined();
      expect(handles.sandbox.execs.map((exec) => exec.command)).toEqual(
        expect.arrayContaining([expect.stringContaining("release --builder zigbuild")]));
      expect(handles.artifact.uploads).toHaveLength(3);
      expect(handles.executions.steps.some((entry) => entry.name.startsWith("publish-"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  const cellFixture = () => {
    const profile = "contextful-control";
    const target = "aarch64-unknown-linux-musl";
    const name = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile, target, archive: `${name}.tar.gz`,
      sha256: "a".repeat(64), sbom: `${name}.cdx.json` });
    return { profile, target, name, runtime: makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${name}.release.json`]: manifest,
        [`/workspace/contextful/dist/${name}.tar.gz.sha256`]: `${"a".repeat(64)}  ${name}.tar.gz\n` },
    }) };
  };
  /** A durable owner whose build runs for `polls` observations, then exits 0. */
  const durableBuild = (polls: number, calls: string[]): CheckCommandService => ({
    prepare: (opts) => Effect.sync(() => {
      calls.push(`prepare:${opts.stepName}`);
      expect(opts.timeoutSec).toBe(14400);
      return { id: opts.stepName, container: opts.container!, fingerprint: "f", startedAt: 0, deadline: 14400000 };
    }),
    start: (h) => Effect.sync(() => void calls.push(`start:${h.id}`)),
    observe: (h) => Effect.sync(() => {
      calls.push(`observe:${h.id}`);
      return calls.filter((c) => c === `observe:${h.id}`).length < polls
        ? { state: "running" as const }
        : { state: "exited" as const, exitCode: 0, durationMs: 1 };
    }),
    finalize: (h) => Effect.sync(() => {
      calls.push(`finalize:${h.id}`);
      return { exitCode: 0, durationMs: 1, logPath: "logs/build.ndjson", stdout: "", stderr: "" };
    }),
  });

  it.effect("a multi-hour build is a polled sandbox process: no step waits on the build, and assets publish one step each", () => {
    const { profile, target, name, runtime: { layer, handles } } = cellFixture();
    const calls: string[] = [];
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      const running = yield* Effect.fork(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 7, dryRun: false })
        .pipe(Effect.provideService(Sandbox, { ...original, checkCommand: durableBuild(40, calls) })));
      yield* TestClock.adjust("1 hour");
      const result = yield* Fiber.join(running);
      expect(result.assets).toHaveLength(3);
      expect(handles.sandbox.execs.map((exec) => exec.command).join("\n")).not.toContain("zigbuild");
      expect(calls.filter((c) => c.startsWith("observe:"))).toHaveLength(40);
      const names = handles.executions.steps.map((entry) => entry.name);
      expect(names).toEqual(expect.arrayContaining(["checkout", "build-workspace", "build-prepare",
        "build-start", "build-observe-39", "build-finalize", "collect",
        `publish-${name}.tar.gz`, `publish-${name}.tar.gz.sha256`, `publish-${name}.cdx.json`]));
      const longest = Math.max(...handles.executions.steps.map((entry) =>
        Number(entry.metadata?.["stepOpts.timeoutSec"] ?? 0)));
      expect(longest).toBeLessThanOrEqual(1800);
    }).pipe(Effect.provide(layer));
  });

  /** A `publishReleaseAsset` that answers each call from `script`, then succeeds. */
  const scriptedPublish = (script: Array<GitHubApiError | undefined>, calls: string[]) =>
    Effect.gen(function* () {
      const original = yield* Github;
      return { ...original, publishReleaseAsset: (req: Parameters<typeof original.publishReleaseAsset>[0]) =>
        Effect.suspend(() => {
          calls.push(req.artifactName);
          const failure = script.shift();
          return failure === undefined ? original.publishReleaseAsset(req) : Effect.fail(failure);
        }) };
    });

  it.effect("a rate-limited asset upload waits out the retry hint durably, then publishes", () => {
    const { profile, target, name, runtime: { layer, handles } } = cellFixture();
    const calls: string[] = [];
    const limited = new GitHubApiError({ status: 403, reason: "rate-limited", retryAfterMs: 700_965 });
    return Effect.gen(function* () {
      const scripted = yield* scriptedPublish([limited], calls);
      const running = yield* Effect.fork(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 7, dryRun: false }).pipe(Effect.provideService(Github, scripted)));
      yield* TestClock.adjust("10 minutes");
      expect(calls).toEqual([`${name}.tar.gz`]);
      yield* TestClock.adjust("1 hour");
      const result = yield* Fiber.join(running);
      expect(result.assets).toHaveLength(3);
      expect(calls).toEqual([`${name}.tar.gz`, `${name}.tar.gz`, `${name}.tar.gz.sha256`, `${name}.cdx.json`]);
      const publishes = handles.executions.steps.map((entry) => entry.name)
        .filter((step) => step.startsWith(`publish-${name}.tar.gz`) && !step.endsWith(".sha256"));
      expect(publishes).toEqual([`publish-${name}.tar.gz`, `publish-${name}.tar.gz-retry-1`]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rate limits a cell cannot wait out within an hour fail the cell as rate-limited", () => {
    const { profile, target, runtime: { layer } } = cellFixture();
    const calls: string[] = [];
    const limited = () => new GitHubApiError({ status: 403, reason: "rate-limited", retryAfterMs: 1_500_000 });
    return Effect.gen(function* () {
      const scripted = yield* scriptedPublish([limited(), limited(), limited()], calls);
      const running = yield* Effect.fork(Effect.exit(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 7, dryRun: false }).pipe(Effect.provideService(Github, scripted))));
      yield* TestClock.adjust("3 hours");
      const exit = yield* Fiber.join(running);
      expect(calls).toHaveLength(3);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.failureOption(exit.cause)).toMatchObject({
        _tag: "Some", value: { _tag: "GitHubApiError", reason: "rate-limited" } });
    }).pipe(Effect.provide(layer));
  });

  it.effect("collect retries a transient upload or read, and a lost build always fits one relaunch", () => {
    const { profile, target, runtime: { layer, handles } } = cellFixture();
    return Effect.gen(function* () {
      yield* contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha, profile, target, releaseId: 0, dryRun: true });
      const collect = handles.executions.steps.find((entry) => entry.name === "collect");
      expect(collect?.metadata?.["stepOpts.retryOn"]).toEqual(
        expect.arrayContaining(["ExecFailed", "StepFailed", "ArtifactUploadFailed"]));
      expect(contextfulReleaseCell.limits.maxDurationSec).toBeGreaterThanOrEqual(2 * 14400);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a manifest read that fails is a retryable StepFailed, not a defect", () => {
    const profile = "contextful-control";
    const target = "aarch64-unknown-linux-musl";
    const { layer } = makeCFRuntimeTest();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 0, dryRun: true }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.failureOption(exit.cause)).toMatchObject({
        _tag: "Some", value: { _tag: "StepFailed", step: "collect" } });
    }).pipe(Effect.provide(layer));
  });

  it.effect("outputs lost with a recycled container after the build rebuild before staging", () => {
    const { profile, target, runtime: { layer, handles } } = cellFixture();
    const calls: string[] = [];
    let probes = 0;
    return Effect.gen(function* () {
      const original = yield* Sandbox;
      // Probe 1 is the build's workspace check; probes 2 and 3 see the
      // recycled container from `collect` and the rebuild's workspace check.
      const recycled = { ...original, checkCommand: durableBuild(1, calls),
        exec: (opts: Parameters<typeof original.exec>[0]) => {
          const command = typeof opts.command === "string" ? opts.command : opts.command.join(" ");
          if (command.startsWith("test -d") && ++probes >= 2 && probes <= 3) {
            return Effect.succeed({ exitCode: 1, durationMs: 1, logPath: "logs/probe", stdout: "", stderr: "" });
          }
          return original.exec(opts);
        } };
      const result = yield* contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile, target, releaseId: 0, dryRun: true }).pipe(Effect.provideService(Sandbox, recycled));
      expect(result.assets).toHaveLength(3);
      expect(calls.filter((c) => c.startsWith("prepare:"))).toEqual(["prepare:build", "prepare:build-rebuild-1"]);
      expect(handles.sandbox.clones).toHaveLength(2);
      expect(handles.executions.steps.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["collect", "build-rebuild-1-finalize", "collect-rebuild-1"]));
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an archive whose bytes differ from the release manifest digest", () => {
    const target = "aarch64-unknown-linux-musl";
    const name = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile: "contextful-control", target,
      archive: `${name}.tar.gz`, sha256: "b".repeat(64), sbom: `${name}.cdx.json` });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${name}.release.json`]: manifest,
        [`/workspace/contextful/dist/${name}.tar.gz.sha256`]: `${"b".repeat(64)}  ${name}.tar.gz\n` },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile: "contextful-control", target, releaseId: 0, dryRun: true }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.artifact.uploads).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses a checksum file that names different release bytes", () => {
    const target = "aarch64-unknown-linux-musl";
    const name = `contextful-control-0.5.0-${target}`;
    const manifest = JSON.stringify({ profile: "contextful-control", target,
      archive: `${name}.tar.gz`, sha256: "a".repeat(64), sbom: `${name}.cdx.json` });
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } },
      sandboxFiles: { [`/workspace/contextful/dist/${name}.release.json`]: manifest,
        [`/workspace/contextful/dist/${name}.tar.gz.sha256`]: `${"b".repeat(64)}  ${name}.tar.gz\n` },
    });
    return Effect.gen(function* () {
      const result = yield* Effect.exit(contextfulReleaseCell.run({ repo, tag: "v0.5.0", sha,
        profile: "contextful-control", target, releaseId: 0, dryRun: true }));
      expect(Exit.isFailure(result)).toBe(true);
      expect(handles.artifact.uploads).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  const formulaManifests = JSON.stringify(Array.from({ length: 10 }, () => ({})));
  const formulaFiles = { "sha256sum": { exitCode: 0, stdout: `${"a".repeat(64)}  asset\n` } };

  it.effect("the formula child returns the release notes contextful-ci formula writes", () => {
    const { layer } = makeCFRuntimeTest({ sandboxProgram: formulaFiles,
      sandboxFiles: { "/workspace/contextful/dist/release-notes.md": "## Consumer compatibility\n" } });
    return Effect.gen(function* () {
      const result = yield* contextfulReleaseFormula.run({ repo, tag: "v0.5.0", sha, releaseId: 0, dryRun: true,
        manifests: formulaManifests });
      expect(result.notes).toBe("## Consumer compatibility\n");
      expect(result.assets).toHaveLength(6);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a tag whose formula step writes no release notes keeps the draft body", () => {
    const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: { ...formulaFiles, "test -f": { exitCode: 1 } } });
    return Effect.gen(function* () {
      const result = yield* contextfulReleaseFormula.run({ repo, tag: "v0.5.0", sha, releaseId: 0, dryRun: true,
        manifests: formulaManifests });
      expect(result.notes).toBeUndefined();
      expect(handles.sandbox.reads.some((read) => read.path.endsWith("release-notes.md"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  type Cell = { profile: string; target: string };
  const MATRIX: Cell[] = ["contextful-control", "contextful-edge", "contextful-full"].flatMap((profile) =>
    (profile === "contextful-control" ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] :
      ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin"])
      .map((target) => ({ profile, target })));
  const FORMULA_ASSETS = ["contextful-control.rb", "contextful-edge.rb", "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"];
  const cellOutput = (cell: Cell) => {
    const imageLayer = cell.target === "x86_64-unknown-linux-musl" ? {
      name: `${cell.profile}-0.5.0-linux-amd64.layer.tar.gz`, size: 3,
      archiveName: `${cell.profile}-0.5.0-linux-amd64.oci.tar`,
      digest: "a".repeat(64), diffId: "b".repeat(64),
    } : undefined;
    return JSON.stringify({ ...cell,
      manifest: JSON.stringify({ ...cell, archive: "archive.tar.gz", sha256: "a".repeat(64), sbom: "sbom.cdx.json" }),
      ...(imageLayer === undefined ? {} : { imageLayer }) });
  };
  /** A child's poll verdict; `{ failure }` is a failure that recorded that error tag. */
  type Verdict = "running" | "success" | "failure" | { readonly failure: string };
  /**
   * A release whose cell children report `status(cell, poll, now, attempt)`,
   * read from the spawned input, and whose formula child succeeds. Sleeps
   * advance a clock and are recorded, so a wait's cadence is observable.
   */
  const releaseFixture = (
    status: (cell: Cell, poll: number, now: number, attempt: number) => Verdict,
    existing: readonly string[] = [],
    spendClosed?: () => string | undefined,
  ) => {
    let spawned: readonly { readonly input: unknown; readonly instanceId: string }[] = [];
    let now = 0;
    const runtime = makeCFRuntimeTest({
      github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
      childRuns: { existing, ...(spendClosed !== undefined ? { spendClosed } : {}), pollFn: (ids, poll) => ids.map((id) => {
        if (id.startsWith("contextful-release-formula")) {
          return { executionId: id, status: "success", summaryJson: JSON.stringify({ assets: FORMULA_ASSETS,
            notes: "## Consumer compatibility\n" }) };
        }
        const { profile, target, attempt } = spawned.find((child) => child.instanceId === id)!.input as Cell & { attempt?: number };
        const cell = { profile, target };
        const verdict = status(cell, poll, now, attempt ?? 0);
        return typeof verdict === "object"
          ? { executionId: id, status: "failure", failureTag: verdict.failure }
          : verdict === "success"
            ? { executionId: id, status: verdict, summaryJson: cellOutput(cell) }
            : { executionId: id, status: verdict };
      }) },
    });
    spawned = runtime.handles.childRuns.spawned;
    const sleeps: { name: string; ms: number }[] = [];
    const provideClock = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.gen(function* () {
      const runner = yield* StepRunner;
      const clock = yield* IO;
      return yield* effect.pipe(
        Effect.provideService(StepRunner, { ...runner,
          sleep: (name, ms) => Effect.sync(() => { sleeps.push({ name, ms }); now += ms; }) }),
        Effect.provideService(IO, { ...clock, now: Effect.sync(() => now) }),
      );
    });
    return { ...runtime, sleeps, provideClock };
  };
  const cellsOf = (handles: ReturnType<typeof makeCFRuntimeTest>["handles"]) => handles.childRuns.spawned
    .filter((child) => child.run === "contextful-release-cell")
    .map((child) => { const { profile, target } = child.input as Cell; return `${profile}/${target}`; });
  const stepNames = (handles: ReturnType<typeof makeCFRuntimeTest>["handles"]) =>
    handles.executions.steps.map((entry) => entry.name);

  it.effect("manual dry-run joins ten cells and a formula child without a release write", () => {
    const { layer, handles } = releaseFixture(() => "success");
    return Effect.gen(function* () {
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true });
      expect(result).toMatchObject({ dryRun: true, cells: 10, assets: 36, releaseId: 0 });
      expect(handles.childRuns.spawned.filter((child) => child.run === "contextful-release-cell")).toHaveLength(10);
      expect(handles.childRuns.spawned.filter((child) => child.run === "contextful-release-formula")).toHaveLength(1);
      expect(handles.github.createReleaseCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes a draft only after ten cells, formula assets, and three images succeed", () => {
    const { layer, handles } = releaseFixture(() => "success");
    handles.github.tagCommits[`${repo}:v0.5.0`] = sha;
    return Effect.gen(function* () {
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: false });
      expect(result).toMatchObject({ dryRun: false, releaseId: 1, cells: 10, assets: 36 });
      expect(handles.github.createReleaseCalls).toHaveLength(1);
      expect(handles.github.createReleaseCalls[0]?.draft).toBe(true);
      expect(handles.github.publishContainerImageCalls).toHaveLength(3);
      expect(handles.github.publishReleaseCalls).toEqual([{ repo, releaseId: 1,
        body: "Release v0.5.0\n\n## Consumer compatibility\n" }]);
      expect(handles.github.releases[`${repo}:v0.5.0`]?.draft).toBe(false);
      const steps = stepNames(handles);
      expect(steps.indexOf("spawn-formula")).toBeGreaterThan(Math.max(...steps
        .map((name, index) => (name.startsWith("await-cells-") ? index : -1))));
      expect(steps.indexOf("verify-tag")).toBeLessThan(steps.findIndex((name) => name.startsWith("publish-image-")));
    }).pipe(Effect.provide(layer));
  });

  it.effect("starts every full and edge cell at once and refills each freed slot, polling every 30 s", () => {
    // full x86_64 settles on the second poll; every other long cell on the fourth.
    const { layer, handles, sleeps, provideClock } = releaseFixture((cell, poll) =>
      cell.profile === "contextful-control" ? "success"
        : poll >= (cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl" ? 1 : 3)
          ? "success" : "running");
    return Effect.gen(function* () {
      const result = yield* provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true }));
      expect(result).toMatchObject({ cells: 10, assets: 36 });
      expect(RELEASE_WINDOW).toBe(8);
      expect(cellsOf(handles)).toEqual(SPAWN_ORDER.map((cell) => `${cell.profile}/${cell.target}`));
      expect(cellsOf(handles).slice(0, 8).some((cell) => cell.startsWith("contextful-control/"))).toBe(false);
      expect(cellsOf(handles).slice(8)).toEqual([
        "contextful-control/x86_64-unknown-linux-musl", "contextful-control/aarch64-unknown-linux-musl"]);
      expect(stepNames(handles).filter((name) => name.startsWith("spawn-cells-")))
        .toEqual(["spawn-cells-0", "spawn-cells-8", "spawn-cells-9"]);
      expect(handles.childRuns.admissionHandoffs).toBe(1);
      const cellSleeps = sleeps.filter((sleep) => sleep.name.startsWith("await-cells-"));
      expect(cellSleeps.length).toBeGreaterThan(0);
      expect(cellSleeps.every((sleep) => sleep.ms === 30_000)).toBe(true);
      // The formula reads the manifests in matrix order, whatever order the cells settled in.
      const formula = handles.childRuns.spawned.find((child) => child.run === "contextful-release-formula")!;
      const manifests = JSON.parse((formula.input as { manifests: string }).manifests) as Cell[];
      expect(manifests.map((cell) => `${cell.profile}/${cell.target}`))
        .toEqual(MATRIX.map((cell) => `${cell.profile}/${cell.target}`));
    }).pipe(Effect.provide(layer));
  });

  it.effect("a failed cell starts no further cell, lets the running ones settle, and names every failure", () => {
    const { layer, handles, provideClock } = releaseFixture((cell, poll) =>
      cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl" ? "failure"
        : cell.profile === "contextful-full" && cell.target === "aarch64-apple-darwin" && poll >= 1 ? "failure"
          : poll >= 2 ? "success" : "running");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(verdictOf(exit)).toEqual([
        "- Failed: `contextful-full/x86_64-unknown-linux-musl`, `contextful-full/aarch64-apple-darwin`",
        "- Not started: `contextful-control/x86_64-unknown-linux-musl`, `contextful-control/aarch64-unknown-linux-musl`",
      ]);
      expect(cellsOf(handles)).toHaveLength(8);
      expect(cellsOf(handles).some((cell) => cell.startsWith("contextful-control/"))).toBe(false);
      expect(handles.childRuns.spawned.some((child) => child.run === "contextful-release-formula")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  const skipOf = (exit: Exit.Exit<unknown, unknown>) => {
    if (!Exit.isFailure(exit)) return undefined;
    const failure = Option.getOrUndefined(Cause.failureOption(exit.cause)) as
      { _tag?: string; reason?: string } | undefined;
    expect(failure?._tag).toBe("RunSkipped");
    return failure?.reason;
  };
  const budgetReason = "spend budget reached: $90.00 of $90.00 this month";

  it.effect("a budget closed before the first spawn starts no cell and skips the release", () => {
    const { layer, handles, provideClock } = releaseFixture(() => "success", [], () => budgetReason);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true })));
      expect(skipOf(exit)).toBe(`${budgetReason} — 10 of 10 release cells not started`);
      expect(handles.childRuns.spawned).toHaveLength(0);
      expect(handles.childRuns.admissionHandoffs).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a budget that closes mid-release starts no further cell, lets the running ones settle, then skips", () => {
    // The first window spawns; the budget is closed for every later spawn.
    let gateCalls = 0;
    const { layer, handles, provideClock } = releaseFixture(
      (cell, poll) => (cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl") || poll >= 3
        ? "success" : "running",
      [],
      () => (gateCalls++ === 0 ? undefined : budgetReason),
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true })));
      expect(skipOf(exit)).toBe(`${budgetReason} — 2 of 10 release cells not started`);
      expect(cellsOf(handles)).toHaveLength(8);
      expect(handles.childRuns.spawned.some((child) => child.run === "contextful-release-formula")).toBe(false);
      // Every running cell was awaited to its terminal poll before the release ended.
      const awaits = stepNames(handles).filter((name) => name.startsWith("await-cells-"));
      expect(awaits.length).toBeGreaterThan(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a cell the platform lost respawns as a fresh child, at most twice, and the release completes", () => {
    const lost = (cell: Cell, tag: string, attempts: number) => (c: Cell, attempt: number) =>
      c.profile === cell.profile && c.target === cell.target && attempt < attempts ? { failure: tag } : undefined;
    const rules = [
      lost({ profile: "contextful-full", target: "x86_64-unknown-linux-musl" }, "SandboxProcessLost", 2),
      lost({ profile: "contextful-edge", target: "aarch64-apple-darwin" }, "ContainerLaunchFailed", 1),
      lost({ profile: "contextful-control", target: "x86_64-unknown-linux-musl" }, "AdmissionTimedOut", 1),
    ];
    const { layer, handles, provideClock } = releaseFixture((cell, poll, _now, attempt) =>
      rules.map((rule) => rule(cell, attempt)).find((verdict) => verdict !== undefined)
        ?? (poll >= 1 ? "success" : "running"));
    return Effect.gen(function* () {
      const result = yield* provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true }));
      expect(result).toMatchObject({ cells: 10, assets: 36 });
      const cells = handles.childRuns.spawned.filter((child) => child.run === "contextful-release-cell");
      expect(cells).toHaveLength(14);
      expect(new Set(cells.map((child) => child.instanceId)).size).toBe(14);
      const attemptsOf = (profile: string, target: string) => cells
        .map((child) => child.input as Cell & { attempt?: number })
        .filter((input) => input.profile === profile && input.target === target)
        .map((input) => input.attempt);
      // The first attempt keeps the input a release in flight spawned with.
      expect(attemptsOf("contextful-full", "x86_64-unknown-linux-musl")).toEqual([undefined, 1, 2]);
      expect(attemptsOf("contextful-edge", "aarch64-apple-darwin")).toEqual([undefined, 1]);
      expect(attemptsOf("contextful-control", "x86_64-unknown-linux-musl")).toEqual([undefined, 1]);
      const spawns = stepNames(handles).filter((name) => name.startsWith("spawn-cells-"));
      expect(new Set(spawns).size).toBe(spawns.length);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a cell lost on every attempt fails the release after two retries and starts nothing more", () => {
    const { layer, handles, provideClock } = releaseFixture((cell, poll) =>
      cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl" ? { failure: "SandboxProcessLost" }
        : poll >= 2 ? "success" : "running");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true })));
      expect(verdictOf(exit)?.[0]).toBe("- Failed: `contextful-full/x86_64-unknown-linux-musl`");
      expect(cellsOf(handles).filter((cell) => cell === "contextful-full/x86_64-unknown-linux-musl")).toHaveLength(3);
      expect(handles.childRuns.spawned.some((child) => child.run === "contextful-release-formula")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a build failure is a verdict: the cell is not respawned", () => {
    const { layer, handles, provideClock } = releaseFixture((cell, poll) =>
      cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl" ? { failure: "StepFailed" }
        : poll >= 2 ? "success" : "running");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true })));
      expect(verdictOf(exit)?.[0]).toBe("- Failed: `contextful-full/x86_64-unknown-linux-musl`");
      expect(cellsOf(handles).filter((cell) => cell === "contextful-full/x86_64-unknown-linux-musl")).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it("runs on the release pool under replay-safe step names", () => {
    // The parent queues behind other releases, never behind lean-pool gates.
    expect(contextfulRelease.sandboxImage).toBe("release");
    expect(contextfulReleaseCell.sandboxImage).toBe("release");
    expect(contextfulRelease.version).toBe("1.3.0");
  });

  it.effect("window steps share no name with the fixed batches a release in flight checkpointed", () => {
    const { layer, handles } = releaseFixture(() => "success");
    return Effect.gen(function* () {
      yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true });
      const steps = stepNames(handles);
      expect(steps.some((name) => /^(spawn|await)-release-cells-/.test(name))).toBe(false);
      expect(steps).toEqual(expect.arrayContaining(["spawn-cells-0", "handoff-admission", "await-cells-0-poll-0"]));
    }).pipe(Effect.provide(layer));
  });
  it.effect("a cell that outlives its budget after another failed ends the release naming the failure, the hang and the unstarted cells", () => {
    const { layer, provideClock } = releaseFixture((cell, poll) =>
      cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl" ? "failure"
        : cell.profile === "contextful-full" && cell.target === "aarch64-apple-darwin" ? "running"
          : poll >= 2 ? "success" : "running");
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true })));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(verdictOf(exit)).toEqual([
        "- Failed: `contextful-full/x86_64-unknown-linux-musl`",
        "- Timed out: `contextful-full/aarch64-apple-darwin`",
        "- Not started: `contextful-control/x86_64-unknown-linux-musl`, `contextful-control/aarch64-unknown-linux-musl`",
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a cell that settles after its queue age and run ceiling, inside its lease wait and teardown, is observed", () => {
    // The child's ceiling starts after admission and the lease, and its row
    // lands after teardown: a cell using its whole allowance settles after
    // queue age + run ceiling measured from the parent's spawn.
    const allowance = (21600 + 2 * 14400 + 3600 + 600 + 60) * 1000;
    const { layer, provideClock } = releaseFixture((cell, _poll, now) =>
      cell.profile === "contextful-full" && cell.target === "x86_64-unknown-linux-musl" && now < allowance
        ? "running" : "success");
    return Effect.gen(function* () {
      const result = yield* provideClock(contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true }));
      expect(result).toMatchObject({ cells: 10, assets: 36 });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a release in flight across the deploy re-attaches the children its fixed batches spawned", () => {
    // The live layer derives a child's instance id from its input; the fixed
    // batches spawned the first three matrix cells from this input shape.
    const derive = (input: unknown) => `contextful-release-cell.${JSON.stringify(input)}`;
    const batchZero = MATRIX.slice(0, 3).map((cell) =>
      derive({ ...cell, repo, tag: "v0.5.0", sha, releaseId: 0, dryRun: true }));
    const { layer, handles } = releaseFixture(() => "success", batchZero);
    return Effect.gen(function* () {
      const children = yield* ChildRuns;
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true }).pipe(
        Effect.provideService(ChildRuns, { ...children, spawn: (opts) => children.spawn({ ...opts,
          instanceId: opts.instanceId ?? (opts.run === "contextful-release-cell" ? derive(opts.input) : undefined) }) }));
      expect(result).toMatchObject({ cells: 10 });
      const cells = handles.childRuns.spawned.filter((child) => child.run === "contextful-release-cell");
      expect(cells).toHaveLength(10);
      expect(cells.filter((child) => !child.created).map((child) => child.instanceId).sort()).toEqual([...batchZero].sort());
    }).pipe(Effect.provide(layer));
  });
});
