import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Cache, type CacheService } from "../services/cache";
import { makeCFRuntimeTest } from "../testing";
import {
  KEY_FILES,
  isRestorableEntry,
  includeTargetsCommand,
  keyMaterialCommand,
  parseIncludeTargets,
  parsePathPackages,
  prebuildCargoBinary,
  prebuiltCommand,
  prebuiltEntry,
  prebuiltKey,
  restorePrebuilt,
} from "./prebuilt-binary";

const DIR = "/workspace/contextful";
const DIGEST = "c".repeat(64);
const TREE = [
  "contextful-ci v0.16.0 (/workspace/contextful/tools/ci)",
  "contextful-eval v0.16.0 (/workspace/contextful/tools/eval)",
  "contextful-core v0.16.0 (/workspace/contextful/crates/contextful-core)",
  "contextful-core v0.16.0 (/workspace/contextful/crates/contextful-core) (*)",
].join("\n");
const KEY_SUM = "sha256sum /tmp/flare-dispatch-prebuilt-key.txt";
const MANIFEST = "crates/acceptance/src/conformance/manifest.json";
const INCLUDES = `HEAD:tools/ci/src/release.rs:    let registry = from_str(include_str!("../../../${MANIFEST}"))?;\n`;
const INCLUDED_SOURCE = "shared/generated.rs";
const SOURCE_INCLUDE = `HEAD:tools/ci/src/main.rs:include!("../../../${INCLUDED_SOURCE}");\n`;

/** A cache that answers every restore with `hit` and records what reached it. */
const recordingCache = (hit: boolean) => {
  const calls: { key: string; base?: string; paths: readonly string[] }[] = [];
  const saves: string[] = [];
  const service: CacheService = {
    restoreOr: (opts) =>
      Effect.suspend(() => {
        calls.push({ key: opts.key, base: opts.base, paths: opts.paths });
        return hit
          ? Effect.void
          : Effect.asVoid(opts.onMiss()).pipe(
              Effect.tap(() => Effect.sync(() => saves.push(opts.key))),
            );
      }),
    save: () => Effect.void,
  };
  return { service, calls, saves };
};

describe("prebuilt binary key", () => {
  it("keys the binary by every path package's checkout-relative directory", () => {
    expect(parsePathPackages(TREE, DIR)).toEqual([
      "crates/contextful-core",
      "tools/ci",
      "tools/eval",
    ]);
    expect(parsePathPackages(`${TREE}\nserde v1.0.200\n`, `${DIR}/`)).toEqual([
      "crates/contextful-core",
      "tools/ci",
      "tools/eval",
    ]);
    expect(parsePathPackages("root v0.1.0 (/workspace/contextful)", DIR)).toEqual(["."]);
  });

  it("refuses a binary it cannot key by the checkout's content", () => {
    expect(parsePathPackages("", DIR)).toBeUndefined();
    expect(parsePathPackages("serde v1.0.200\n", DIR)).toBeUndefined();
    expect(parsePathPackages(`${TREE}\nvendored v0.1.0 (/opt/vendored)`, DIR)).toBeUndefined();
    expect(parsePathPackages("x v0.1.0 (/workspace/contextful-other/x)", DIR)).toBeUndefined();
    expect(parsePathPackages("x v0.1.0 (/workspace/contextful/a b)", DIR)).toBeUndefined();
    expect(parsePathPackages("x v0.1.0 (/workspace/contextful/a/../b)", DIR)).toBeUndefined();
  });

  it("keys every literal include target, resolved from its source file", () => {
    expect(parseIncludeTargets(INCLUDES)).toEqual([MANIFEST]);
    expect(
      parseIncludeTargets(
        [
          'HEAD:tools/ci/src/a.rs:#[doc = include_str!("../README.md")]',
          'HEAD:tools/ci/src/b.rs:const X: &[u8] = include_bytes!( "./data/x.bin" ); include_str!("../README.md")',
          SOURCE_INCLUDE.trimEnd(),
          "HEAD:tools/ci/src/c.rs:no include here",
        ].join("\n"),
      ),
    ).toEqual([INCLUDED_SOURCE, "tools/ci/README.md", "tools/ci/src/data/x.bin"]);
    expect(parseIncludeTargets("")).toEqual([]);
  });

  it("refuses a binary whose include target it cannot key by the checkout's content", () => {
    expect(
      parseIncludeTargets('HEAD:tools/ci/src/a.rs:include_str!("../../../../outside")'),
    ).toBeUndefined();
    expect(
      parseIncludeTargets('HEAD:tools/ci/src/a.rs:include_str!("/etc/hosts")'),
    ).toBeUndefined();
    expect(
      parseIncludeTargets('HEAD:tools/ci/src/a.rs:include_str!(concat!(env!("OUT_DIR"), "/x"))'),
    ).toBeUndefined();
    expect(parseIncludeTargets('HEAD:tools/ci/src/a.rs:include_str!("a b")')).toBeUndefined();
    expect(
      parseIncludeTargets('HEAD:tools/ci/src/a.rs:include!(concat!("../", "b.rs"))'),
    ).toBeUndefined();
    expect(
      parseIncludeTargets('HEAD:tools/ci/src/a.rs:include!("../../../../outside.rs")'),
    ).toBeUndefined();
  });

  it("searches only the path packages' sources at HEAD", () => {
    const command = includeTargetsCommand(["tools/ci", "tools/eval"]);
    expect(command).toContain("git grep");
    expect(command).toContain("include(_(str|bytes))?!");
    expect(command).toContain("HEAD -- tools/ci tools/eval");
    expect(command).not.toContain("cargo tree");
  });

  it("hashes the workspace files, the source trees and the toolchain", () => {
    const command = keyMaterialCommand({
      pkg: "contextful-ci",
      bin: "contextful-ci",
      dirs: ["tools/ci", "tools/eval"],
    });
    expect(command).toContain(`git ls-tree HEAD -- ${KEY_FILES.join(" ")} tools/ci tools/eval`);
    expect(command).toContain("rustc -vV");
    expect(command).toContain("cargo -V");
    expect(command).toContain("flare-dispatch-prebuilt v1 contextful-ci contextful-ci");
    expect(command.endsWith(KEY_SUM)).toBe(true);
  });

  it("derives one key per digest and none from anything else", () => {
    expect(prebuiltKey("contextful-ci", `${DIGEST}  /tmp/flare-dispatch-prebuilt-key.txt\n`)).toBe(
      `contextful-ci-${DIGEST}`,
    );
    expect(prebuiltKey("contextful-ci", `${"d".repeat(64)}  x`)).not.toBe(
      prebuiltKey("contextful-ci", `${DIGEST}  x`),
    );
    expect(prebuiltKey("contextful-ci", "")).toBeUndefined();
    expect(prebuiltKey("contextful-ci", "sha256sum: missing: No such file")).toBeUndefined();
    expect(prebuiltKey("contextful-ci", `${DIGEST.toUpperCase()}  x`)).toBeUndefined();
  });

  it("admits only plain keys and bases under /tmp", () => {
    const entry = prebuiltEntry("contextful-ci", `contextful-ci-${DIGEST}`);
    expect(entry.path).toBe("/tmp/flare-dispatch-prebuilt/contextful-ci/bin/contextful-ci");
    expect(isRestorableEntry(entry)).toBe(true);
    expect(isRestorableEntry({ ...entry, key: "../other/repo" })).toBe(false);
    expect(isRestorableEntry({ ...entry, base: "/usr/local/cargo" })).toBe(false);
    expect(isRestorableEntry({ ...entry, base: "/tmp/../etc" })).toBe(false);
    expect(isRestorableEntry({ ...entry, paths: [] })).toBe(false);
    expect(isRestorableEntry({ ...entry, paths: ["../bin"] })).toBe(false);
  });
});

