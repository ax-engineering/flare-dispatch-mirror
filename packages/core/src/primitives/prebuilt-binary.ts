// Primitive: prebuilt Cargo binary — build a workspace binary once, run it many times
//
// A fan-out gate whose every child starts with `cargo run -p <tool>` compiles the
// same tool once per child. `prebuildCargoBinary` builds it once, in the parent's
// checkout, and stores the single executable in the R2 cache under a key derived
// from its sources, workspace files and toolchain. A child restores it with
// `restorePrebuilt` and runs it through `prebuiltCommand`, which falls back to the
// original `cargo run` whenever the restored file is absent or does not execute.
//
// The key material is the git object ids of the workspace files Cargo reads
// ({@link KEY_FILES}), of every path package's directory `cargo tree` lists and
// of every file those packages' sources name in a literal `include!`,
// `include_str!` or `include_bytes!`, then the compiler and Cargo versions.
// An include whose
// argument is not a plain string literal, or a path package or include target
// outside the checkout, leaves the binary unkeyed and uncached. Files a build
// script reads outside its package directory are not key material.
//
// The archive holds one executable, outside the checkout, never a `target/`
// directory — the size and eviction reasons are in install-cached.ts.
//
// Both halves degrade, never fail: a binary that cannot be keyed, built, stored or
// restored leaves the caller on its `cargo run` path, which is the behaviour the
// cache replaces. Nothing downstream concludes anything from a miss.
//
// Rides on the `cache`, `sandbox` and `io` capabilities. Layer: 03-dsl § Primitives.

import { Data, Effect } from "effect";
import { cache } from "../services/cache";
import { io } from "../services/io";
import { sandbox, type Container } from "../services/sandbox";
import type { Workspace } from "./workspace";

/** Container directory prebuilt binaries live under — outside every checkout. */
export const PREBUILT_ROOT = "/tmp/flare-dispatch-prebuilt";

/** Schema version of the key material; bump it when the material's shape changes. */
const KEY_VERSION = "v1";

/**
 * Workspace-level files that change what Cargo builds without appearing in any
 * package directory: the lockfile, the root manifest (profiles, `[patch]`), the
 * Cargo config (env, rustflags, wrappers) and a toolchain pin.
 */
export const KEY_FILES = [
  "Cargo.lock",
  "Cargo.toml",
  ".cargo/config.toml",
  ".cargo/config",
  "rust-toolchain.toml",
  "rust-toolchain",
] as const;

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE_PATTERN = /^\/tmp\/[A-Za-z0-9._/-]{1,200}$/;
const REL_DIR_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/;

/** One cache entry restored into a container: `paths` under `base`, keyed by `key`. */
export type CacheEntry = {
  readonly key: string;
  readonly base: string;
  readonly paths: readonly string[];
};

/** A stored binary: its cache entry plus the executable's path once restored. */
export type PrebuiltBinary = CacheEntry & { readonly path: string };

/** A cache key, base and paths a restore may be handed — anything else is refused. */
export const isRestorableEntry = (entry: CacheEntry): boolean =>
  KEY_PATTERN.test(entry.key) &&
  BASE_PATTERN.test(entry.base) &&
  !entry.base.split("/").includes("..") &&
  entry.paths.length > 0 &&
  entry.paths.every((p) => REL_DIR_PATTERN.test(p) && !p.split("/").includes(".."));

/**
 * The checkout-relative directories of every path package `cargo tree` lists, in
 * sorted order. `undefined` when there is none, or when one lies outside the
 * checkout or carries a character the key command does not admit — such a
 * binary cannot be keyed by the checkout's content, so it is not cached.
 */
export const parsePathPackages = (stdout: string, dir: string): readonly string[] | undefined => {
  const root = dir.replace(/\/+$/, "");
  const dirs = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /\((\/[^()]*)\)/.exec(line);
    if (match === null) continue;
    const abs = match[1]!.replace(/\/+$/, "");
    if (abs === root) {
      dirs.add(".");
      continue;
    }
    if (!abs.startsWith(`${root}/`)) return undefined;
    const rel = abs.slice(root.length + 1);
    if (!REL_DIR_PATTERN.test(rel) || rel.split("/").includes("..")) return undefined;
    dirs.add(rel);
  }
  return dirs.size === 0 ? undefined : [...dirs].sort();
};

/** `target` resolved against the directory `from`, or `undefined` when it climbs above the root. */
const resolveRelative = (from: readonly string[], target: string): string | undefined => {
  const out = [...from];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.pop() === undefined) return undefined;
      continue;
    }
    out.push(segment);
  }
  return out.length === 0 ? undefined : out.join("/");
};

