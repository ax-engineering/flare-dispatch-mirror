// Unit tests for composeRestoreOr — the pure cache `restoreOr` orchestration.
//
// Drives composeRestoreOr with fake `restore` / `save` Effects — no container,
// no R2, no Miniflare. Covers the best-effort contract: a hit skips `onMiss`,
// a miss runs `onMiss` then `save`, `unapplied` runs `onMiss` and skips
// `save`, a restore error degrades to a miss, a `save` failure is swallowed,
// and an `onMiss` failure propagates. Also covers `composeSave`'s
// upload-once check.

import { Effect, Exit, Logger, LogLevel } from "effect";
import { describe, expect, it } from "vitest";
import { CacheError } from "@fractalboxdev/flare-dispatch-core";
import { composeRestoreOr, composeSave } from "./cache-restore-or";

const container = { id: "c1" } as const;
const baseOpts = { key: "k", paths: ["node_modules"], container };

describe("composeRestoreOr", () => {
  it("cache hit — onMiss and save are both skipped", async () => {
    let onMissRan = false;
    let saveRan = false;
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("hit" as const),
      () =>
        Effect.sync(() => {
          saveRan = true;
        }),
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(false);
    expect(saveRan).toBe(false);
  });

  it("cache miss — onMiss runs, then save runs", async () => {
    let onMissRan = false;
    let saveRan = false;
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("miss" as const),
      () =>
        Effect.sync(() => {
          saveRan = true;
        }),
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(true);
    expect(saveRan).toBe(true);
  });

  // ADR-0007: the key is content-addressed, so the stored archive already
  // holds what a second pack and upload would write.
  it("unapplied — onMiss runs, save is skipped", async () => {
    let onMissRan = false;
    let saveRan = false;
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("unapplied" as const),
      () =>
        Effect.sync(() => {
          saveRan = true;
        }),
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(true);
    expect(saveRan).toBe(false);
  });

  it("unapplied — an onMiss failure still propagates", async () => {
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("unapplied" as const),
      () => Effect.void,
    );
    const exit = await Effect.runPromiseExit(
      restoreOr({ ...baseOpts, onMiss: () => Effect.fail("install failed" as const) }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("a restore error is treated as a miss — onMiss runs, then save", async () => {
    let onMissRan = false;
    let saveRan = false;
    const restoreOr = composeRestoreOr(
      () => Effect.fail(new CacheError({ phase: "restore", key: "k", cause: "boom" })),
      () =>
        Effect.sync(() => {
          saveRan = true;
        }),
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        onMiss: () =>
          Effect.sync(() => {
            onMissRan = true;
          }),
      }),
    );
    expect(onMissRan).toBe(true);
    expect(saveRan).toBe(true);
  });

  it("a save failure is swallowed — the run still succeeds", async () => {
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("miss" as const),
      () => Effect.fail(new CacheError({ phase: "save", key: "k", cause: "boom" })),
    );
    const exit = await Effect.runPromiseExit(
      restoreOr({ ...baseOpts, onMiss: () => Effect.succeed(42) }),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("a swallowed save failure is logged, not discarded silently", async () => {
    const lines: string[] = [];
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("miss" as const),
      () => Effect.fail(new CacheError({ phase: "save", key: "k", cause: "tar czf exited 2" })),
    );
    const exit = await Effect.runPromiseExit(
      restoreOr({ ...baseOpts, onMiss: () => Effect.succeed(42) }).pipe(
        Effect.provide(
          Logger.replace(
            Logger.defaultLogger,
            Logger.make(({ message }) => lines.push(String(message))),
          ),
        ),
        Logger.withMinimumLogLevel(LogLevel.Warning),
      ),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(lines.join("\n")).toContain("tar czf exited 2");
    expect(lines.join("\n")).toContain("save");
  });

  it("a swallowed restore failure is logged too", async () => {
    const lines: string[] = [];
    const restoreOr = composeRestoreOr(
      () => Effect.fail(new CacheError({ phase: "restore", key: "k", cause: "r2 unreachable" })),
      () => Effect.void,
    );
    await Effect.runPromiseExit(
      restoreOr({ ...baseOpts, onMiss: () => Effect.succeed(1) }).pipe(
        Effect.provide(
          Logger.replace(
            Logger.defaultLogger,
            Logger.make(({ message }) => lines.push(String(message))),
          ),
        ),
        Logger.withMinimumLogLevel(LogLevel.Warning),
      ),
    );

    expect(lines.join("\n")).toContain("r2 unreachable");
  });

  // `base` is what makes a home outside the checkout cacheable at all — the
  // tar runs there instead of in the repo, so an absolute path is expressible.
  it("base reaches both restore and save", async () => {
    const seen: (string | undefined)[] = [];
    const restoreOr = composeRestoreOr(
      (o) => {
        seen.push(o.base);
        return Effect.succeed("miss" as const);
      },
      (o) => {
        seen.push(o.base);
        return Effect.void;
      },
    );
    await Effect.runPromise(
      restoreOr({
        ...baseOpts,
        base: "/usr/local/cargo",
        dir: "/workspace/repo",
        onMiss: () => Effect.succeed(1),
      }),
    );
    expect(seen).toEqual(["/usr/local/cargo", "/usr/local/cargo"]);
  });

  it("an onMiss failure propagates", async () => {
    const restoreOr = composeRestoreOr(
      () => Effect.succeed("miss" as const),
      () => Effect.void,
    );
    const exit = await Effect.runPromiseExit(
      restoreOr({
        ...baseOpts,
        onMiss: () => Effect.fail("install failed" as const),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("composeSave", () => {
  const packer = () => {
    const packed: string[] = [];
    return {
      packed,
      pack: (o: { key: string }) =>
        Effect.sync(() => {
          packed.push(o.key);
        }),
    };
  };

  it("a stored key skips the pack and the upload", async () => {
    const { packed, pack } = packer();
    await Effect.runPromise(composeSave(() => Effect.succeed(true), pack)(baseOpts));
    expect(packed).toEqual([]);
  });

  it("an absent key packs and uploads", async () => {
    const { packed, pack } = packer();
    await Effect.runPromise(composeSave(() => Effect.succeed(false), pack)(baseOpts));
    expect(packed).toEqual(["k"]);
  });

  it("a failed existence check packs as before, and is logged", async () => {
    const lines: string[] = [];
    const { packed, pack } = packer();
    await Effect.runPromise(
      composeSave(
        () => Effect.fail(new CacheError({ phase: "save", key: "k", cause: "head unreachable" })),
        pack,
      )(baseOpts).pipe(
        Effect.provide(
          Logger.replace(
            Logger.defaultLogger,
            Logger.make(({ message }) => lines.push(String(message))),
          ),
        ),
        Logger.withMinimumLogLevel(LogLevel.Warning),
      ),
    );
    expect(packed).toEqual(["k"]);
    expect(lines.join("\n")).toContain("head unreachable");
  });

  it("a pack failure propagates to restoreOr's swallow", async () => {
    const exit = await Effect.runPromiseExit(
      composeSave(
        () => Effect.succeed(false),
        () => Effect.fail(new CacheError({ phase: "save", key: "k", cause: "tar" })),
      )(baseOpts),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