// Each case spawns a freshly written executable, whose first run macOS can hold
// for several seconds while it assesses the file.
describe("prebuiltCommand", { timeout: 30_000 }, () => {
  const run = (command: string) => execFileSync("sh", ["-c", command], { encoding: "utf8" }).trim();
  const scratch = () => mkdtempSync(join(tmpdir(), "prebuilt-"));
  const tool = (dir: string, body: string) => {
    const path = join(dir, "tool");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it("runs the restored binary when it executes", () => {
    const path = tool(scratch(), 'echo "binary $*"');
    expect(
      run(prebuiltCommand({ path, fallback: "echo fallback", args: "gate --stage pins" })),
    ).toBe("binary gate --stage pins");
  });

  it("falls back to cargo run when the binary is absent", () => {
    const path = join(scratch(), "missing");
    expect(
      run(prebuiltCommand({ path, fallback: "echo fallback", args: "gate --stage pins" })),
    ).toBe("fallback gate --stage pins");
  });

  it("falls back when the restored file does not run", () => {
    const path = tool(scratch(), 'if [ "$1" = --help ]; then exit 1; fi; echo binary');
    expect(run(prebuiltCommand({ path, fallback: "echo fallback", args: "gate" }))).toBe(
      "fallback gate",
    );
  });
});

describe("prebuildCargoBinary", () => {
  const program = (build: { exitCode: number }) => ({
    "cargo tree": { stdout: TREE, exitCode: 0 },
    "git grep": { stdout: INCLUDES, exitCode: 0 },
    [KEY_SUM]: { stdout: `${DIGEST}  /tmp/flare-dispatch-prebuilt-key.txt\n`, exitCode: 0 },
    "cargo build": build,
  });
  const prebuild = (opts: {
    hit: boolean;
    build?: { exitCode: number };
    tree?: { stdout: string; exitCode: number };
    includes?: { stdout: string; exitCode: number };
  }) => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        ...program(opts.build ?? { exitCode: 0 }),
        ...(opts.tree !== undefined ? { "cargo tree": opts.tree } : {}),
        ...(opts.includes !== undefined ? { "git grep": opts.includes } : {}),
      },
    });
    const cache = recordingCache(opts.hit);
    const run = prebuildCargoBinary({
      workspace: { container: { id: "fake-container" }, dir: DIR },
      pkg: "contextful-ci",
      bin: "contextful-ci",
    }).pipe(Effect.provideService(Cache, cache.service), Effect.provide(layer));
    return { run, handles, cache };
  };

  it("reuses a stored binary without building", async () => {
    const { run, handles, cache } = prebuild({ hit: true });
    expect(await Effect.runPromise(run)).toEqual(
      prebuiltEntry("contextful-ci", `contextful-ci-${DIGEST}`),
    );
    expect(cache.calls).toEqual([
      {
        key: `contextful-ci-${DIGEST}`,
        base: "/tmp/flare-dispatch-prebuilt/contextful-ci",
        paths: ["bin"],
      },
    ]);
    expect(handles.sandbox.execs.some((exec) => exec.command.includes("cargo build"))).toBe(false);
  });

  it("keys the binary by the files its sources include", async () => {
    const { run, handles } = prebuild({
      hit: true,
      includes: { stdout: INCLUDES + SOURCE_INCLUDE, exitCode: 0 },
    });
    await Effect.runPromise(run);
    const key = handles.sandbox.execs.find((exec) => exec.command.includes(KEY_SUM));
    expect(key?.command).toContain(
      `${MANIFEST} crates/contextful-core ${INCLUDED_SOURCE} tools/ci tools/eval`,
    );
  });

  it("answers null without touching the cache when an include target cannot be keyed", async () => {
    for (const includes of [
      {
        stdout: 'HEAD:tools/ci/src/a.rs:include_str!(concat!(env!("OUT_DIR"), "/x"))',
        exitCode: 0,
      },
      { stdout: 'HEAD:tools/ci/src/a.rs:include!(concat!("../", "b.rs"))', exitCode: 0 },
      { stdout: "", exitCode: 2 },
    ]) {
      const { run, cache } = prebuild({ hit: true, includes });
      expect(await Effect.runPromise(run)).toBeNull();
      expect(cache.calls).toEqual([]);
    }
  });

  it("builds and stores the binary on a miss", async () => {
    const { run, handles, cache } = prebuild({ hit: false });
    expect(await Effect.runPromise(run)).toEqual(
      prebuiltEntry("contextful-ci", `contextful-ci-${DIGEST}`),
    );
    const build = handles.sandbox.execs.find((exec) => exec.command.includes("cargo build"));
    expect(build?.command).toContain(
      "cargo build --locked -q -p contextful-ci --bin contextful-ci",
    );
    expect(build?.command).toContain(
      'cp "$exe" /tmp/flare-dispatch-prebuilt/contextful-ci/bin/contextful-ci',
    );
    expect(cache.saves).toEqual([`contextful-ci-${DIGEST}`]);
  });

  it("stores nothing and answers null when the build fails", async () => {
    const { run, cache } = prebuild({ hit: false, build: { exitCode: 101 } });
    expect(await Effect.runPromise(run)).toBeNull();
    expect(cache.saves).toEqual([]);
  });

  it("answers null without touching the cache when the binary cannot be keyed", async () => {
    for (const tree of [
      { stdout: "", exitCode: 0 },
      { stdout: TREE, exitCode: 101 },
    ]) {
      const { run, cache } = prebuild({ hit: true, tree });
      expect(await Effect.runPromise(run)).toBeNull();
      expect(cache.calls).toEqual([]);
    }
  });
});

