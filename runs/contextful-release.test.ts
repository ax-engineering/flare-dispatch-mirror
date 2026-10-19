import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, TestClock } from "effect";
import { describe, expect } from "vitest";
import { Sandbox, type CheckCommandService } from "@fractalboxdev/flare-dispatch-core";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulRelease, contextfulReleaseCell } from "./contextful-release";

const sha = "a".repeat(40);
const repo = "fractalboxdev/contextful";

describe("contextful-release", () => {
  it("subscribes only to live version-tag pushes from the release repository", () => {
    const trigger = contextfulRelease.triggers![0]!;
    const base = { repository: { full_name: repo }, ref: "refs/tags/v0.5.0", after: sha };
    expect(trigger.gate!({ payload: base })).toBe(true);
    expect(trigger.gate!({ payload: { ...base, after: "0".repeat(40) } })).toBe(false);
    expect(trigger.gate!({ payload: { ...base, ref: "refs/heads/main" } })).toBe(false);
    expect(trigger.gate!({ payload: { ...base, repository: { full_name: "other/repo" } } })).toBe(false);
    expect(trigger.inputs({ payload: base })).toEqual({ repo, tag: "v0.5.0", sha, dryRun: false });
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

  it.effect("manual dry-run joins ten cells and a formula child without a release write", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
      childRuns: { pollFn: (ids) => ids.map((id) => {
        if (id.startsWith("contextful-release-formula")) {
          return { executionId: id, status: "success", summaryJson: JSON.stringify({
            assets: ["contextful-control.rb", "contextful-edge.rb", "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"],
          }) };
        }
        const index = Number(id.split(":").at(-1));
        const profiles = ["contextful-control", "contextful-edge", "contextful-full"];
        const cells = profiles.flatMap((profile) =>
          (profile === "contextful-control" ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] :
            ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin"])
            .map((target) => ({ profile, target })));
        const cell = cells[index]!;
        const imageLayer = cell.target === "x86_64-unknown-linux-musl" ? {
          name: `${cell.profile}-0.5.0-linux-amd64.layer.tar.gz`,
          archiveName: `${cell.profile}-0.5.0-linux-amd64.oci.tar`,
          size: 3, digest: "a".repeat(64), diffId: "b".repeat(64),
        } : undefined;
        return { executionId: id, status: "success", summaryJson: JSON.stringify({ ...cell,
          manifest: JSON.stringify({ ...cell, archive: "archive.tar.gz", sha256: "a".repeat(64), sbom: "sbom.cdx.json" }),
          ...(imageLayer === undefined ? {} : { imageLayer }),
        }) };
      }) },
    });
    return Effect.gen(function* () {
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: true });
      expect(result).toMatchObject({ dryRun: true, cells: 10, assets: 36, releaseId: 0 });
      expect(handles.childRuns.spawned.filter((child) => child.run === "contextful-release-cell")).toHaveLength(10);
      expect(handles.childRuns.spawned.filter((child) => child.run === "contextful-release-formula")).toHaveLength(1);
      expect(handles.github.createReleaseCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("publishes a draft only after ten cells, formula assets, and three images succeed", () => {
    const profiles = ["contextful-control", "contextful-edge", "contextful-full"];
    const cells = profiles.flatMap((profile) =>
      (profile === "contextful-control" ? ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] :
        ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl", "x86_64-apple-darwin", "aarch64-apple-darwin"])
        .map((target) => ({ profile, target })));
    const { layer, handles } = makeCFRuntimeTest({
      github: { files: { [`${repo}:Cargo.toml`]: '[workspace.package]\nversion = "0.5.0"\n' } },
      childRuns: { pollFn: (ids) => ids.map((id) => {
        if (id.startsWith("contextful-release-formula")) return { executionId: id, status: "success",
          summaryJson: JSON.stringify({ assets: ["contextful-control.rb", "contextful-edge.rb",
            "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"] }) };
        const cell = cells[Number(id.split(":").at(-1))]!;
        const imageLayer = cell.target === "x86_64-unknown-linux-musl" ? {
          name: `${cell.profile}-0.5.0-linux-amd64.layer.tar.gz`, size: 3,
          archiveName: `${cell.profile}-0.5.0-linux-amd64.oci.tar`,
          digest: "a".repeat(64), diffId: "b".repeat(64),
        } : undefined;
        return { executionId: id, status: "success", summaryJson: JSON.stringify({ ...cell,
          manifest: JSON.stringify({ ...cell, archive: "archive.tar.gz", sha256: "a".repeat(64), sbom: "sbom.cdx.json" }),
          ...(imageLayer === undefined ? {} : { imageLayer }),
        }) };
      }) },
    });
    handles.github.tagCommits[`${repo}:v0.5.0`] = sha;
    return Effect.gen(function* () {
      const result = yield* contextfulRelease.run({ repo, tag: "v0.5.0", sha, dryRun: false });
      expect(result).toMatchObject({ dryRun: false, releaseId: 1, cells: 10, assets: 36 });
      expect(handles.github.createReleaseCalls).toHaveLength(1);
      expect(handles.github.createReleaseCalls[0]?.draft).toBe(true);
      expect(handles.github.publishContainerImageCalls).toHaveLength(3);
      expect(handles.github.publishReleaseCalls).toEqual([{ repo, releaseId: 1 }]);
      expect(handles.github.releases[`${repo}:v0.5.0`]?.draft).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
