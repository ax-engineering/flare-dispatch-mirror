import { env } from "cloudflare:test";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type {
  CheckCommandOwner,
  CheckCommandLogState,
  ExecResult,
} from "@fractalboxdev/flare-dispatch-core";
import { makeCheckCommandService } from "./check-command-live";
import { makeCheckCommandOwner } from "./check-command";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    CHECK_COMMAND_LOGS: R2Bucket;
  }
}

describe("durable command bounded log publication", () => {
  it.each(
    (["prepare", "start", "observe", "finalize"] as const).flatMap((action) =>
      (["omitted", "malformed"] as const).map((policy) => ({ action, policy })),
    ),
  )(
    "$action refuses an $policy policy before any owner or publication access",
    async ({ action, policy }) => {
      const calls: string[] = [];
      const receipt = {
        exitCode: 0,
        durationMs: 27,
        logPath: "cached.ndjson",
        stdout: "",
        stderr: "",
      };
      const owner: CheckCommandOwner = {
        async prepare(candidate) { return candidate; },
        async start() {
          calls.push("reserve-and-launch");
        },
        async observe() {
          calls.push("observe");
          return { state: "running" };
        },
        async read() {
          calls.push("read");
          return { text: "credential-fixture", bytes: 18 };
        },
        async logs() {
          calls.push("logs");
          return { stdoutOffset: 0, stderrOffset: 0, stdoutTail: "", stderrTail: "", chunks: [] };
        },
        async advanceLogs() {
          calls.push("advance");
        },
        async receipt() {
          calls.push("receipt");
          return receipt;
        },
        async finish() {
          calls.push("finish");
          return receipt;
        },
      };
      const service = makeCheckCommandService(
        "policy-boundary",
        "box",
        () => {
          calls.push("owner");
          return owner;
        },
        env.CHECK_COMMAND_LOGS,
        async () => {
          calls.push("upload");
        },
        (text) => text,
      );
      const declared = {
        command: "print credential",
        env: { TOKEN: "credential-fixture" },
        timeoutSec: 1800,
        redactValues: [],
      };
      const handle = await Effect.runPromise(service.prepare({ ...declared, stepName: "exec" }));
      calls.length = 0;
      const invalid =
        policy === "omitted"
          ? { command: declared.command, env: declared.env, timeoutSec: declared.timeoutSec }
          : { ...declared, redactValues: [7] };
      const attempt = (() => {
        if (action === "prepare") {
          // @ts-expect-error The durable API requires a declared string-array policy.
          return service.prepare({ ...invalid, stepName: "exec" }).pipe(Effect.asVoid);
        }
        if (action === "start") {
          // @ts-expect-error Runtime callers cannot bypass the typed policy boundary.
          return service.start(handle, invalid).pipe(Effect.asVoid);
        }
        if (action === "observe") {
          // @ts-expect-error Runtime callers cannot bypass the typed policy boundary.
          return service.observe(handle, invalid).pipe(Effect.asVoid);
        }
        // @ts-expect-error Runtime callers cannot bypass the typed policy boundary.
        return service.finalize(handle, invalid).pipe(Effect.asVoid);
      })();
      await expect(Effect.runPromise(attempt)).rejects.toThrow("redaction policy");
      expect(calls).toEqual([]);
    },
  );

  it.each(["running", "exited"] as const)(
    "an unreadable spool during a %s observation keeps the log offset and logs the skip",
    async (state) => {
      const advanced: unknown[] = [];
      const owner: CheckCommandOwner = {
        async prepare(candidate) { return candidate; },
        async start() {},
        async observe() {
          return state === "running" ? { state } : { state, exitCode: 0, durationMs: 27 };
        },
        async read() {
          throw new Error("check command spool unavailable (exit 137: Killed)");
        },
        async logs() {
          return { stdoutOffset: 0, stderrOffset: 0, stdoutTail: "", stderrTail: "", chunks: [] };
        },
        async advanceLogs(_h, _expected, next) {
          advanced.push(next);
        },
        async receipt() {
          return undefined;
        },
        async finish() {
          throw new Error("no finish during observation");
        },
      };
      const service = makeCheckCommandService(
        "spool-unavailable",
        "box",
        () => owner,
        env.CHECK_COMMAND_LOGS,
        async () => {},
        (text) => text,
      );
      const opts = { command: "cargo test", timeoutSec: 1800, redactValues: [] };
      const handle = await Effect.runPromise(service.prepare({ ...opts, stepName: "exec" }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect((await Effect.runPromise(service.observe(handle, opts))).state).toBe(state);
        expect(warn).toHaveBeenCalledWith(
          `check command ${handle.id}: log capture skipped, resumes at its durable offset — check command spool unavailable (exit 137: Killed)`,
        );
      } finally {
        warn.mockRestore();
      }
      expect(advanced).toEqual([]);
    },
  );

  it("a failure other than the spool still fails the observation", async () => {
    const owner: CheckCommandOwner = {
      async prepare(candidate) { return candidate; },
      async start() {},
      async observe() {
        return { state: "running" };
      },
      async read() {
        throw new Error("check command log exceeds bounded chunk count");
      },
      async logs() {
        return { stdoutOffset: 0, stderrOffset: 0, stdoutTail: "", stderrTail: "", chunks: [] };
      },
      async advanceLogs() {},
      async receipt() {
        return undefined;
      },
      async finish() {
        throw new Error("no finish during observation");
      },
    };
    const service = makeCheckCommandService(
      "other-failure",
      "box",
      () => owner,
      env.CHECK_COMMAND_LOGS,
      async () => {},
      (text) => text,
    );
    const opts = { command: "cargo test", timeoutSec: 1800, redactValues: [] };
    const handle = await Effect.runPromise(service.prepare({ ...opts, stepName: "exec" }));
    await expect(Effect.runPromise(service.observe(handle, opts))).rejects.toThrow("bounded chunk");
  });

  it("an explicit empty policy permits no-secret commands and cached receipt reuse", async () => {
    let starts = 0;
    const receipt = {
      exitCode: 0,
      durationMs: 27,
      logPath: "cached.ndjson",
      stdout: "public",
      stderr: "",
    };
    const owner: CheckCommandOwner = {
      async prepare(candidate) { return candidate; },
      async start() {
        starts++;
      },
      async observe() {
        return { state: "running" };
      },
      async read() {
        return { text: "", bytes: 0 };
      },
      async logs() {
        return { stdoutOffset: 0, stderrOffset: 0, stdoutTail: "", stderrTail: "", chunks: [] };
      },
      async advanceLogs() {},
      async receipt() {
        return receipt;
      },
      async finish() {
        return receipt;
      },
    };
    const service = makeCheckCommandService(
      "explicit-empty-policy",
      "box",
      () => owner,
      env.CHECK_COMMAND_LOGS,
      async () => {},
      (text) => text,
    );
    const opts = { command: "print public", env: { MODE: "public" }, redactValues: [] };
    const handle = await Effect.runPromise(service.prepare({ ...opts, stepName: "exec" }));
    await Effect.runPromise(service.start(handle, opts));
    expect(await Effect.runPromise(service.observe(handle, opts))).toEqual({ state: "running" });
    expect(await Effect.runPromise(service.finalize(handle, opts))).toEqual(receipt);
    expect(starts).toBe(1);
  });
  it.each([false, true])("discarded preparation preserves the intent; changed inputs=%s", async (change) => {
    const records = new Map<string, unknown>();
    const processes = new Set<string>();
    let launches = 0;
    const owner = makeCheckCommandOwner(
      {
        async load(key) {
          return records.get(key);
        },
        async reserve(key, value) {
          if (records.has(key)) return false;
          records.set(key, value);
          return true;
        },
        async save(key, value, expected) {
          if (JSON.stringify(records.get(key)) !== JSON.stringify(expected)) return false;
          records.set(key, value);
          return true;
        },
      },
      {
        async writeFile() {
          return { success: true };
        },
        async startProcess(_command, options) {
          launches++;
          processes.add(options.processId);
        },
        async getProcess(id) {
          return processes.has(id) ? { status: "running" } : null;
        },
        async exec() {
          throw new Error("no spool read before admission");
        },
      },
    );
    const service = makeCheckCommandService(
      "same-logical-execution",
      "box",
      () => owner,
      env.CHECK_COMMAND_LOGS,
      async () => {},
      (text) => text,
    );
    const opts = {
      command: "command",
      env: { TOKEN: "original" },
      timeoutSec: 1800,
      redactValues: ["original"],
    };
    const initial = await Effect.runPromise(service.prepare({ ...opts, stepName: "exec" }));
    await Effect.runPromise(service.start(initial, opts));
    await Effect.runPromise(Effect.sleep("5 millis"));
    const changed = change ? { ...opts, env: { TOKEN: "changed" } } : opts;
    if (change) {
      await expect(Effect.runPromise(service.prepare({ ...changed, stepName: "exec" }))).rejects.toThrow("identity");
    } else {
      const reconstructed = await Effect.runPromise(service.prepare({ ...changed, stepName: "exec" }));
      expect(reconstructed).toEqual(initial);
      expect(reconstructed.id).toBe(initial.id);
      await Effect.runPromise(service.start(reconstructed, changed));
    }
    expect(launches).toBe(1);
  });
  it.each([
    { action: "observe", change: "env" },
    { action: "finalize", change: "env" },
    { action: "observe", change: "redaction" },
    { action: "finalize", change: "redaction" },
    { action: "observe", change: "redaction-order" },
    { action: "finalize", change: "redaction-order" },
  ] as const)(
    "$action refuses replay with changed $change before owner access or upload",
    async ({ action, change }) => {
      const calls: string[] = [];
      const owner: CheckCommandOwner = {
        async prepare(candidate) { return candidate; },
        async start() {
          calls.push("start");
        },
        async observe() {
          calls.push("observe");
          return { state: "exited", exitCode: 0, durationMs: 27 };
        },
        async read() {
          calls.push("read");
          return { text: "old-opaque-secret", bytes: 17 };
        },
        async logs() {
          calls.push("logs");
          return { stdoutOffset: 0, stderrOffset: 0, stdoutTail: "", stderrTail: "", chunks: [] };
        },
        async advanceLogs() {
          calls.push("advance");
        },
        async receipt() {
          calls.push("receipt");
          return { exitCode: 0, durationMs: 27, logPath: "old.ndjson", stdout: "***", stderr: "" };
        },
        async finish(_h, result) {
          calls.push("finish");
          return result;
        },
      };
      const service = makeCheckCommandService(
        "identity-replay",
        "box",
        () => owner,
        env.CHECK_COMMAND_LOGS,
        async () => {
          calls.push("upload");
        },
        (text) => text.slice(-4096),
      );
      const original = {
        command: "command",
        env: { TOKEN: "old-opaque-secret" },
        redactValues: change === "redaction-order" ? ["abc", "abcdef"] : ["old-opaque-secret"],
        timeoutSec: 1800,
      };
      const handle = await Effect.runPromise(service.prepare({ ...original, stepName: "exec" }));
      const changed =
        change === "env"
          ? {
              ...original,
              env: { TOKEN: "new-opaque-secret" },
              redactValues: ["new-opaque-secret"],
            }
          : {
              ...original,
              redactValues:
                change === "redaction-order"
                  ? [...original.redactValues].reverse()
                  : ["new-opaque-secret"],
            };
      const attempt =
        action === "observe"
          ? service.observe(handle, changed).pipe(Effect.asVoid)
          : service.finalize(handle, changed).pipe(Effect.asVoid);
      await expect(Effect.runPromise(attempt)).rejects.toThrow("identity");
      expect(calls).toEqual([]);
    },
  );
  it("lost chunk acknowledgment replays scrubbed bytes and finalization preserves actual exits", async () => {
    for (const code of [0, 7]) {
      const secret = "opaque-secret-value";
      const output = "x".repeat(65530) + secret + "END";
      let logs: CheckCommandLogState = {
        stdoutOffset: 0,
        stderrOffset: 0,
        stdoutTail: "",
        stderrTail: "",
        chunks: [],
      };
      let receipt: ExecResult | undefined;
      let loseReceiptAck = true;
      let terminal = false;
      const containers: string[] = [];
      const owner: CheckCommandOwner = {
        async prepare(candidate) { return candidate; },
        async start() {},
        async observe() {
          return terminal
            ? { state: "exited", exitCode: code, durationMs: 27 }
            : { state: "running" };
        },
        async read(_h, stream, offset, length) {
          const text = stream === "stdout" ? output.slice(offset, offset + length) : "";
          return { text, bytes: new TextEncoder().encode(text).length };
        },
        async logs() {
          return logs;
        },
        async advanceLogs(_h, expected, next) {
          expect(logs).toEqual(expected);
          logs = next;
        },
        async receipt() {
          return receipt;
        },
        async finish(_h, result) {
          receipt ??= result;
          if (loseReceiptAck) {
            loseReceiptAck = false;
            throw new Error("lost final receipt acknowledgment");
          }
          return receipt;
        },
      };
      let lost = true;
      let uploads = 0;
      let loseFinalUploadAck = true;
      let failBeforeStream = true;
      let finalUploads = 0;
      const bucket: Pick<R2Bucket, "get" | "head" | "put"> = {
        get: env.CHECK_COMMAND_LOGS.get.bind(env.CHECK_COMMAND_LOGS),
        head: env.CHECK_COMMAND_LOGS.head.bind(env.CHECK_COMMAND_LOGS),
        put: async (key, value, options) => {
          if (failBeforeStream) {
            failBeforeStream = false;
            throw new Error("upload refused before stream consumption");
          }
          const result = await env.CHECK_COMMAND_LOGS.put(key, value, options);
          finalUploads++;
          if (loseFinalUploadAck) {
            loseFinalUploadAck = false;
            throw new Error("lost final upload acknowledgment");
          }
          return result;
        },
      };
      const service = makeCheckCommandService(
        `logs-${code}`,
        "default-box",
        (container) => {
          containers.push(container.id);
          return owner;
        },
        bucket,
        async (key, command, stdout, stderr) => {
          uploads++;
          await env.CHECK_COMMAND_LOGS.put(key, JSON.stringify({ command, stdout, stderr }) + "\n");
          if (lost) {
            lost = false;
            throw new Error("lost chunk acknowledgment");
          }
        },
        (text) => text.slice(-4096),
      );
      const opts = {
        command: `printf '${secret}'`,
        redactValues: [secret],
        container: { id: "explicit-box" },
        timeoutSec: 1800,
      };
      const handle = await Effect.runPromise(service.prepare({ ...opts, stepName: "exec" }));
      await expect(Effect.runPromise(service.observe(handle, opts))).rejects.toThrow(
        "lost chunk acknowledgment",
      );
      expect(logs.stdoutOffset).toBe(0);
      await Effect.runPromise(service.observe(handle, opts));
      terminal = true;
      await expect(Effect.runPromise(service.finalize(handle, opts))).rejects.toThrow(
        "upload refused before stream consumption",
      );
      await expect(Effect.runPromise(service.finalize(handle, opts))).rejects.toThrow(
        "lost final upload acknowledgment",
      );
      expect(receipt).toBeUndefined();
      await expect(Effect.runPromise(service.finalize(handle, opts))).rejects.toThrow(
        "lost final receipt acknowledgment",
      );
      const result = await Effect.runPromise(service.finalize(handle, opts));
      expect(result.exitCode).toBe(code);
      expect(result.durationMs).toBe(27);
      expect(result.stdout).toContain("***END");
      const object = await env.CHECK_COMMAND_LOGS.get(result.logPath);
      const published = await object!.text();
      expect(published).not.toContain(secret);
      expect(published).toContain("***END");
      expect(logs.chunks.length).toBeGreaterThan(1);
      const prior = uploads;
      expect(await Effect.runPromise(service.finalize(handle, opts))).toEqual(result);
      expect(uploads).toBe(prior);
      expect(finalUploads).toBe(2);
      expect(new Set(containers)).toEqual(new Set(["explicit-box"]));
    }
  });
});
