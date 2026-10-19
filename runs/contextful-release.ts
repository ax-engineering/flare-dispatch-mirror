import { Effect, Schema } from "effect";
import {
  AcceptanceFailed, artifact, checkpointSleep, defineRun, GitHubApiError, github, handoffChildAdmission, io,
  isTerminalChildStatus, sandbox, step, StepFailed, type ChildStatusRecord,
} from "@fractalboxdev/flare-dispatch-core";
import {
  DURABLE_EXEC_RETRY_ON, durableExec, ensureWorkspace, fanOut, waitForAnyChildDurably, waitForChildren, workspace,
  type Workspace,
} from "@fractalboxdev/flare-dispatch-core/primitives";

const REPO = "fractalboxdev/contextful";
const VERSION_TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/;
const SHA = /^[a-f0-9]{40}$/;
const DRY_RUN_TAG_PREFIX = "refs/tags/dry-run/v";
const PROFILES = ["contextful-control", "contextful-edge", "contextful-full"] as const;
const LINUX = ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"] as const;
const DARWIN = ["x86_64-apple-darwin", "aarch64-apple-darwin"] as const;
/** The build command's own deadline; the supervisor ends the process at it. */
const RELEASE_BUILD_TIMEOUT_SEC = 14400;
/** Rebuilds after a recycled container takes finished outputs before they reach R2. */
const OUTPUT_REBUILDS = 1;
/**
 * A relaunch after a lost process. One fits inside the run ceiling however
 * late the loss strikes; a second could not, and would end as
 * `RunDurationExceeded` hours later instead of `SandboxProcessLost` now.
 */
const BUILD_RELAUNCHES = 1;
/**
 * Two full builds, plus staging and publishing: a lost build always has room
 * for its one relaunch or rebuild.
 */
const CELL_MAX_DURATION_SEC = 2 * RELEASE_BUILD_TIMEOUT_SEC + 3600;
/**
 * Platform failures `collect` retries. A retry re-probes the checkout, so a
 * read or upload that failed because the container was recycled ends as
 * `lost` and a rebuild, and a transient R2 error simply uploads again.
 */
const COLLECT_RETRY_ON = [...DURABLE_EXEC_RETRY_ON, "ArtifactUploadFailed"] as const;
/** Digests, the image footprint and OCI layer (600 s each), and the R2 uploads. */
const COLLECT_STEP_TIMEOUT_SEC = 1800;
const CELLS = PROFILES.flatMap((profile) =>
  (profile === "contextful-control" ? LINUX : [...LINUX, ...DARWIN]).map((target) => ({
    profile,
    target,
  })),
);
/**
 * Total time one cell waits out GitHub rate limits on its asset uploads. A
 * primary quota resets within the hour; a limit outlasting this fails the cell.
 */
const PUBLISH_RATE_LIMIT_BUDGET_MS = 3_600_000;
/**
 * Added per cell index to each rate-limit wait, so cells limited together
 * retry in sequence rather than as one burst.
 */
const PUBLISH_STAGGER_MS = 15_000;
/** A cell's admission queue age: two concurrent releases share the release pool. */
const CELL_QUEUE_SEC = 21600;
/**
 * Cells in flight at once: the release pool's `max_instances` (wrangler.jsonc
 * `RunSandboxRelease`). The container losses #223 saw at eight were deploy
 * rollouts replacing running release containers; #226's rollout grace keeps a
 * rollout off a running release container, so the whole pool runs cells.
 */
export const RELEASE_WINDOW = 8;
/**
 * Respawns of a cell the platform lost: its container, its launch, or its
 * admission. Each is a fresh child instance; a build that ran and failed is a
 * verdict and never respawns.
 */
const CELL_RETRIES = 2;
/** Failure tags a cell child ends with when the platform, not the build, failed it. */
const INFRASTRUCTURE_FAILURES: ReadonlySet<string> = new Set([
  "SandboxProcessLost", "ContainerLaunchFailed", "AdmissionTimedOut",
]);
/** Status-poll cadence while the window is full. */
const RELEASE_POLL_EVERY = "30 seconds";
/**
 * What a cell spends outside its queue age and run ceiling: the 600 s
 * container-lease wait before its ceiling starts, then teardown and the
 * terminal-row write after it ends, and the parent's next poll.
 */
