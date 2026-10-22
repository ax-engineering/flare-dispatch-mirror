// Unit tests for the small primitives shipped from @fractalboxdev/flare-dispatch-core/
// primitives. Each primitive composes capability services; tests assert the
// observable shape (what calls land on the fakes, what shapes are returned)
// rather than re-asserting the capability behavior under test elsewhere.
//
// `loadSecrets` has its own dedicated suite (load-secrets.test.ts); this file
// covers `workspace`, `installCached`, `sharded`, `bootApp`, `probeHttp`.

import { Effect } from "effect";
import { Cache } from "../services/cache";
import { sandbox } from "../services/sandbox";
import { describe, expect, it } from "vitest";
import { bootApp } from "./boot-app";
import { installCached, TOOLS } from "./install-cached";
import { probeHttp } from "./probe-http";
import { sharded } from "./sharded";
import { makeCFRuntimeTest } from "../testing";
import { ensureWorkspace, workspace } from "./workspace";

describe("workspace", () => {
  it("a keyed acquire is a DIFFERENT container; an unkeyed one is always the same", async () => {
    const { layer, handles } = makeCFRuntimeTest();

    const [a, b, c] = await Effect.runPromise(
      Effect.all([
        sandbox.acquire({}),
        sandbox.acquire({}),
        sandbox.acquire({ key: "features" }),
      ]).pipe(Effect.provide(layer)),
    );

    // The property the live layer enforces and this fake used to contradict:
    // unkeyed is the execution's own container, every time. A fake that minted
    // a fresh id per call let a run look isolated here and share one filesystem
    // in production.
    expect(a.id).toBe(b.id);
    expect(c.id).not.toBe(a.id);
    expect(handles.sandbox.acquired.map((x) => x.key)).toEqual([undefined, undefined, "features"]);
  });


  it("rebuilds a keyed workspace in its own container, never the execution's", async () => {
    const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: { "test -d": { stdout: "", exitCode: 1 } } });

    await Effect.runPromise(
      Effect.gen(function* () {
        const current = yield* workspace({ repo: "owner/myrepo", sha: "base", key: "base" });
        return yield* ensureWorkspace({ current, repo: "owner/myrepo", sha: "base", key: "base" });
      }).pipe(Effect.provide(layer)),
    );

    expect(handles.sandbox.acquired.map((x) => x.key)).toEqual(["base", "base"]);
  });

  it("acquires a container, clones the repo, returns { container, dir }", async () => {
    const { layer, handles } = makeCFRuntimeTest();

    const out = await Effect.runPromise(
      workspace({ repo: "owner/myrepo", sha: "abc123" }).pipe(Effect.provide(layer)),
    );

    expect(out.container.id).toBe("fake-container");
    expect(out.dir).toBe("/workspace/myrepo");
    expect(handles.sandbox.acquired).toHaveLength(1);
    expect(handles.sandbox.clones).toEqual([{ repo: "owner/myrepo", sha: "abc123" }]);
  });

  it("threads the optional image to sandbox.acquire", async () => {
    const { layer, handles } = makeCFRuntimeTest();

    await Effect.runPromise(
      workspace({
        repo: "owner/myrepo",
        sha: "abc",
        image: "registry.example/playwright:1",
      }).pipe(Effect.provide(layer)),
    );

    expect(handles.sandbox.acquired[0]!.image).toBe("registry.example/playwright:1");
  });

  it("install: true runs installCached after the clone", async () => {
    // Seed the sandbox so `installCached` detects pnpm and runs install.
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "test -f pnpm-lock.yaml": { exitCode: 0 },
        "sha256sum pnpm-lock.yaml": { exitCode: 0, stdout: "deadbeef\n" },
        "pnpm install --frozen-lockfile": { exitCode: 0 },
      },
    });

    await Effect.runPromise(
      workspace({
        repo: "owner/myrepo",
        sha: "abc",
        install: true,
      }).pipe(Effect.provide(layer)),
    );

    // We expect at minimum: lockfile probe, sha256sum, then install.
    const cmds = handles.sandbox.execs.map((e) => e.command);
    expect(cmds.some((c) => c.includes("test -f pnpm-lock.yaml"))).toBe(true);
    expect(cmds.some((c) => c.includes("sha256sum"))).toBe(true);
    expect(cmds.some((c) => c.includes("pnpm install"))).toBe(true);
  });
});

