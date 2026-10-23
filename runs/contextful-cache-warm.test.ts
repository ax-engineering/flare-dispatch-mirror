import { it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { compileCacheCommand } from "@fractalboxdev/flare-dispatch-core/primitives";
import { contextfulCacheWarm, WARM_PART } from "./contextful-cache-warm";
import { lightLabelsKey, stageCommand } from "./contextful-gate";

const REPO = "fractalboxdev/contextful";
const SHA = "a".repeat(40);
const BEFORE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const ENDPOINT = "https://dispatch.example/v1/compile-cache";
const TOKEN = "cc1.1700000000.ZXhlYw.mac";
const PUSHED_AT = "2026-10-23T06:00:00Z";
const input = { repo: REPO, sha: SHA, baseSha: BEFORE, revisedAt: Date.parse(PUSHED_AT) } as const;
const prebuilt = {
  key: `contextful-ci-${DIGEST}`,
  base: "/tmp/flare-dispatch-prebuilt/contextful-ci",
  paths: ["bin"],
  path: "/tmp/flare-dispatch-prebuilt/contextful-ci/bin/contextful-ci",
} as const;
const keyed = {
  "cargo tree": {
    stdout: "contextful-ci v0.16.0 (/workspace/contextful/tools/ci)\n",
    exitCode: 0,
  },
  "sha256sum /tmp/flare-dispatch-prebuilt-key.txt": { stdout: `${DIGEST}  /tmp/flare-dispatch-prebuilt-key.txt\n`, exitCode: 0 },
};
const cacheConfig = { "compile-cache.endpoint": ENDPOINT, "compile-cache.token": TOKEN };
const head = { branchHeads: { [`${REPO}:main`]: SHA } };
const push = {
  ref: "refs/heads/main",
  before: BEFORE,
  after: SHA,
  head_commit: { timestamp: PUSHED_AT },
  repository: { full_name: REPO, default_branch: "main" },
};

describe("contextful-cache-warm", () => {
  it("triggers once per default-branch head with no opt-in key", () => {
    const trigger = contextfulCacheWarm.triggers?.[0];
    expect(trigger?.event).toBe("push");
    expect(trigger?.gate?.({ payload: push } as never)).toBe(true);
    expect(trigger?.idempotencyKey({ payload: push } as never)).toBe(`contextful-cache-warm:${SHA}`);
    expect(trigger?.inputs({ payload: push } as never)).toEqual(input);
    for (const other of [
      { ...push, ref: "refs/heads/feature" },
      { ...push, ref: "refs/tags/v1.0.0" },
      { ...push, after: "0".repeat(40) },
      { ...push, repository: { full_name: "other/repo", default_branch: "main" } },
      { ...push, ref: "refs/heads/trunk", repository: { full_name: REPO, default_branch: "trunk" } },
    ]) {
      expect(trigger?.gate?.({ payload: other } as never)).toBe(false);
    }
    expect(contextfulCacheWarm.optIn).toBeUndefined();
  });

  it("writes the default branch's lane, and a newer head supersedes an older warm", () => {
    expect(contextfulCacheWarm.compileCache?.(input)).toBe("base");
    expect(contextfulCacheWarm.supersede?.(input)).toEqual({
      group: `contextful-cache-warm:${REPO}:main`,
      order: Date.parse(PUSHED_AT),
    });
    const { revisedAt: _, ...unranked } = input;
    expect(contextfulCacheWarm.supersede?.(unranked)).toEqual({ group: `contextful-cache-warm:${REPO}:main`, order: 0 });
  });

  it.effect("compiles the gate's compile part exactly as a gate part runs it, in one container", () => {
    const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: keyed, config: cacheConfig, github: head });
    return Effect.gen(function* () {
      expect(yield* contextfulCacheWarm.run(input)).toEqual({ part: WARM_PART, exitCode: 0 });
      expect(WARM_PART).toBe("workspace.compile");
      const command = compileCacheCommand(stageCommand(WARM_PART, BEFORE, prebuilt), REPO);
      const warm = handles.sandbox.execs.filter((exec) => exec.command === command);
      expect(warm).toHaveLength(1);
      expect(warm[0]?.env).toEqual({ SCCACHE_WEBDAV_ENDPOINT: ENDPOINT, SCCACHE_WEBDAV_TOKEN: TOKEN });
      expect(handles.sandbox.execs.filter((exec) => exec.command.includes("cargo build"))).toHaveLength(1);
      expect(handles.sandbox.clones).toEqual([{ repo: REPO, sha: SHA }]);
      expect(handles.childRuns.spawned).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a failed compile without failing: the gate gives the verdict", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: { ...keyed, [`--stage ${WARM_PART}`]: { exitCode: 101 } },
      config: cacheConfig,
      github: head,
    });
    return Effect.gen(function* () {
      expect(yield* contextfulCacheWarm.run(input)).toEqual({ part: WARM_PART, exitCode: 101 });
    }).pipe(Effect.provide(layer));
  });

  const skipsBeforeCheckout = (
    name: string,
    opts: Parameters<typeof makeCFRuntimeTest>[0],
    reason: string,
  ) =>
    it.effect(name, () => {
      const { layer, handles } = makeCFRuntimeTest({ sandboxProgram: keyed, ...opts });
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(contextfulCacheWarm.run(input));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("RunSkipped");
          expect(Cause.pretty(exit.cause)).toContain(reason);
        }
        expect(handles.sandbox.clones).toEqual([]);
        expect(handles.sandbox.execs).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

  skipsBeforeCheckout(
    "skips a head the default branch has moved past",
    { config: cacheConfig, github: { branchHeads: { [`${REPO}:main`]: "d".repeat(40) } } },
    "no longer the head of main",
  );
  skipsBeforeCheckout(
    "skips when the default branch's head cannot be read: only a default-branch head writes base",
    { config: cacheConfig },
    "could not be read",
  );
  skipsBeforeCheckout(
    "skips when the deploy injects no compile-cache access",
    { github: head },
    "compile cache not injected",
  );
  skipsBeforeCheckout(
    "skips when the two-tier gate's heavy tier already compiles the part on this push",
    { config: { ...cacheConfig, [lightLabelsKey(REPO)]: "pins,formal" }, github: head },
    "heavy tier",
  );

  it.effect("warms when the two-tier gate lists the part as light", () => {
    const { layer } = makeCFRuntimeTest({
      sandboxProgram: keyed,
      config: { ...cacheConfig, [lightLabelsKey(REPO)]: `pins,${WARM_PART}` },
      github: head,
    });
    return Effect.gen(function* () {
      expect(yield* contextfulCacheWarm.run(input)).toEqual({ part: WARM_PART, exitCode: 0 });
    }).pipe(Effect.provide(layer));
  });
});