const INCLUDE_PATTERN = /include(?:_(?:str|bytes))?!\s*\(\s*/g;

/**
 * The checkout-relative files every `include!`/`include_str!`/`include_bytes!` names, from
 * `git grep HEAD` output, each resolved against its source file's directory as
 * rustc resolves it; sorted, without duplicates. `undefined` when an argument is
 * not a plain string literal, or a target lies outside the checkout or carries a
 * character the key command does not admit.
 */
export const parseIncludeTargets = (stdout: string): readonly string[] | undefined => {
  const targets = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^HEAD:([^:]+):(.*)$/.exec(line);
    if (match === null) continue;
    const file = match[1]!;
    const source = match[2]!;
    if (!REL_DIR_PATTERN.test(file) || file.split("/").includes("..")) return undefined;
    for (const include of source.matchAll(INCLUDE_PATTERN)) {
      const rest = source.slice(include.index + include[0].length);
      const literal = /^"([^"\\]*)"\s*\)/.exec(rest);
      if (literal === null || literal[1]!.startsWith("/")) return undefined;
      const resolved = resolveRelative(file.split("/").slice(0, -1), literal[1]!);
      if (resolved === undefined || !REL_DIR_PATTERN.test(resolved)) return undefined;
      targets.add(resolved);
    }
  }
  return [...targets].sort();
};

/**
 * The shell command that prints every line of the path packages' sources at
 * `HEAD` that names `include!`, `include_str!` or `include_bytes!`. No match exits 0.
 */
export const includeTargetsCommand = (dirs: readonly string[]): string =>
  `git grep -E 'include(_(str|bytes))?!' HEAD -- ${dirs.join(" ")} || [ $? -eq 1 ]`;

/**
 * The shell command that writes the key material and prints its SHA-256: the
 * git object ids of {@link KEY_FILES} and every source path at `HEAD`, then
 * the compiler and Cargo versions. Git object ids are content hashes, so two
 * checkouts with identical sources share a key whatever their commit.
 */
export const keyMaterialCommand = (opts: {
  readonly pkg: string;
  readonly bin: string;
  readonly dirs: readonly string[];
}): string => {
  const material = `${PREBUILT_ROOT}-key.txt`;
  return [
    `{ printf '%s\\n' 'flare-dispatch-prebuilt ${KEY_VERSION} ${opts.pkg} ${opts.bin}'`,
    `git ls-tree HEAD -- ${[...KEY_FILES, ...opts.dirs].join(" ")}`,
    "rustc -vV",
    `cargo -V; } > ${material}`,
    `sha256sum ${material}`,
  ].join(" && ");
};

/** `<bin>-<sha256>` from `sha256sum` output, or `undefined` when it is not one. */
export const prebuiltKey = (bin: string, sha256sumStdout: string): string | undefined => {
  const digest = sha256sumStdout.trim().split(/\s+/)[0] ?? "";
  return /^[a-f0-9]{64}$/.test(digest) ? `${bin}-${digest}` : undefined;
};

/** The cache entry and executable path a binary named `bin` is stored under. */
export const prebuiltEntry = (bin: string, key: string): PrebuiltBinary => ({
  key,
  base: `${PREBUILT_ROOT}/${bin}`,
  paths: ["bin"],
  path: `${PREBUILT_ROOT}/${bin}/bin/${bin}`,
});

/**
 * Run `args` through the prebuilt executable when it is present and runs, and
 * through `fallback` otherwise. `--help` is the probe: a truncated file, a
 * missing loader or a foreign architecture all fail it before the real command
 * starts, so a broken restore costs one probe, never a verdict.
 */
export const prebuiltCommand = (opts: {
  readonly path: string;
  readonly fallback: string;
  readonly args: string;
}): string =>
  `if [ -x ${opts.path} ] && ${opts.path} --help >/dev/null 2>&1; then exec ${opts.path} ${opts.args}; else exec ${opts.fallback} ${opts.args}; fi`;

class PrebuiltUnavailable extends Data.TaggedError("PrebuiltUnavailable")<{
  readonly reason: string;
}> {}

const unavailable = (reason: string) => Effect.fail(new PrebuiltUnavailable({ reason }));

/**
 * Restore the stored binary for `pkg`/`bin`, or build and store it, in the
 * workspace's container. Resolves to the stored binary, or `null` when it cannot
 * be keyed, built or found afterwards — the caller then keeps `cargo run`.
 *
 * Built with the workspace's default dev profile and features, exactly what
 * `cargo run --locked -p <pkg>` builds, so a checkout that already ran the tool
 * links it without recompiling.
 */
