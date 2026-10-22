// Unit coverage for the live `makeCacheR2Live` closures: the transport gate on
// restore, the `unapplied` outcome, and the save's upload-once check.
//
// `@cloudflare/sandbox` is `vi.mock`ed to an in-memory fake box, and the R2
// bucket is a plain fake, so these run in the Node pool with no container and
// no Miniflare.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Upload each cache key once.

import { Effect, Logger, LogLevel } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Cache } from "@fractalboxdev/flare-dispatch-core";

type FakeBox = {
  execs: string[];
  writes: number;
  writeFile: (path: string, body: unknown) => Promise<void>;
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readFileStream: () => Promise<ReadableStream<Uint8Array>>;
};

let box: FakeBox;

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => box,
}));

const { makeCacheR2Live } = await import("./cache-r2");

const makeBox = (writeFile?: () => Promise<void>, untarExit = 0): FakeBox => {
  const b: FakeBox = {
    execs: [],
    writes: 0,
    writeFile: async () => {
      b.writes += 1;
      if (writeFile !== undefined) await writeFile();
    },
    exec: async (command) => {
      b.execs.push(command);
      if (command.startsWith("tar xzf") && untarExit !== 0)
        return { exitCode: untarExit, stdout: "", stderr: "gzip: stdin: unexpected end of file" };
      return { exitCode: 0, stdout: command.startsWith("stat") ? "3\n" : "", stderr: "" };
    },
    readFileStream: async () =>
      new ReadableStream({
        start: (c) => {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      }),
  };
  return b;
};

/** A fake bucket holding `stored` keys; records which calls touched it. */
const makeBucket = (stored: readonly string[]) => {
  const keys = new Set(stored);
  const calls: string[] = [];
  let cancelled = false;
  const bucket = {
    head: async (key: string) => {
      calls.push(`head ${key}`);
      return keys.has(key) ? { key } : null;
    },
    get: async (key: string) => {
      calls.push(`get ${key}`);
      if (!keys.has(key)) return null;
      return {
        body: new ReadableStream({
          cancel: () => {
            cancelled = true;
          },
        }),
      };
    },
    put: async (key: string) => {
      calls.push(`put ${key}`);
      keys.add(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, calls, wasCancelled: () => cancelled };
};

const ns = {} as DurableObjectNamespace<never>;
const KEY = "cache/o/r/pnpm-abc.tar.gz";
const container = { id: "c1" } as const;

const run = (
  layer: ReturnType<typeof makeCacheR2Live>,
  times = 1,
): Promise<{ onMiss: number; lines: string[] }> => {
  const lines: string[] = [];
  let onMiss = 0;
  const once = Effect.flatMap(Cache, (c) =>
    c.restoreOr({
      key: "pnpm-abc",
      paths: ["node_modules"],
      container,
      dir: "/workspace/r",
      onMiss: () =>
        Effect.sync(() => {
          onMiss += 1;
        }),
    }),
  );
  return Effect.runPromise(
    Effect.repeatN(once, times - 1).pipe(
      Effect.provide(layer),
      Effect.provide(
        Logger.replace(
          Logger.defaultLogger,
          Logger.make(({ message }) => lines.push(String(message))),
        ),
      ),
      Logger.withMinimumLogLevel(LogLevel.Info),
    ),
  ).then(() => ({ onMiss, lines }));
};

beforeEach(() => {
  box = makeBox();
});

describe("makeCacheR2Live restore", () => {
  it("http transport + stored archive — unapplied without reading the body, no re-upload", async () => {
    const { bucket, calls } = makeBucket([KEY]);
    const { onMiss } = await run(makeCacheR2Live(bucket, ns, "o/r", "http"));
    expect(onMiss).toBe(1);
    expect(calls).toEqual([`head ${KEY}`]);
    expect(box.writes).toBe(0);
    expect(box.execs.some((c) => c.startsWith("tar czf"))).toBe(false);
  });

  it("http transport — logs the transport once per execution", async () => {
    const { bucket } = makeBucket([KEY]);
    const { onMiss, lines } = await run(makeCacheR2Live(bucket, ns, "o/r", "http"), 3);
    expect(onMiss).toBe(3);
    expect(lines.filter((l) => l.includes("http sandbox transport"))).toHaveLength(1);
  });

  it("http transport + no archive — miss: onMiss, pack, upload", async () => {
    const { bucket, calls } = makeBucket([]);
    const { onMiss } = await run(makeCacheR2Live(bucket, ns, "o/r", "http"));
    expect(onMiss).toBe(1);
    expect(calls).toEqual([`head ${KEY}`, `head ${KEY}`, `put ${KEY}`]);
    expect(box.execs.some((c) => c.startsWith("tar czf"))).toBe(true);
  });

  it("rpc transport + stored archive — hit: streamed in and extracted", async () => {
    const { bucket, calls } = makeBucket([KEY]);
    const { onMiss } = await run(makeCacheR2Live(bucket, ns, "o/r", "rpc"));
    expect(onMiss).toBe(0);
    expect(calls).toEqual([`get ${KEY}`]);
    expect(box.writes).toBe(1);
    expect(box.execs.some((c) => c.startsWith("tar xzf"))).toBe(true);
  });

  it("websocket transport + stored archive — unapplied from the head alone", async () => {
    const { bucket, calls } = makeBucket([KEY]);
    const { onMiss, lines } = await run(makeCacheR2Live(bucket, ns, "o/r", "websocket"));
    expect(onMiss).toBe(1);
    expect(calls).toEqual([`head ${KEY}`]);
    expect(box.writes).toBe(0);
    expect(lines.some((l) => l.includes("websocket sandbox transport"))).toBe(true);
  });

  it("rpc transport + no archive — miss: onMiss, pack, upload", async () => {
    const { bucket, calls } = makeBucket([]);
    const { onMiss } = await run(makeCacheR2Live(bucket, ns, "o/r", "rpc"));
    expect(onMiss).toBe(1);
    expect(calls).toEqual([`get ${KEY}`, `head ${KEY}`, `put ${KEY}`]);
    expect(box.writes).toBe(0);
    expect(box.execs.some((c) => c.startsWith("tar czf"))).toBe(true);
  });

  it("rpc transport + a failing tar xzf — unapplied: onMiss runs, no save", async () => {
    box = makeBox(undefined, 2);
    const { bucket, calls } = makeBucket([KEY]);
    const { onMiss, lines } = await run(makeCacheR2Live(bucket, ns, "o/r", "rpc"));
    expect(onMiss).toBe(1);
    expect(calls).toEqual([`get ${KEY}`]);
    expect(box.execs.some((c) => c.startsWith("tar czf"))).toBe(false);
    expect(lines.join("\n")).toContain("tar xzf exited 2");
  });

  it("rpc transport + a failing apply — unapplied: onMiss runs, body cancelled, no save", async () => {
    box = makeBox(() => Promise.reject(new Error("writeFileStream requires the rpc transport")));
    const { bucket, calls, wasCancelled } = makeBucket([KEY]);
    const { onMiss, lines } = await run(makeCacheR2Live(bucket, ns, "o/r", "rpc"));
    expect(onMiss).toBe(1);
    expect(calls).toEqual([`get ${KEY}`]);
    expect(wasCancelled()).toBe(true);
    expect(box.execs.some((c) => c.startsWith("tar czf"))).toBe(false);
    expect(lines.join("\n")).toContain("writeFileStream requires the rpc transport");
  });
});

describe("makeCacheR2Live save", () => {
  it("a stored key skips tar czf and the upload", async () => {
    const { bucket, calls } = makeBucket([KEY]);
    await Effect.runPromise(
      Effect.flatMap(Cache, (c) =>
        c.save({ key: "pnpm-abc", paths: ["node_modules"], container, dir: "/workspace/r" }),
      ).pipe(Effect.provide(makeCacheR2Live(bucket, ns, "o/r", "rpc"))),
    );
    expect(calls).toEqual([`head ${KEY}`]);
    expect(box.execs).toEqual([]);
  });
});
