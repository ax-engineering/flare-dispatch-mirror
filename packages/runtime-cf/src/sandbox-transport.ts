// The sandbox transport an execution's containers run on.
//
// The `@cloudflare/sandbox` SDK speaks to a container over `http` (its own
// default), `websocket` or `rpc`. Only `rpc` streams a file into a container,
// so only `rpc` lets the R2 cache apply a stored archive (cache-r2.ts
// § Transport). The dispatcher therefore defaults to `rpc` and pins the
// effective transport onto every container it acquires (sandbox-cf.ts), rather
// than leaving an unpinned container on the SDK's `http`.
//
// Precedence, highest first:
//
//   1. the per-repo `CONFIG_KV` pin `sandbox.transport:<repo>` — in either
//      direction, so an operator moves one repo back to `http` without a deploy;
//   2. the Worker-wide `SANDBOX_TRANSPORT` var;
//   3. `rpc`.
//
// A value that is not a transport name is ignored at its level, so a typo in
// the pin falls through to the var, and one in the var falls through to `rpc`.

export type SandboxTransport = "http" | "websocket" | "rpc";

/** The transport a container runs on when neither the pin nor the var names one. */
export const SANDBOX_TRANSPORT_DEFAULT: SandboxTransport = "rpc";

/** `raw` as a transport name, or `undefined` when it is not one. */
export const parseSandboxTransport = (raw: string | null | undefined): SandboxTransport | undefined =>
  raw === "rpc" || raw === "websocket" || raw === "http" ? raw : undefined;

/**
 * The effective transport: the per-repo pin, else the Worker-wide var, else
 * `rpc`. Unrecognised values at either level are skipped.
 */
export const resolveSandboxTransport = (input: {
  readonly repoPin?: string | null | undefined;
  readonly workerDefault?: string | null | undefined;
}): SandboxTransport =>
  parseSandboxTransport(input.repoPin) ??
  parseSandboxTransport(input.workerDefault) ??
  SANDBOX_TRANSPORT_DEFAULT;