const CELL_SETTLE_MARGIN_SEC = 1800;
/** A spawned cell's whole budget: queue age, run ceiling, and the settle margin. */
const CELL_BUDGET_MS = (CELL_QUEUE_SEC + CELL_MAX_DURATION_SEC + CELL_SETTLE_MARGIN_SEC) * 1000;
/**
 * Spawn order, longest cells first: `full` links DuckDB and wasmtime, `edge`
 * DuckDB, `control` neither. The two short `control` cells take the first
 * slots that free, so the last cell to finish is a long one started at once.
 */
export const SPAWN_ORDER = (["contextful-full", "contextful-edge", "contextful-control"] as const)
  .flatMap((profile) => CELLS.filter((cell) => cell.profile === profile));

const ReleaseInput = Schema.Struct({
  repo: Schema.String,
  tag: Schema.String,
  sha: Schema.String,
  dryRun: Schema.optional(Schema.Boolean),
});

const ReleaseCellInput = Schema.Struct({
  repo: Schema.String,
  tag: Schema.String,
  sha: Schema.String,
  profile: Schema.String,
  target: Schema.String,
  releaseId: Schema.Number,
  dryRun: Schema.Boolean,
  /** A respawn after the platform lost the cell; absent on the first attempt. */
  attempt: Schema.optional(Schema.Number),
});

const ReleaseCellOutput = Schema.Struct({
  profile: Schema.String,
  target: Schema.String,
  manifest: Schema.String,
  assets: Schema.Array(Schema.String),
  imageLayer: Schema.optional(Schema.Struct({
    name: Schema.String, archiveName: Schema.String,
    size: Schema.Number, digest: Schema.String, diffId: Schema.String,
  })),
});

const FormulaInput = Schema.Struct({
  repo: Schema.String, tag: Schema.String, sha: Schema.String,
  releaseId: Schema.Number, dryRun: Schema.Boolean, manifests: Schema.String,
});
/**
 * `notes` is the `release-notes.md` stating every cell's compatibility verdict.
 * A tag whose `contextful-ci formula` predates it writes none, and its release
 * keeps the draft body.
 */
const FormulaOutput = Schema.Struct({ assets: Schema.Array(Schema.String), notes: Schema.optional(Schema.String) });

const ReleaseOutput = Schema.Struct({
  tag: Schema.String,
  sha: Schema.String,
  dryRun: Schema.Boolean,
  releaseId: Schema.Number,
  cells: Schema.Number,
  assets: Schema.Number,
});

const stem = (profile: string, version: string, target: string): string =>
  `contextful-${profile.replace(/^contextful-/, "")}-${version}-${target}`;

const requireValidRequest = (repo: string, tag: string, sha: string): void => {
  if (repo !== REPO || !VERSION_TAG.test(tag) || !SHA.test(sha)) {
    throw new Error("release requires the configured repository, a version tag, and a full SHA");
  }
};

type ImageLayer = { name: string; archiveName: string; size: number; digest: string; diffId: string };
type StagedAsset = { name: string; sha256: string; contentType: string };
type Collected =
  | { kind: "lost" }
  | { kind: "staged"; manifest: string; assets: readonly StagedAsset[]; imageLayer?: ImageLayer };

const contentType = (name: string): string =>
  name.endsWith(".json") ? "application/json" : name.endsWith(".gz") ? "application/gzip" : "text/plain";

/**
 * Verify a finished build's outputs and stage them in R2. Everything after this
 * reads R2, not the container, so it is the last step that needs the build's
 * disk. A checkout that is gone means the container was recycled after the
 * build finished — `lost`, and the cell rebuilds; a checkout that is present
 * without its manifest is a build defect.
 */
