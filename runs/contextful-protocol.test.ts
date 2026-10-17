import { it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { makeCFRuntimeTest } from "@fractalboxdev/flare-dispatch-core/testing";
import { contextfulProtocol, protocolCommand } from "./contextful-protocol";

const sha = "a".repeat(40);
const input = { repo: "fractalboxdev/contextful", ref: "refs/heads/main", firedAt: 1791253020000 };

describe("contextful-protocol", () => {
  it("restores the installed Lean environment in a fresh command process", () => {
    const dir = mkdtempSync(join(tmpdir(), "protocol-command-"));
    try {
      const elanHome = join(dir, "elan");
      mkdirSync(join(elanHome, "bin"), { recursive: true });
      mkdirSync(join(dir, "formal"));
      writeFileSync(join(dir, "formal/lean-toolchain"), "leanprover/lean4:v4.29.1\n");
      writeFileSync(
        join(elanHome, "bin/cargo"),
        `#!${process.execPath}\nconsole.log(JSON.stringify({toolchain:process.env.ELAN_TOOLCHAIN,requireLean:process.env.CONTEXTFUL_REQUIRE_LEAN,path:process.env.PATH,args:process.argv.slice(2)}));\n`,
        { mode: 0o755 },
      );
      const result = spawnSync("sh", ["-c", protocolCommand("123")], {
        cwd: dir,
        env: {
          ...process.env,
          ELAN_HOME: elanHome,
          ELAN_TOOLCHAIN: "unrelated",
          CONTEXTFUL_REQUIRE_LEAN: "0",
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const observed = JSON.parse(result.stdout);
      expect(observed.toolchain).toBe("leanprover/lean4:v4.29.1");
      expect(observed.requireLean).toBe("1");
      expect(observed.path.split(":")[0]).toBe(join(elanHome, "bin"));
      expect(observed.args.slice(-6)).toEqual([
        "formal",
        "protocol-differential",
        "--seed",
        "123",
        "--cases",
        "256",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
  it("routes the weekly schedule with one identity per tick", () => {
    const schedule = contextfulProtocol.schedules?.[0];
    expect(schedule?.cron).toBe("17 3 * * SUN");
    expect(schedule?.inputs({ cron: "17 3 * * SUN", firedAt: input.firedAt })).toEqual(input);
    expect(schedule?.idempotencyKey({ cron: "17 3 * * SUN", firedAt: input.firedAt })).toBe(
      `contextful-protocol:${input.firedAt}`,
    );
  });

  it.effect("checks the pinned model before exploring a checkpointed fresh u64 seed", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: {
        "gate --predecessors --stage toolchain": { exitCode: 0 },
        randomBytes: { exitCode: 0, stdout: "18446744073709551615\n" },
        "protocol-differential": { exitCode: 0 },
        "formal check": { exitCode: 0 },
      },
    });
    return Effect.gen(function* () {
      const out = yield* contextfulProtocol.run(input);
      expect(out.commit).toBe(sha);
      expect(out.seed).toBe("18446744073709551615");
      expect(handles.sandbox.clones).toEqual([{ repo: input.repo, sha }]);
      const commands = handles.sandbox.execs.map((exec) => exec.command);
      expect(commands[0]).toContain("gate --predecessors --stage toolchain");
      expect(commands[1]).toContain("formal check");
      expect(commands[3]).toBe(protocolCommand(out.seed));
      expect(commands[3]).toContain('export PATH="${ELAN_HOME:-$HOME/.elan}/bin:$PATH"');
      expect(commands[3]).toContain('export ELAN_TOOLCHAIN="$(cat formal/lean-toolchain)"');
      expect(commands[3]).toContain("--no-default-features");
      expect(commands[3]).toContain("--cases 256");
      expect(handles.artifact.uploads).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "preserves the failing seed, log and reduced regressions before reporting drift",
    () => {
      const { layer, handles } = makeCFRuntimeTest({
        github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
        sandboxProgram: {
          "gate --predecessors --stage toolchain": { exitCode: 0 },
          randomBytes: { exitCode: 0, stdout: "123\n" },
          "protocol-differential": { exitCode: 3 },
          "formal check": { exitCode: 0 },
        },
        sandboxFiles: {
          "/workspace/contextful/formal/protocol/regressions.jsonl": '{"seed":123}\n',
        },
      });
      return Effect.gen(function* () {
        const out = yield* Effect.exit(contextfulProtocol.run(input));
        expect(Exit.isFailure(out)).toBe(true);
        expect(handles.artifact.uploads.map((upload) => upload.name)).toContain(
          "protocol-regressions.jsonl",
        );
        expect(handles.sandbox.execs[3]?.command).toContain("--seed 123");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("explores the commit the schedule pinned without re-reading the branch head", () => {
    const pinned = "b".repeat(40);
    const { layer, handles } = makeCFRuntimeTest({
      sandboxProgram: {
        "gate --predecessors --stage toolchain": { exitCode: 0 },
        randomBytes: { exitCode: 0, stdout: "7\n" },
        "protocol-differential": { exitCode: 0 },
        "formal check": { exitCode: 0 },
      },
    });
    return Effect.gen(function* () {
      const out = yield* contextfulProtocol.run({ ...input, sha: pinned });
      expect(out.commit).toBe(pinned);
      expect(handles.github.branchHeadCalls).toHaveLength(0);
      expect(handles.sandbox.clones).toEqual([{ repo: input.repo, sha: pinned }]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a different repository before allocating a sandbox", () => {
    const { layer, handles } = makeCFRuntimeTest({});
    return Effect.gen(function* () {
      const out = yield* Effect.exit(contextfulProtocol.run({ ...input, repo: "other/repo" }));
      expect(Exit.isFailure(out)).toBe(true);
      expect(handles.sandbox.clones).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps malformed seed output out of the shell command", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: {
        "gate --predecessors --stage toolchain": { exitCode: 0 },
        randomBytes: { exitCode: 0, stdout: "123; touch injected\n" },
        "formal check": { exitCode: 0 },
      },
    });
    return Effect.gen(function* () {
      const out = yield* Effect.exit(contextfulProtocol.run(input));
      expect(Exit.isFailure(out)).toBe(true);
      expect(handles.sandbox.execs).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("retains the toolchain failure log and starts no model check", () => {
    const { layer, handles } = makeCFRuntimeTest({
      github: { branchHeads: { "fractalboxdev/contextful:main": sha } },
      sandboxProgram: { "gate --predecessors --stage toolchain": { exitCode: 7 } },
    });
    return Effect.gen(function* () {
      const out = yield* Effect.exit(contextfulProtocol.run(input));
      expect(Exit.isFailure(out)).toBe(true);
      expect(handles.sandbox.execs).toHaveLength(1);
      expect(handles.artifact.uploads.map((upload) => upload.name)).toEqual([
        "protocol-toolchain.log",
      ]);
    }).pipe(Effect.provide(layer));
  });
});
