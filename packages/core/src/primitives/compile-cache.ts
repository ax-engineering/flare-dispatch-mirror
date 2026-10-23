// Shared compile cache — the in-container half.
//
// A run whose definition declares `compileCache` gets two config values the
// dispatcher injects when the run starts (apps/dispatcher/src/workflow.ts):
// the WebDAV endpoint of the dispatcher's compile-cache route and a token
// scoped to the run's repository, execution and lane. `compileCacheCommand` wraps a
// shell command so every `rustc` it invokes goes through sccache against that
// endpoint, and prints sccache's statistics into the command's log when the
// command ends.
//
// A cache outage never fails the command. sccache's server checks its storage
// when it starts and refuses to start when the storage read fails; the wrapper
// starts the server itself before exporting `RUSTC_WRAPPER`, so an unreachable
// cache, a rejected token or a missing binary leaves `RUSTC_WRAPPER` unset and
// rustc compiles locally. Once the server is up, sccache reads an unreadable
// entry as a miss and logs a failed write without failing the compile, and
// `SCCACHE_IGNORE_SERVER_IO_ERROR=1` compiles locally when the client loses
// its server mid-compile.
//
// Spec: specs/adr/0007-cost-efficient-execution.md § Shared compile cache.

/** Config key carrying the WebDAV endpoint of the compile-cache route. */
export const COMPILE_CACHE_ENDPOINT_KEY = "compile-cache.endpoint";
/** Config key carrying the run's compile-cache token. */
export const COMPILE_CACHE_TOKEN_KEY = "compile-cache.token";

/**
 * Where an execution's compile-cache writes land, bound into its token:
 *
 * - `base`      the default branch's lane: reads and writes it.
 * - `pr-<n>`    pull request `n`'s lane: writes it, reads it and then `base`.
 * - `read-only` reads `base` and writes nothing.
 *
 * No execution reads another pull request's lane, so an entry a pull request
 * writes reaches only that pull request's later executions.
 */
export type CompileCacheLane = "base" | "read-only" | `pr-${number}`;

const LANE = /^(base|read-only|pr-[1-9][0-9]{0,9})$/;

/** Whether `value` names a lane. */
export const isCompileCacheLane = (value: string): value is CompileCacheLane => LANE.test(value);

/** The environment the wrapped command needs from the run. */
export type CompileCacheAccess = {
  readonly endpoint: string;
  readonly token: string;
};

/** `owner/name` — the only characters the key prefix may carry from the repo. */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/**
 * The env the wrapped command reads: endpoint and token for sccache's WebDAV
 * backend. The key prefix is computed inside the container from the toolchain
 * the checkout selects.
 */
export const compileCacheEnv = (access: CompileCacheAccess): Record<string, string> => ({
  SCCACHE_WEBDAV_ENDPOINT: access.endpoint,
  SCCACHE_WEBDAV_TOKEN: access.token,
});

/**
 * Wrap `command` so its Rust compiles go through sccache.
 *
 * - `SCCACHE_WEBDAV_KEY_PREFIX` is `<repo>/<rustc release>/<host triple>`,
 *   read from `rustc -vV` in the checkout, so a `rust-toolchain.toml` pin
 *   selects its own prefix.
 * - `CARGO_INCREMENTAL=0`: sccache exits 1 on any compile run with
 *   incremental compilation on.
 * - `SCCACHE_IDLE_TIMEOUT=0` keeps one server, and its statistics, for the
 *   whole command.
 * - The command runs in a subshell, so an `exec` inside it returns here and
 *   the statistics still print; the wrapper exits with the command's status.
 *   The closing parenthesis sits on its own line, so a trailing `#` comment
 *   in the command cannot swallow it.
 */
export const compileCacheCommand = (command: string, repo: string): string => {
  if (!REPO_SLUG.test(repo)) throw new Error(`compileCacheCommand: invalid repo ${JSON.stringify(repo)}`);
  return [
    "fd_cc_on=0",
    "if command -v sccache >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1 && [ -n \"${SCCACHE_WEBDAV_ENDPOINT:-}\" ] && [ -n \"${SCCACHE_WEBDAV_TOKEN:-}\" ]; then",
    "  fd_cc_vv=\"$(rustc -vV 2>/dev/null)\"",
    "  fd_cc_release=\"$(printf '%s\\n' \"$fd_cc_vv\" | sed -n 's/^release: //p')\"",
    "  fd_cc_host=\"$(printf '%s\\n' \"$fd_cc_vv\" | sed -n 's/^host: //p')\"",
    "  if [ -n \"$fd_cc_release\" ] && [ -n \"$fd_cc_host\" ]; then",
    `    export SCCACHE_WEBDAV_KEY_PREFIX="${repo}/$fd_cc_release/$fd_cc_host"`,
    "    export CARGO_INCREMENTAL=0 SCCACHE_IDLE_TIMEOUT=0 SCCACHE_IGNORE_SERVER_IO_ERROR=1",
    "    if sccache --start-server >/dev/null 2>&1; then",
    "      export RUSTC_WRAPPER=sccache",
    "      fd_cc_on=1",
    "    else",
    "      echo 'compile cache: sccache server did not start; compiling locally' >&2",
    "    fi",
    "  fi",
    "else",
    "  echo 'compile cache: sccache, rustc or cache access unavailable; compiling locally' >&2",
    "fi",
    "(",
    command,
    ")",
    "fd_cc_status=$?",
    "if [ \"$fd_cc_on\" = 1 ]; then",
    "  echo '--- sccache --show-stats ---'",
    "  sccache --show-stats || true",
    "  sccache --stop-server >/dev/null 2>&1 || true",
    "fi",
    "exit $fd_cc_status",
  ].join("\n");
};