const collect = (input: { profile: string; target: string }, version: string, ws: Workspace) =>
  Effect.gen(function* () {
    const name = stem(input.profile, version, input.target);
    const probe = yield* sandbox.exec({ container: ws.container,
      command: ["test", "-d", `${ws.dir}/.git`], timeoutSec: 30 });
    if (probe.exitCode !== 0) return { kind: "lost" } as Collected;
    const manifestPath = `${ws.dir}/dist/${name}.release.json`;
    // A read that fails is the container's, not the build's: `StepFailed`
    // retries, and the retry's probe decides between staging and `lost`.
    const readOutput = (path: string) => sandbox.readFile({ container: ws.container, path }).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "collect", cause })));
    const manifest = yield* readOutput(manifestPath);
    const parsed = JSON.parse(manifest) as { profile: string; target: string; archive: string; sha256: string; sbom: string };
    if (parsed.profile !== input.profile || parsed.target !== input.target || parsed.archive !== `${name}.tar.gz` ||
      parsed.sbom !== `${name}.cdx.json` || !/^[a-f0-9]{64}$/.test(parsed.sha256)) {
      return yield* Effect.die(new Error("release cell manifest does not match its inputs"));
    }
    const checksum = yield* readOutput(`${ws.dir}/dist/${parsed.archive}.sha256`);
    if (checksum.trim() !== `${parsed.sha256}  ${parsed.archive}`) {
      return yield* Effect.die(new Error("release checksum file differs from its manifest"));
    }
    const assets: StagedAsset[] = [];
    for (const asset of [parsed.archive, `${parsed.archive}.sha256`, parsed.sbom]) {
      const path = `${ws.dir}/dist/${asset}`;
      const digest = yield* sandbox.exec({ container: ws.container, command: ["sha256sum", path], timeoutSec: 120 });
      const sha256 = digest.stdout.match(/^([a-f0-9]{64})\s/)?.[1];
      if (digest.exitCode !== 0 || sha256 === undefined) return yield* Effect.die(new Error(`missing SHA-256 for ${asset}`));
      if (asset === parsed.archive && sha256 !== parsed.sha256) {
        return yield* Effect.die(new Error("release archive digest differs from its manifest"));
      }
      yield* artifact.upload({ name: asset, path, container: ws.container });
      assets.push({ name: asset, sha256, contentType: contentType(asset) });
    }
    if (input.target !== "x86_64-unknown-linux-musl") return { kind: "staged", manifest, assets } as Collected;
    const layerName = `${input.profile}-${version}-linux-amd64.layer.tar.gz`;
    const archiveName = `${input.profile}-${version}-linux-amd64.oci.tar`;
    const base = `${ws.dir}/dist/${input.profile}-${version}-image`;
    const binary = `${ws.dir}/target/release-artifacts/${input.target}/release/contextful`;
    const footprint = yield* sandbox.exec({ container: ws.container, cwd: ws.dir,
      command: ["cargo", "run", "--locked", "-q", "-p", "contextful-ci", "--", "footprint",
        "--profile", input.profile, binary], timeoutSec: 600 });
    if (footprint.exitCode !== 0) return yield* Effect.die(new Error(`image footprint failed for ${input.profile}`));
    const built = yield* sandbox.exec({ container: ws.container, cwd: ws.dir,
      command: ["/opt/build-oci-layer.sh", binary, `${base}/root`,
        `${ws.dir}/dist/${layerName}`, `${ws.dir}/dist/${archiveName}`, version],
      timeoutSec: 600 });
    const lines = built.stdout.trim().split("\n");
    const diffId = lines[0]?.match(/^([a-f0-9]{64})\s/)?.[1];
    const digest = lines[1]?.match(/^([a-f0-9]{64})\s/)?.[1];
    const size = Number(lines[2]);
    if (built.exitCode !== 0 || diffId === undefined || digest === undefined || !Number.isSafeInteger(size)) {
      return yield* Effect.die(new Error("OCI image layer failed"));
    }
    yield* artifact.upload({ name: layerName, path: `${ws.dir}/dist/${layerName}`, container: ws.container });
    yield* artifact.upload({ name: archiveName, path: `${ws.dir}/dist/${archiveName}`, container: ws.container });
    return { kind: "staged", manifest, assets, imageLayer: { name: layerName, archiveName, size, digest, diffId } } as Collected;
  });

/**
 * One upload attempt. A rate limit carrying a retry hint completes the step
 * with the hint instead of failing it: the step's own retries would resend
 * within seconds, and the cell waits the hint out in a durable sleep.
 */