describe("installCached", () => {
  // PROOF (the cache stores what the install produces, nothing else): a
  // build directory under a dependency key grows monotonically — the key only
  // moves when a dependency does — and is expanded onto the container disk
  // before the run's first command. One consumer's cached `target/` reached
  // 14 GB against an 18 GB disk, so every run started at 100% full and died on
  // the first write with a bare `disk I/O error` naming neither.
  //
  // Asserted against the table rather than a command trace because `paths`
  // never reaches the sandbox: it is handed to `cache.restoreOr` / `cache.save`,
  // so nothing a run executes would reveal a regression here.
  it("caches only directories the tool's own install command populates", () => {
    // Cached from CARGO_HOME, not the checkout. `registry/src` is never
    // cached: the full home holds every source twice, compressed and extracted.
    expect(TOOLS.cargo.base).toBe("/usr/local/cargo");
    expect(TOOLS.cargo.paths).toEqual(["registry/cache", "registry/index"]);
    // The controls: every other tool's paths ARE its install's output, so this
    // test fails on a real regression rather than on the cargo entry alone.
    expect(TOOLS.pnpm.paths).toEqual(["node_modules"]);
    expect(TOOLS.npm.paths).toEqual(["node_modules"]);
    expect(TOOLS.uv.paths).toEqual([".venv"]);
    // One absent path exits tar 2 and disables the tool's whole save.
    for (const [tool, spec] of Object.entries(TOOLS)) {
      expect(spec.paths, `${tool} declares an out-of-checkout path`).not.toContain(".pnpm-store");
    }
    // Nothing anywhere caches a build directory.
    for (const [tool, spec] of Object.entries(TOOLS)) {
      expect(spec.paths, `${tool} caches a build directory`).not.toContain("target");
    }
  });

  it("auto-detects pnpm from the lockfile probe", async () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "test -f pnpm-lock.yaml": { exitCode: 0 },
        "sha256sum pnpm-lock.yaml": { exitCode: 0, stdout: "feedface\n" },
        "pnpm install --frozen-lockfile": { exitCode: 0 },
      },
    });

    await Effect.runPromise(
      installCached({
        container: { id: "c-1" },
        dir: "/workspace/repo",
      }).pipe(Effect.provide(layer)),
    );

    const cmds = handles.sandbox.execs.map((e) => e.command);
    expect(cmds.some((c) => c.includes("pnpm install"))).toBe(true);
  });

  // PROOF (a pnpm hit still relinks the workspace): the archive holds the
  // root `node_modules` only, while pnpm links each workspace member's
  // dependencies into `packages/<x>/node_modules`. A hit that skipped every
  // install left those members unable to import anything.
  it("relinks a pnpm workspace after a cache hit, without the full install", async () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "test -f pnpm-lock.yaml": { exitCode: 0 },
        "sha256sum pnpm-lock.yaml": { exitCode: 0, stdout: "feedface\n" },
        "pnpm install --frozen-lockfile --prefer-offline": { exitCode: 0 },
      },
    });
    const hit = {
      restoreOr: () => Effect.void,
      save: () => Effect.void,
    } as unknown as Cache["Type"];

    await Effect.runPromise(
      installCached({ container: { id: "c-1" }, dir: "/workspace/repo" }).pipe(
        Effect.provideService(Cache, hit),
        Effect.provide(layer),
      ),
    );

    const cmds = handles.sandbox.execs.map((e) => String(e.command));
    expect(cmds).toContain("pnpm install --frozen-lockfile --prefer-offline");
    expect(cmds).not.toContain("pnpm install --frozen-lockfile");
  });

  it("relinks nothing for a tool whose cached paths hold the whole tree", () => {
    expect(TOOLS.pnpm.relink).toBe("pnpm install --frozen-lockfile --prefer-offline");
    expect("relink" in TOOLS.npm).toBe(false);
    expect("relink" in TOOLS.cargo).toBe(false);
    expect("relink" in TOOLS.uv).toBe(false);
  });

  it("no recognized lockfile → no install run", async () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "test -f pnpm-lock.yaml": { exitCode: 1 },
        "test -f package-lock.json": { exitCode: 1 },
        "test -f Cargo.lock": { exitCode: 1 },
        "test -f uv.lock": { exitCode: 1 },
      },
    });

    await Effect.runPromise(
      installCached({
        container: { id: "c-1" },
        dir: "/workspace/repo",
      }).pipe(Effect.provide(layer)),
    );

    const cmds = handles.sandbox.execs.map((e) => e.command);
    expect(cmds.every((c) => !c.includes("install"))).toBe(true);
    expect(cmds.every((c) => !c.includes("cargo fetch"))).toBe(true);
  });

  it('explicit tool: "npm" skips detection and runs npm ci', async () => {
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "sha256sum package-lock.json": { exitCode: 0, stdout: "abc\n" },
        "npm ci": { exitCode: 0 },
      },
    });

    await Effect.runPromise(
      installCached({
        container: { id: "c-1" },
        dir: "/workspace/repo",
        tool: "npm",
      }).pipe(Effect.provide(layer)),
    );

    const cmds = handles.sandbox.execs.map((e) => e.command);
    expect(cmds.some((c) => c.includes("npm ci"))).toBe(true);
    // No probe loop when the tool is named explicitly.
    expect(cmds.some((c) => c.includes("test -f"))).toBe(false);
  });
});

