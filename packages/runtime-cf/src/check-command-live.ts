import { Effect, Schema } from "effect";
import {
  ExecFailed,
  ExecTimeout,
  flattenCommand,
  type CheckCommandOwner,
  type CheckCommandService,
  type CheckCommandHandle,
  type Container,
  type CheckCommandOpts,
  type ExecResult,
} from "@fractalboxdev/flare-dispatch-core";
import { commandFingerprint, isSpoolUnavailable } from "./check-command";
import { scrubLogPrefix } from "./check-command-log";
import { checkChunkLogFile, checkHandleId, checkLogFile } from "./log-names";
import { redactLongestFirst as redact } from "./sandbox-output";

export function makeCheckCommandService(
  executionId: string,
  defaultContainer: string,
  ownerFor: (container: Container) => CheckCommandOwner,
  bucket: Pick<R2Bucket, "put" | "get" | "head">,
  writeLog: (key: string, command: string, stdout: string, stderr: string) => Promise<void>,
  tail: (text: string) => string,
): CheckCommandService {
  const policyRequired = "check command requires an explicit string-array redaction policy";
  const policy = (opts: CheckCommandOpts): readonly string[] => {
    try {
      return Schema.decodeUnknownSync(Schema.Array(Schema.String))(opts.redactValues);
    } catch {
      throw new Error(policyRequired);
    }
  };
  const failed = (opts: CheckCommandOpts) => (cause: unknown) => {
    let values: readonly string[];
    try {
      values = policy(opts);
    } catch {
      return new ExecFailed({ exitCode: -1, stderrTail: policyRequired });
    }
    return new ExecFailed({
      exitCode: -1,
      stderrTail: redact(cause instanceof Error ? cause.message : String(cause), values).slice(
        -4096,
      ),
    });
  };
  const logs = `logs/${executionId}/`;
  const validate = async (h: CheckCommandHandle, opts: CheckCommandOpts) => {
    const values = policy(opts);
    const containerId = opts.container?.id ?? defaultContainer;
    const fingerprint = await commandFingerprint(
      flattenCommand(opts.command),
      opts.cwd,
      opts.env,
      opts.timeoutSec ?? 600,
      containerId,
      values,
    );
    if (
      h.container.id !== containerId ||
      h.fingerprint !== fingerprint ||
      h.deadline - h.startedAt !== (opts.timeoutSec ?? 600) * 1000
    )
      throw new Error("check command identity changed before replay");
  };
  const capture = async (h: CheckCommandHandle, opts: CheckCommandOpts, terminal: boolean) => {
    const owner = ownerFor(h.container);
    for (const stream of ["stdout", "stderr"] as const) {
      // One bounded chunk per observation; finalization drains the finite spool.
      const state = await owner.logs(h);
      if (state.chunks.length >= 4096)
        throw new Error("check command log exceeds bounded chunk count");
      const offset = stream === "stdout" ? state.stdoutOffset : state.stderrOffset;
      const raw = await owner.read(h, stream, offset, 65536);
      const prefix = scrubLogPrefix(raw.text, opts.redactValues ?? [], terminal);
      if (prefix.characters === 0) continue;
      const end = offset + new TextEncoder().encode(raw.text.slice(0, prefix.characters)).length;
      const key = logs + checkChunkLogFile(h.id, stream, offset, end);
      await writeLog(
        key,
        redact(flattenCommand(opts.command), opts.redactValues),
        stream === "stdout" ? prefix.text : "",
        stream === "stderr" ? prefix.text : "",
      );
      const next = {
        ...state,
        chunks: [...state.chunks, key],
        ...(stream === "stdout"
          ? { stdoutOffset: end, stdoutTail: tail(state.stdoutTail + prefix.text) }
          : { stderrOffset: end, stderrTail: tail(state.stderrTail + prefix.text) }),
      };
      await owner.advanceLogs(h, state, next);
    }
  };
  return {
    prepare: (opts) =>
      Effect.tryPromise({
        try: async () => {
          const values = policy(opts);
          const fingerprint = await commandFingerprint(
            flattenCommand(opts.command),
            opts.cwd,
            opts.env,
            opts.timeoutSec ?? 600,
            opts.container?.id ?? defaultContainer,
            values,
          );
          const operation = await commandFingerprint(
            `${executionId}\0${opts.stepName}`,
            opts.container?.id ?? defaultContainer,
          );
          const startedAt = Date.now();
          const candidate: CheckCommandHandle = {
            id: checkHandleId(operation),
            container: opts.container ?? { id: defaultContainer },
            fingerprint,
            startedAt,
            deadline: startedAt + (opts.timeoutSec ?? 600) * 1000,
          };
          return ownerFor(candidate.container).prepare(candidate);
        },
        catch: failed(opts),
      }),
    start: (handle, opts) =>
      Effect.tryPromise({
        try: async () => {
          await validate(handle, opts);
          return ownerFor(handle.container).start({
            handle,
            command: flattenCommand(opts.command),
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            ...(opts.env !== undefined ? { env: opts.env } : {}),
            redactValues: opts.redactValues,
          });
        },
        catch: failed(opts),
      }),
    observe: (handle, opts) =>
      Effect.tryPromise({
        try: async () => {
          await validate(handle, opts);
          const status = await ownerFor(handle.container).observe(handle);
          try {
            await capture(handle, opts, status.state !== "running");
          } catch (error) {
            // Log progress is durable at its offset: the next observation or
            // finalization reads on from it. Only the process state is a verdict.
            if (!isSpoolUnavailable(error)) throw error;
            console.warn(
              `check command ${handle.id}: log capture skipped, resumes at its durable offset — ${redact((error as Error).message, opts.redactValues)}`,
            );
          }
          return status;
        },
        catch: failed(opts),
      }),
    finalize: (handle, opts) =>
      Effect.gen(function* () {
        yield* Effect.tryPromise({ try: () => validate(handle, opts), catch: failed(opts) });
        const owner = ownerFor(handle.container);
        const receipt = yield* Effect.tryPromise({
          try: () => owner.receipt(handle),
          catch: failed(opts),
        });
        if (receipt !== undefined) return receipt;
        const status = yield* Effect.tryPromise({
          try: () => owner.observe(handle),
          catch: failed(opts),
        });
        if (status.state === "timeout")
          return yield* Effect.fail(
            new ExecTimeout({
              timeoutSec: opts.timeoutSec ?? 600,
              command: redact(flattenCommand(opts.command), opts.redactValues),
            }),
          );
        if (
          status.state !== "exited" ||
          status.exitCode === undefined ||
          !Number.isInteger(status.exitCode)
        )
          return yield* Effect.fail(
            failed(opts)(new Error("check command has no actual terminal exit")),
          );
        return yield* Effect.tryPromise({
          try: async (): Promise<ExecResult> => {
            for (let i = 0; i < 4096; i++) {
              const before = await owner.logs(handle);
              await capture(handle, opts, true);
              const after = await owner.logs(handle);
              if (
                before.stdoutOffset === after.stdoutOffset &&
                before.stderrOffset === after.stderrOffset
              )
                break;
              if (i === 4095) throw new Error("check log finalization exceeded bounded chunks");
            }
            const state = await owner.logs(handle);
            let size = 0;
            for (const key of state.chunks) {
              const part = await bucket.head(key);
              if (part === null) throw new Error("durable check log chunk missing");
              size += part.size;
            }
            const logPath = logs + checkLogFile(handle.id);
            const pipe = new FixedLengthStream(size);
            const writer = pipe.writable.getWriter();
            const writing = (async () => {
              try {
                for (const key of state.chunks) {
                  const part = await bucket.get(key);
                  if (part === null) throw new Error("durable check log chunk missing");
                  const reader = part.body.getReader();
                  try {
                    for (;;) {
                      const chunk = await reader.read();
                      if (chunk.done) break;
                      await writer.write(chunk.value);
                    }
                  } finally {
                    await reader.cancel();
                    reader.releaseLock();
                  }
                }
                await writer.close();
              } catch (error) {
                await writer.abort(error);
                throw error;
              }
            })();
            const publications = await Promise.allSettled([
              bucket
                .put(logPath, pipe.readable, {
                  httpMetadata: { contentType: "application/x-ndjson" },
                })
                .catch(async (error) => {
                  await writer.abort(error);
                  throw error;
                }),
              writing,
            ]);
            for (const publication of publications) {
              if (publication.status === "rejected") throw publication.reason;
            }
            if (status.durationMs === undefined || status.durationMs < 0)
              throw new Error("check command has no actual duration receipt");
            return owner.finish(handle, {
              exitCode: status.exitCode!,
              durationMs: status.durationMs,
              logPath,
              stdout: state.stdoutTail,
              stderr: state.stderrTail,
            });
          },
          catch: failed(opts),
        });
      }),
  };
}