const publishOrRateLimit = (
  input: typeof ReleaseCellInput.Type,
  asset: StagedAsset,
) =>
  github.publishReleaseAsset({
    repo: input.repo, releaseId: input.releaseId, artifactName: asset.name,
    contentType: asset.contentType, sha256: asset.sha256,
  }).pipe(
    Effect.as({ kind: "published" as const }),
    Effect.catchTag("GitHubApiError", (error) =>
      error.reason === "rate-limited" && error.retryAfterMs !== undefined
        ? Effect.succeed({ kind: "rate-limited" as const, status: error.status, retryAfterMs: error.retryAfterMs })
        : Effect.fail(error)),
  );

export const contextfulReleaseCell = defineRun({
  name: "contextful-release-cell",
  // 1.2.0 — a rate-limited asset upload waits out its retry hint durably.
  version: "1.2.0",
  sandboxImage: "release",
  inputs: ReleaseCellInput,
  outputs: ReleaseCellOutput,
  limits: { maxDurationSec: CELL_MAX_DURATION_SEC, admissionMaxQueueAgeSec: CELL_QUEUE_SEC },
  run: (input) =>
    Effect.gen(function* () {
      requireValidRequest(input.repo, input.tag, input.sha);
      if (!CELLS.some((cell) => cell.profile === input.profile && cell.target === input.target)) {
        return yield* Effect.die(new Error("release cell is outside the ten-cell matrix"));
      }
      if (!Number.isSafeInteger(input.releaseId) || (!input.dryRun && input.releaseId <= 0)) {
        return yield* Effect.die(new Error("release cell requires a valid draft release id"));
      }
      const version = input.tag.slice(1);
      let ws = yield* step("checkout", () => workspace({ repo: input.repo, sha: input.sha }));
      for (let rebuild = 0; rebuild <= OUTPUT_REBUILDS; rebuild++) {
        const suffix = rebuild === 0 ? "" : `-rebuild-${rebuild}`;
        // The build is a sandbox-owned process polled across short steps, so a
        // multi-hour cross-build holds no step open and survives a recycled
        // container by relaunching; see `durableExec`.
        const built = yield* durableExec({
          name: `build${suffix}`,
          workspace: ws,
          relaunches: BUILD_RELAUNCHES,
          ensure: (current) => ensureWorkspace({ current, repo: input.repo, sha: input.sha }),
          exec: (checkout) => ({
            cwd: checkout.dir,
            command: [
              "cargo", "run", "--locked", "-q", "-p", "contextful-ci", "--", "release",
              "--builder", "zigbuild", "--profile", input.profile,
              "--target", input.target, "--target-dir", "target/release-artifacts", "--out", "dist",
            ],
            redactValues: [],
            timeoutSec: RELEASE_BUILD_TIMEOUT_SEC,
          }),
        });
        if (built.result.exitCode !== 0) {
          return yield* Effect.die(new Error(`release build failed for ${input.profile}/${input.target}: ${built.result.exitCode}`));
        }
        ws = built.workspace;
        const staged = built.workspace;
        const collected = yield* step(`collect${suffix}`, () => collect(input, version, staged),
          { timeoutSec: COLLECT_STEP_TIMEOUT_SEC, retries: 3, retryOn: COLLECT_RETRY_ON });
        if (collected.kind === "lost") continue;
        // Each asset publishes from R2 in its own step; an asset already
        // uploaded with the same digest is kept, so a retry is a no-op.
        if (!input.dryRun) {
          const stagger = CELLS.findIndex((cell) => cell.profile === input.profile && cell.target === input.target)
            * PUBLISH_STAGGER_MS;
          let waitedMs = 0;
          for (const asset of collected.assets) {
            for (let attempt = 0; ; attempt++) {
              const name = attempt === 0 ? `publish-${asset.name}` : `publish-${asset.name}-retry-${attempt}`;
              const outcome = yield* step(name, () => publishOrRateLimit(input, asset),
                { retries: 3, retryOn: ["GitHubApiError", "StepFailed"] });
              if (outcome.kind === "published") break;
              const waitMs = outcome.retryAfterMs + stagger;
              if (waitedMs + waitMs > PUBLISH_RATE_LIMIT_BUDGET_MS) {
                return yield* Effect.fail(new GitHubApiError({ status: outcome.status, reason: "rate-limited",
                  retryAfterMs: outcome.retryAfterMs }));
              }
              waitedMs += waitMs;
              yield* checkpointSleep(`${name}-rate-limit-wait`, waitMs);
            }
          }
        }
        return { profile: input.profile, target: input.target, manifest: collected.manifest,
          assets: collected.assets.map((asset) => asset.name),
          ...(collected.imageLayer !== undefined ? { imageLayer: collected.imageLayer } : {}) };
      }
      return yield* Effect.die(new Error(
        `release outputs for ${input.profile}/${input.target} were lost with their container on each of ${OUTPUT_REBUILDS + 1} builds`));
    }),
});

