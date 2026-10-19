// IOLive integration tests — the live `io` capability against D1.
//
// `io.now / uuid / env / sleep / log` are pure platform shims and covered
// indirectly by other tests; this file pins the one D1-bound behaviour:
// `io.priorExecution` reads the most recent terminal execution in the
// semantic family, excludes the current execution, decodes summary_json
// against the run's outputSchema, and degrades to `Option.none()` on any
// schema mismatch or missing summary.

import { Effect, Option, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executions, IO } from "@fractalboxdev/flare-dispatch-core";
import { makeD1ExecutionsLive } from "./executions-d1";
import { makeIOLive } from "./io-live";
import { makeTestBindings, type TestBindings } from "./test-support";

const FAMILY = "pr-review:owner/name:42";
const PRIOR_ID = `${FAMILY}:prior-sha-aaaa`;
const CURRENT_ID = `${FAMILY}:current-sha-bbbb`;

const ReviewOutput = Schema.Struct({
  approved: Schema.Boolean,
  findings: Schema.Number,
});

const seedExecution = async (
  db: D1Database,
  opts: {
    id: string;
    sha: string;
    summaryJson?: string;
    status?: "success" | "failure" | "running";
    completedAt?: number;
  },
): Promise<void> => {
  const status = opts.status ?? "success";
  await db
    .prepare(
      `INSERT INTO executions
         (id, run, repo, ref, sha, status, started_at, completed_at,
          input_json, summary_json)
       VALUES (?, 'pr-review', 'owner/name', 'refs/heads/main', ?, ?, 1, ?, '{}', ?)`,
    )
    .bind(opts.id, opts.sha, status, opts.completedAt ?? 100, opts.summaryJson ?? null)
    .run();
};

describe("IOLive.priorExecution", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("returns the most recent terminal execution in the family, decoded", async () => {
    await seedExecution(bindings.db, {
      id: PRIOR_ID,
      sha: "prior-sha-aaaa",
      summaryJson: JSON.stringify({ approved: true, findings: 3 }),
      completedAt: 1000,
    });

    const layer = makeIOLive({
      db: bindings.db,
      currentExecutionId: CURRENT_ID,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.executionId).toBe(PRIOR_ID);
      expect(result.value.sha).toBe("prior-sha-aaaa");
      expect(result.value.output).toEqual({ approved: true, findings: 3 });
      expect(result.value.finishedAt).toBe(1000);
    }
  });

  it("excludes the current execution from prior lookups", async () => {
    // The current execution is itself terminal and in the family — it must
    // not be returned as its own prior.
    await seedExecution(bindings.db, {
      id: CURRENT_ID,
      sha: "current-sha-bbbb",
      summaryJson: JSON.stringify({ approved: false, findings: 0 }),
      completedAt: 2000,
    });

    const layer = makeIOLive({
      db: bindings.db,
      currentExecutionId: CURRENT_ID,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it("returns the most recent when several priors exist", async () => {
    await seedExecution(bindings.db, {
      id: `${FAMILY}:old-sha`,
      sha: "old-sha",
      summaryJson: JSON.stringify({ approved: true, findings: 1 }),
      completedAt: 100,
    });
    await seedExecution(bindings.db, {
      id: `${FAMILY}:new-sha`,
      sha: "new-sha",
      summaryJson: JSON.stringify({ approved: false, findings: 5 }),
      completedAt: 500,
    });

    const layer = makeIOLive({
      db: bindings.db,
      currentExecutionId: CURRENT_ID,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.executionId).toBe(`${FAMILY}:new-sha`);
      expect(result.value.output.findings).toBe(5);
    }
  });

  it("schema mismatch → Option.none() rather than failure", async () => {
    await seedExecution(bindings.db, {
      id: PRIOR_ID,
      sha: "prior-sha-aaaa",
      // Older run shape — missing `findings`.
      summaryJson: JSON.stringify({ approved: true }),
    });

    const layer = makeIOLive({
      db: bindings.db,
      currentExecutionId: CURRENT_ID,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it("a different family's executions are not returned", async () => {
    await seedExecution(bindings.db, {
      id: "pr-review:other/repo:99:some-sha",
      sha: "some-sha",
      summaryJson: JSON.stringify({ approved: true, findings: 0 }),
    });

    const layer = makeIOLive({
      db: bindings.db,
      currentExecutionId: CURRENT_ID,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(Option.isNone(result)).toBe(true);
  });

  it("without D1 binding → degrades to Option.none()", async () => {
    const layer = makeIOLive(); // no db
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(Option.isNone(result)).toBe(true);
  });

  it("finishExecution with summaryJson persists, round-trips via priorExecution", async () => {
    const exLayer = makeD1ExecutionsLive(bindings.db, {
      repo: "owner/name",
      ref: "refs/heads/main",
      sha: "prior-sha-aaaa",
      input: { pr: 42 },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const ex = yield* Executions;
        yield* ex.startExecution({ id: PRIOR_ID, run: "pr-review", startedAt: 1 });
        yield* ex.finishExecution({
          id: PRIOR_ID,
          completedAt: 1500,
          status: "success",
          summaryJson: JSON.stringify({ approved: true, findings: 2 }),
        });
      }).pipe(Effect.provide(exLayer)),
    );

    const ioLayer = makeIOLive({
      db: bindings.db,
      currentExecutionId: CURRENT_ID,
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.priorExecution({
          family: FAMILY,
          outputSchema: ReviewOutput,
        });
      }).pipe(Effect.provide(ioLayer)),
    );

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.executionId).toBe(PRIOR_ID);
      expect(result.value.output).toEqual({ approved: true, findings: 2 });
    }
  });
});

describe("IOLive.viewerUrl", () => {
  const readViewerUrl = (layer: ReturnType<typeof makeIOLive>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.viewerUrl;
      }).pipe(Effect.provide(layer)),
    );

  it("returns Some when the dispatcher threads a logsViewerBase", async () => {
    const url = "https://fd.example/logs/exec-1?t=tok";
    const result = await readViewerUrl(makeIOLive({ logsViewerBase: url }));
    expect(result).toEqual(Option.some(url));
  });

  it("returns the dispatcher-threaded currentExecutionId via io.executionId", async () => {
    const id = "release-notes:owner/repo:2026-W26";
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const io = yield* IO;
        return yield* io.executionId;
      }).pipe(Effect.provide(makeIOLive({ currentExecutionId: id }))),
    );
    expect(result).toBe(id);
  });

  it("returns None when no logsViewerBase is configured", async () => {
    const result = await readViewerUrl(makeIOLive());
    expect(Option.isNone(result)).toBe(true);
  });
});

describe("IOLive io.env", () => {
  it("answers the dispatcher's per-execution vars and nothing else", async () => {
    const read = (key: string) =>
      Effect.runPromise(
        Effect.flatMap(IO, (io) => io.env(key)).pipe(
          Effect.provide(makeIOLive({ vars: { FLARE_DISPATCH_DEPLOYED_VERSION: "v-1" } })),
        ),
      );
    expect(await read("FLARE_DISPATCH_DEPLOYED_VERSION")).toBe("v-1");
    expect(await read("HOME")).toBeUndefined();
  });
});