describe("sharded", () => {
  it("runs `count` parallel bodies, each receiving its 1-based shard", async () => {
    const seen: Array<{ index: number; total: number }> = [];
    const result = await Effect.runPromise(
      sharded({
        count: 4,
        body: (shard) =>
          Effect.sync(() => {
            seen.push(shard);
            return shard.index * 10;
          }),
      }),
    );

    expect(result).toEqual([10, 20, 30, 40]);
    expect(seen.map((s) => s.index).sort()).toEqual([1, 2, 3, 4]);
    expect(seen.every((s) => s.total === 4)).toBe(true);
  });

  it("count: 1 → exactly one shard with index 1 and total 1", async () => {
    let captured: { index: number; total: number } | undefined;
    await Effect.runPromise(
      sharded({
        count: 1,
        body: (shard) =>
          Effect.sync(() => {
            captured = shard;
          }),
      }),
    );
    expect(captured).toEqual({ index: 1, total: 1 });
  });

  it("a single shard failure propagates the typed error", async () => {
    const exit = await Effect.runPromiseExit(
      sharded({
        count: 3,
        body: (shard) => (shard.index === 2 ? Effect.fail("boom" as const) : Effect.succeed(0)),
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("bootApp", () => {
  it("runDetached then waitForPort with the default timeout (120s)", async () => {
    const { layer, handles } = makeCFRuntimeTest();

    const handle = await Effect.runPromise(
      bootApp({
        container: { id: "c-1" },
        dir: "/workspace/repo",
        command: ["pnpm", "dev"],
        port: 3000,
      }).pipe(Effect.provide(layer)),
    );

    expect(handle.id).toMatch(/^fake-detached-/);
    const exec = handles.sandbox.execs[0]!;
    expect(exec.command).toBe("pnpm dev");
    expect(exec.cwd).toBe("/workspace/repo");
  });

  it("threads optional env to the detached process", async () => {
    const { layer, handles } = makeCFRuntimeTest();

    await Effect.runPromise(
      bootApp({
        container: { id: "c-1" },
        dir: "/workspace/repo",
        command: "pnpm dev",
        port: 3000,
        env: { NODE_ENV: "test", API_KEY: "secret" },
      }).pipe(Effect.provide(layer)),
    );

    expect(handles.sandbox.execs[0]!.env).toEqual({
      NODE_ENV: "test",
      API_KEY: "secret",
    });
  });
});

describe("probeHttp", () => {
  it("hits every path under the baseURL and counts healthy/failed", async () => {
    // The fake matches command substrings; use full URLs as keys but order
    // longest-first so a non-strict path like "/" doesn't shadow "/broken".
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "https://example.com/broken": { exitCode: 0, stdout: "500" },
        "https://example.com/health": { exitCode: 0, stdout: "200" },
        "https://example.com/": { exitCode: 0, stdout: "200" },
      },
    });

    const result = await Effect.runPromise(
      probeHttp({
        baseURL: "https://example.com",
        paths: ["/", "/health", "/broken"],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.checked).toBe(3);
    expect(result.failed).toBe(1);
    const byPath = Object.fromEntries(result.results.map((r) => [r.path, r]));
    expect(byPath["/"]!.ok).toBe(true);
    expect(byPath["/health"]!.ok).toBe(true);
    expect(byPath["/broken"]!.ok).toBe(false);
    expect(byPath["/broken"]!.status).toBe(500);
  });

  it("a curl connection failure (non-zero exit) counts as failed", async () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        // ExecFailed in fake → modeled as a sandbox exec failure path; here
        // we use a 0-exit-but-non-2xx response shape via empty stdout.
        "https://down.example.com/": { exitCode: 7, stdout: "" },
      },
    });

    const result = await Effect.runPromise(
      probeHttp({
        baseURL: "https://down.example.com",
        paths: ["/"],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.failed).toBe(1);
    expect(result.results[0]!.ok).toBe(false);
  });

  it("custom okStatus broadens or narrows the success window", async () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: {
        "https://example.com/redir": { exitCode: 0, stdout: "302" },
      },
    });

    // Default okStatus accepts 200-399, so 302 is healthy. With a stricter
    // predicate, the same response counts as failed.
    const strict = await Effect.runPromise(
      probeHttp({
        baseURL: "https://example.com",
        paths: ["/redir"],
        okStatus: (c) => c >= 200 && c < 300,
      }).pipe(Effect.provide(layer)),
    );

    expect(strict.failed).toBe(1);
  });
});