export const contextfulReleaseFormula = defineRun({
  name: "contextful-release-formula",
  version: "1.1.0",
  sandboxImage: "release",
  inputs: FormulaInput,
  outputs: FormulaOutput,
  limits: { maxDurationSec: 7200, admissionMaxQueueAgeSec: 21600 },
  run: (input) => step("generate-and-upload", () => Effect.gen(function* () {
    requireValidRequest(input.repo, input.tag, input.sha);
    const manifests = JSON.parse(input.manifests) as unknown[];
    if (manifests.length !== CELLS.length) return yield* Effect.die(new Error("formula needs ten release manifests"));
    const checkout = yield* workspace({ repo: input.repo, sha: input.sha });
    const formula = yield* sandbox.exec({
      container: checkout.container, cwd: checkout.dir,
      command: ["sh", "-lc", "mkdir -p dist && printf %s \"$FD_RELEASE_MANIFEST\" > dist/release-manifest.json && cargo run --locked -q -p contextful-ci -- formula --manifest dist/release-manifest.json --dist dist --base-url \"$FD_RELEASE_BASE_URL\""],
      env: { FD_RELEASE_MANIFEST: input.manifests, FD_RELEASE_BASE_URL: `https://github.com/${REPO}/releases/download/${input.tag}` },
      timeoutSec: 1800,
    });
    if (formula.exitCode !== 0) return yield* Effect.die(new Error(`formula generation failed: ${formula.exitCode}`));
    const notesPath = `${checkout.dir}/dist/release-notes.md`;
    const hasNotes = yield* sandbox.exec({ container: checkout.container, command: ["test", "-f", notesPath], timeoutSec: 30 });
    const notes = hasNotes.exitCode === 0 ? yield* sandbox.readFile({ container: checkout.container, path: notesPath }).pipe(
      Effect.mapError((cause) => new StepFailed({ step: "generate-and-upload", cause }))) : undefined;
    const assets = ["contextful-control.rb", "contextful-edge.rb", "contextful-full.rb", "contextful.rb", "SHA256SUMS", "install.sh"];
    for (const name of assets) {
      const path = name.endsWith(".rb") ? `${checkout.dir}/dist/Formula/${name}` : name === "install.sh" ? `${checkout.dir}/install.sh` : `${checkout.dir}/dist/${name}`;
      const digest = yield* sandbox.exec({ container: checkout.container, command: ["sha256sum", path], timeoutSec: 120 });
      const sha256 = digest.stdout.match(/^([a-f0-9]{64})\s/)?.[1];
      if (digest.exitCode !== 0 || sha256 === undefined) return yield* Effect.die(new Error(`missing SHA-256 for ${name}`));
      yield* artifact.upload({ name, path, container: checkout.container });
      if (!input.dryRun) yield* github.publishReleaseAsset({ repo: input.repo, releaseId: input.releaseId, artifactName: name,
        contentType: "text/plain", sha256 });
    }
    return notes === undefined ? { assets } : { assets, notes };
  })),
});