export const prebuildCargoBinary = (opts: {
  readonly workspace: Workspace;
  readonly pkg: string;
  readonly bin: string;
}) =>
  Effect.gen(function* () {
    if (!NAME_PATTERN.test(opts.pkg) || !NAME_PATTERN.test(opts.bin))
      return yield* unavailable(`package ${opts.pkg} / binary ${opts.bin} is not a plain name`);
    const { container, dir } = opts.workspace;
    const run = (command: string, timeoutSec: number) =>
      sandbox.exec({ container, cwd: dir, command, timeoutSec });

    const tree = yield* run(
      `cargo tree --locked -p ${opts.pkg} -e normal,build --prefix none --format '{p}' > ${PREBUILT_ROOT}-tree.txt && (grep -F '(/' ${PREBUILT_ROOT}-tree.txt || true)`,
      600,
    );
    const dirs = tree.exitCode === 0 ? parsePathPackages(tree.stdout, dir) : undefined;
    if (dirs === undefined)
      return yield* unavailable(`cargo tree for ${opts.pkg} named no keyable path package`);

    const grep = yield* run(includeTargetsCommand(dirs), 120);
    const includes = grep.exitCode === 0 ? parseIncludeTargets(grep.stdout) : undefined;
    if (includes === undefined)
      return yield* unavailable(
        `an include!/include_str!/include_bytes! target of ${opts.pkg} is not keyable`,
      );

    const paths = [...new Set([...dirs, ...includes])].sort();
    const digest = yield* run(
      keyMaterialCommand({ pkg: opts.pkg, bin: opts.bin, dirs: paths }),
      120,
    );
    const key = digest.exitCode === 0 ? prebuiltKey(opts.bin, digest.stdout) : undefined;
    if (key === undefined) return yield* unavailable("the key material could not be hashed");

    const entry = prebuiltEntry(opts.bin, key);
    const json = `${PREBUILT_ROOT}-build.json`;
    yield* run(`mkdir -p ${entry.base}`, 30);
    yield* cache.restoreOr({
      key: entry.key,
      paths: entry.paths,
      base: entry.base,
      container,
      dir,
      onMiss: () =>
        run(
          [
            `cargo build --locked -q -p ${opts.pkg} --bin ${opts.bin} --message-format=json > ${json}`,
            `exe=$(grep -o '"executable":"[^"]*/${opts.bin}"' ${json} | tail -n 1 | cut -d '"' -f 4)`,
            `test -n "$exe"`,
            `mkdir -p ${entry.base}/bin`,
            `cp "$exe" ${entry.path}`,
          ].join(" && "),
          1800,
        ).pipe(
          Effect.flatMap((built) =>
            built.exitCode === 0
              ? Effect.void
              : unavailable(`cargo build -p ${opts.pkg} exited ${built.exitCode}`),
          ),
        ),
    });
    const present = yield* run(`test -x ${entry.path}`, 30);
    if (present.exitCode !== 0)
      return yield* unavailable(`${entry.path} is absent after the build`);
    return entry;
  }).pipe(
    Effect.catchAll((error) =>
      io
        .log(
          "warn",
          `prebuildCargoBinary: ${opts.bin} stays on cargo run — ${
            error._tag === "PrebuiltUnavailable" ? error.reason : error._tag
          }`,
        )
        .pipe(Effect.as(null as PrebuiltBinary | null)),
    ),
  );

/**
 * Restore one cache entry into a container without populating it on a miss.
 * `true` on a hit; `false` on a miss, a refused entry or any restore failure,
 * each logged. A miss never saves: there is nothing to save.
 */
export const restorePrebuilt = (opts: {
  readonly container: Container;
  readonly dir: string;
  readonly entry: CacheEntry;
}) =>
  Effect.gen(function* () {
    if (!isRestorableEntry(opts.entry))
      return yield* unavailable(
        `cache entry ${opts.entry.key} names a key or path outside the admitted set`,
      );
    yield* sandbox.exec({
      container: opts.container,
      cwd: opts.dir,
      command: ["mkdir", "-p", opts.entry.base],
      timeoutSec: 30,
    });
    // `restoreOr` runs `onMiss` and then saves; a failing `onMiss` skips the save,
    // which is the restore-only behaviour a consumer of someone else's entry wants.
    yield* cache.restoreOr({
      key: opts.entry.key,
      paths: opts.entry.paths,
      base: opts.entry.base,
      container: opts.container,
      dir: opts.dir,
      onMiss: () => unavailable(`no cache entry ${opts.entry.key}`),
    });
    return true;
  }).pipe(
    Effect.catchAll((error) =>
      io
        .log(
          "warn",
          `restorePrebuilt: ${opts.entry.key} not restored — ${
            error._tag === "PrebuiltUnavailable" ? error.reason : error._tag
          }`,
        )
        .pipe(Effect.as(false)),
    ),
  );
