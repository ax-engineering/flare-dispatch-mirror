// `compileCacheCommand` runs under `/bin/sh` against stub `rustc` and `sccache`
// binaries, so the fallback and the statistics are the shell's real behavior.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileCacheCommand, compileCacheEnv, isCompileCacheLane } from "./compile-cache";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RUSTC = `#!/bin/sh
printf 'rustc 1.90.0 (1159e78c4 2025-09-14)\\nbinary: rustc\\nhost: x86_64-unknown-linux-gnu\\nrelease: 1.90.0\\n'
`;

/** A stub `sccache` that logs each invocation and its cache env; `--start-server` exits `startExit`. */
const sccacheStub = (log: string, startExit: number): string => `#!/bin/sh
echo "$* prefix=$SCCACHE_WEBDAV_KEY_PREFIX incr=$CARGO_INCREMENTAL ignore=$SCCACHE_IGNORE_SERVER_IO_ERROR idle=$SCCACHE_IDLE_TIMEOUT" >> ${log}
case "$1" in
  --start-server) exit ${startExit} ;;
  --show-stats) echo "Compile requests 12" ;;
esac
exit 0
`;

const sandbox = (opts: { readonly sccache?: { readonly startExit: number } }) => {
  const dir = mkdtempSync(join(tmpdir(), "compile-cache-"));
  dirs.push(dir);
  const log = join(dir, "sccache.log");
  writeFileSync(log, "");
  const rustc = join(dir, "rustc");
  writeFileSync(rustc, RUSTC);
  chmodSync(rustc, 0o755);
  if (opts.sccache !== undefined) {
    const sccache = join(dir, "sccache");
    writeFileSync(sccache, sccacheStub(log, opts.sccache.startExit));
    chmodSync(sccache, 0o755);
  }
  const run = (command: string, env: Record<string, string> = compileCacheEnv({ endpoint: "https://d.example/v1/compile-cache", token: "t" })) =>
    spawnSync("/bin/sh", ["-c", compileCacheCommand(command, "owner/name")], {
      env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
      encoding: "utf8",
    });
  return { run, log: () => readFileSync(log, "utf8") };
};

describe("compileCacheCommand", () => {
  it("runs the command under sccache with the toolchain's prefix and prints the statistics", () => {
    const box = sandbox({ sccache: { startExit: 0 } });
    const result = box.run('echo "wrapper=$RUSTC_WRAPPER incr=$CARGO_INCREMENTAL"; exit 3');
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("wrapper=sccache incr=0");
    expect(result.stdout).toContain("--- sccache --show-stats ---\nCompile requests 12");
    expect(box.log()).toContain(
      "--start-server prefix=owner/name/1.90.0/x86_64-unknown-linux-gnu incr=0 ignore=1 idle=0",
    );
    expect(box.log()).toContain("--stop-server");
  });

  it("returns to print the statistics after a command that execs", () => {
    const box = sandbox({ sccache: { startExit: 0 } });
    const result = box.run("exec sh -c 'exit 0'");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Compile requests 12");
  });

  it("compiles locally when the sccache server does not start", () => {
    const box = sandbox({ sccache: { startExit: 2 } });
    const result = box.run('echo "wrapper=${RUSTC_WRAPPER:-none}"');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("wrapper=none");
    expect(result.stdout).not.toContain("--show-stats");
    expect(result.stderr).toContain("sccache server did not start; compiling locally");
  });

  it("compiles locally when sccache is not installed", () => {
    const box = sandbox({});
    const result = box.run('echo "wrapper=${RUSTC_WRAPPER:-none}"');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("wrapper=none");
  });

  it("compiles locally when no endpoint or token reached the command", () => {
    const box = sandbox({ sccache: { startExit: 0 } });
    const result = box.run('echo "wrapper=${RUSTC_WRAPPER:-none}"', {});
    expect(result.stdout).toContain("wrapper=none");
    expect(box.log()).toBe("");
  });

  it("runs a command that ends in a comment", () => {
    const box = sandbox({ sccache: { startExit: 0 } });
    const result = box.run("echo ran # trailing comment");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ran");
    expect(result.stdout).toContain("Compile requests 12");
  });

  it("refuses a repository outside the owner/name charset", () => {
    expect(() => compileCacheCommand("true", 'owner/name"; rm -rf /')).toThrow(/invalid repo/);
  });

  it("hands sccache the endpoint and token", () => {
    expect(compileCacheEnv({ endpoint: "https://d.example/v1/compile-cache", token: "t" })).toEqual({
      SCCACHE_WEBDAV_ENDPOINT: "https://d.example/v1/compile-cache",
      SCCACHE_WEBDAV_TOKEN: "t",
    });
  });
});

describe("isCompileCacheLane", () => {
  it("accepts the default-branch lane, a pull request's lane and the read-only lane", () => {
    for (const lane of ["base", "read-only", "pr-1", "pr-4242"]) expect(isCompileCacheLane(lane)).toBe(true);
  });

  it("refuses anything else", () => {
    for (const lane of ["", "pr-", "pr-0", "pr-01", "pr-1/x", "Base", "main", "../base", "pr-12345678901"])
      expect(isCompileCacheLane(lane)).toBe(false);
  });
});