export const contextfulRelease = defineRun({
  name: "contextful-release",
  // 1.3.0 — a `dry-run/v<version>` tag push starts a dry run of `v<version>`.
  // 1.2.0 — publishes the formula step's release notes as the release body.
  // 1.1.0 — release pool, sliding window of cells.
  version: "1.3.0",
  // The parent makes no sandbox call and hands its admission row off after
  // its first spawn. On the release pool it queues only behind other
  // releases, never behind pull-request gates on the lean pool.
  sandboxImage: "release",
  inputs: ReleaseInput,
  outputs: ReleaseOutput,
  limits: { maxDurationSec: 259200, admissionMaxQueueAgeSec: 21600 },
  triggers: [{
    event: "push",
    gate: ({ payload }) => payload.repository?.full_name === REPO &&
      typeof payload.ref === "string" && payload.ref.startsWith("refs/tags/v") &&
      typeof payload.after === "string" && SHA.test(payload.after) && payload.after !== "0".repeat(40),
    idempotencyKey: ({ payload }) => `contextful-release:${String(payload.ref)}:${String(payload.after)}`,
    inputs: ({ payload }) => ({ repo: REPO, tag: String(payload.ref).slice("refs/tags/".length), sha: String(payload.after), dryRun: false }),
  }, {
    // `refs/tags/dry-run/v<version>` builds every cell, the formula and the
    // image archives for `v<version>` and publishes nothing: a dry run creates
    // no draft release, uploads no release asset, pushes no container image
    // and never publishes. `after` is the pushed object, so the tag must be
    // lightweight to name the commit directly.
    event: "push",
    gate: ({ payload }) => payload.repository?.full_name === REPO &&
      typeof payload.ref === "string" && payload.ref.startsWith(DRY_RUN_TAG_PREFIX) &&
      typeof payload.after === "string" && SHA.test(payload.after) && payload.after !== "0".repeat(40),
    idempotencyKey: ({ payload }) => `contextful-release-dry:${String(payload.ref)}:${String(payload.after)}`,
    inputs: ({ payload }) => ({ repo: REPO, tag: String(payload.ref).slice("refs/tags/dry-run/".length), sha: String(payload.after), dryRun: true }),
  }],
  run: (input) => Effect.gen(function* () {
    requireValidRequest(input.repo, input.tag, input.sha);
    const dryRun = input.dryRun !== false;
    const tag = dryRun ? { refSha: input.sha, commitSha: input.sha } :
      yield* step("resolve-tag", () => github.tagTarget({ repo: input.repo, tag: input.tag }));
    if (!dryRun && input.sha !== tag.refSha && input.sha !== tag.commitSha) {
      return yield* Effect.die(new Error("release tag no longer names the dispatched SHA"));
    }
    const onDefaultBranch = yield* step("verify-default-branch", () =>
      github.commitOnDefaultBranch({ repo: input.repo, commitSha: tag.commitSha }));
    if (!onDefaultBranch) return yield* Effect.die(new Error("release tag commit is outside the default branch"));
    const cargoToml = yield* step("read-version", () => github.readTextFile({
      repo: input.repo, path: "Cargo.toml", ref: tag.commitSha,
    }));
    const sourceVersion = cargoToml.found ? cargoToml.content.match(/^version\s*=\s*"([^"]+)"/m)?.[1] : undefined;
    if (sourceVersion !== input.tag.slice(1)) {
      return yield* Effect.die(new Error("release tag version differs from Cargo.toml"));
    }
    const release = dryRun ? { id: 0 } : yield* step("draft-release", () => Effect.gen(function* () {
      const existing = yield* github.releaseByTag({ repo: input.repo, tag: input.tag });
      if (existing !== undefined) {
        if (!existing.draft) return yield* Effect.die(new Error("release is already published"));
        return existing;
      }
      return yield* github.createRelease({ repo: input.repo, tag: input.tag, target: tag.commitSha,
        name: input.tag, body: `Release ${input.tag}`, draft: true });
    }));
    if (!dryRun && release.id <= 0) return yield* Effect.die(new Error("draft release was not created"));
    // Sliding window: the next cell spawns as soon as any running cell
    // settles. Every spawn and every observation is a checkpoint, so a replay
    // walks the same spawns and slot frees. The `-cells-` step names share no
    // checkpoint with the fixed batches' `-release-cells-` steps, so a release
    // in flight across a deploy re-spawns under new names; a child's instance
    // id derives from its input, so the re-spawn finds the same children.
    // A respawn's input carries its `attempt`, so its instance id differs from
    // every earlier attempt's; the first attempt's input is unchanged.
    type Queued = { readonly cell: (typeof CELLS)[number]; readonly attempt: number };
    const queue: Queued[] = SPAWN_ORDER.map((cell) => ({ cell, attempt: 0 }));
    const running: { readonly index: number; readonly id: string; readonly expiresAt: number; readonly attempt: number }[] = [];
    const settledByCell = new Map<number, ChildStatusRecord>();
    const timedOut = new Set<number>();
    const cellFailed = (child: ChildStatusRecord) => child.status !== "success" || !child.summaryJson;
    let spawned = 0;
    for (let round = 0; queue.length > 0 || running.length > 0; round++) {
      const failed = timedOut.size > 0 || [...settledByCell.values()].some(cellFailed);
      const free = RELEASE_WINDOW - running.length;
      // After a failure no further cell starts; the running ones settle or
      // outlive their budget, so the verdict names every failed cell. They
      // write to the same draft release, so the parent never ends before them.
      if (!failed && queue.length > 0 && free > 0) {
        const batch = queue.splice(0, free);
        const { handles, spawnedAt } = yield* step(`spawn-cells-${spawned}`, () => Effect.gen(function* () {
          const handles = yield* fanOut({
            run: contextfulReleaseCell.name,
            items: batch,
            concurrency: batch.length,
            toInput: ({ cell, attempt }) => ({ ...cell, repo: input.repo, tag: input.tag, sha: tag.commitSha,
              releaseId: release.id, dryRun, ...(attempt > 0 ? { attempt } : {}) }),
          });
          return { handles, spawnedAt: yield* io.now };
        }));
        if (spawned === 0) yield* step("handoff-admission", () => handoffChildAdmission());
        batch.forEach(({ cell, attempt }, index) => running.push({
          index: CELLS.indexOf(cell),
          id: handles[index]!.executionId,
          expiresAt: spawnedAt + CELL_BUDGET_MS,
          attempt,
        }));
        spawned += batch.length;
      } else if (failed && running.length === 0) {
        break;
      }
      const expiresAt = Math.min(...running.map((cell) => cell.expiresAt));
      const records = yield* waitForAnyChildDurably({
        name: `await-cells-${round}`,
        ids: running.map((cell) => cell.id),
        expiresAt,
        pollEvery: RELEASE_POLL_EVERY,
      }).pipe(Effect.catchTag("ChildWaitTimeout", () => Effect.succeed(undefined)));
      if (records === undefined) {
        // The cells whose budget ended this wait count as failed; the rest keep running.
        for (let slot = running.length - 1; slot >= 0; slot--) {
          if (running[slot]!.expiresAt > expiresAt) continue;
          timedOut.add(running[slot]!.index);
          running.splice(slot, 1);
        }
        continue;
      }
      for (let slot = running.length - 1; slot >= 0; slot--) {
        const record = records.find((child) => child.executionId === running[slot]!.id);
        if (record === undefined || !isTerminalChildStatus(record.status)) continue;
        const { index, attempt } = running[slot]!;
        running.splice(slot, 1);
        // A cell the platform lost takes the next free slot ahead of the queue.
        if (record.status === "failure" && record.failureTag !== undefined &&
          INFRASTRUCTURE_FAILURES.has(record.failureTag) && attempt < CELL_RETRIES) {
          queue.unshift({ cell: CELLS[index]!, attempt: attempt + 1 });
          continue;
        }
        settledByCell.set(index, record);
      }
    }
    const failedCells = CELLS.filter((_, index) => {
      const child = settledByCell.get(index);
      return child !== undefined && cellFailed(child);
    });
    if (failedCells.length > 0 || timedOut.size > 0) {
      // A typed failure, not a defect: the check-run renders `summaryMd`, so
      // the verdict names every failed, timed-out and unstarted cell there.
      const names = (cells: readonly { readonly profile: string; readonly target: string }[]) =>
        cells.map((cell) => `\`${cell.profile}/${cell.target}\``).join(", ");
      const verdict = [
        ["Failed", failedCells],
        ["Timed out", CELLS.filter((_, index) => timedOut.has(index))],
        ["Not started", queue.map(({ cell }) => cell)],
      ] as const;
      return yield* Effect.fail(new AcceptanceFailed({ exitCode: 1, summaryMd: `**Release cells**\n\n${verdict
        .filter(([, cells]) => cells.length > 0)
        .map(([label, cells]) => `- ${label}: ${names(cells)}`).join("\n")}` }));
    }
    // Matrix order, whatever order the cells settled in.
    const children = CELLS.flatMap((_, index) => settledByCell.get(index) ?? []);
    if (children.length !== CELLS.length || children.some((child) => child.status !== "success" || !child.summaryJson)) {
      return yield* Effect.die(new Error("one or more release cells failed"));
    }
    const manifests = children.map((child) => {
      const output = JSON.parse(child.summaryJson!) as { manifest: string };
      return JSON.parse(output.manifest) as Record<string, unknown>;
    });
    if (!dryRun) {
      const current = yield* step("verify-tag", () => github.tagTarget({ repo: input.repo, tag: input.tag }));
      if (current.refSha !== tag.refSha || current.commitSha !== tag.commitSha) {
        return yield* Effect.die(new Error("release tag moved during build"));
      }
    }
    const formulaHandle = yield* step("spawn-formula", () => fanOut({ run: contextfulReleaseFormula.name,
      items: [JSON.stringify(manifests)],
      toInput: (manifestJson) => ({ repo: input.repo, tag: input.tag, sha: tag.commitSha,
        releaseId: release.id, dryRun, manifests: manifestJson }),
    }));
    const formulaChildren = yield* step("await-formula", () => waitForChildren({
      ids: formulaHandle.map((handle) => handle.executionId), timeout: "8 hours",
    }));
    if (formulaChildren.length !== 1 || formulaChildren[0]?.status !== "success") {
      return yield* Effect.die(new Error("release formula failed"));
    }
    const { assets: formulaAssets, notes } = JSON.parse(formulaChildren[0].summaryJson ?? "{}") as { assets?: string[]; notes?: string };
    if (formulaAssets?.length !== 6) return yield* Effect.die(new Error("release formula output is incomplete"));
    const imageChildren = children.filter((child) => {
      const output = JSON.parse(child.summaryJson ?? "{}") as { target?: string };
      return output.target === "x86_64-unknown-linux-musl";
    });
    if (imageChildren.length !== 3 || imageChildren.some((child) => {
      const output = JSON.parse(child.summaryJson ?? "{}") as { profile?: string; imageLayer?: { archiveName?: string } };
      return output.imageLayer?.archiveName !== `${output.profile}-${input.tag.slice(1)}-linux-amd64.oci.tar`;
    })) return yield* Effect.die(new Error("release needs three Linux amd64 OCI image archives"));
    if (dryRun) return { tag: input.tag, sha: tag.commitSha, dryRun: true, releaseId: 0,
      cells: CELLS.length, assets: CELLS.length * 3 + formulaAssets.length };
    for (const child of imageChildren) {
      const output = JSON.parse(child.summaryJson!) as {
        profile: string; imageLayer?: { name: string; archiveName: string; size: number; digest: string; diffId: string };
      };
      if (output.imageLayer === undefined) return yield* Effect.die(new Error("release image layer is missing"));
      yield* step(`publish-image-${output.profile}`, () => github.publishContainerImage({
        repo: input.repo, profile: output.profile, version: input.tag.slice(1),
        sourceExecutionId: child.executionId,
        layerArtifactName: output.imageLayer!.name, layerSize: output.imageLayer!.size,
        layerDigest: output.imageLayer!.digest, diffId: output.imageLayer!.diffId,
      }));
    }
    const verified = yield* step("verify-tag-for-publish", () => github.tagTarget({ repo: input.repo, tag: input.tag }));
    if (verified.refSha !== tag.refSha || verified.commitSha !== tag.commitSha) {
      return yield* Effect.die(new Error("release tag moved before publish"));
    }
    yield* step("publish-release", () => github.publishRelease({ repo: input.repo, releaseId: release.id,
      ...(notes === undefined ? {} : { body: `Release ${input.tag}\n\n${notes}` }) }));
    return { tag: input.tag, sha: tag.commitSha, dryRun: false, releaseId: release.id,
      cells: CELLS.length, assets: CELLS.length * 3 + formulaAssets.length };
  }),
});