describe("restorePrebuilt", () => {
  const entry = {
    key: `contextful-ci-${DIGEST}`,
    base: "/tmp/flare-dispatch-prebuilt/contextful-ci",
    paths: ["bin"],
  };
  const restore = (hit: boolean, target = entry) => {
    const { layer, handles } = makeCFRuntimeTest();
    const cache = recordingCache(hit);
    const run = restorePrebuilt({
      container: { id: "fake-container" },
      dir: DIR,
      entry: target,
    }).pipe(Effect.provideService(Cache, cache.service), Effect.provide(layer));
    return { run, handles, cache };
  };

  it("restores a stored entry", async () => {
    const { run, handles } = restore(true);
    expect(await Effect.runPromise(run)).toBe(true);
    expect(handles.sandbox.execs.map((exec) => exec.command)).toEqual([
      "mkdir -p /tmp/flare-dispatch-prebuilt/contextful-ci",
    ]);
  });

  it("answers false and saves nothing on a miss", async () => {
    const { run, cache } = restore(false);
    expect(await Effect.runPromise(run)).toBe(false);
    expect(cache.calls).toHaveLength(1);
    expect(cache.saves).toEqual([]);
  });

  it("refuses an entry outside the admitted set before reaching the cache", async () => {
    const { run, cache, handles } = restore(true, { ...entry, base: "/usr/local/cargo" });
    expect(await Effect.runPromise(run)).toBe(false);
    expect(cache.calls).toEqual([]);
    expect(handles.sandbox.execs).toEqual([]);
  });
});
