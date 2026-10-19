import { spawn, spawnSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { commandSupervisor, commandSpool } from "./check-command";

async function stopped(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "state="], { encoding: "utf8", timeout: 1000, maxBuffer: 4096 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error("fixture process state unavailable");
    return result.stdout.trim().startsWith("Z");
  }
  if (process.platform !== "linux") return false;
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = value.slice(value.lastIndexOf(")") + 2).split(" ")[0];
    return state === "Z" || state === "X";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

describe("native check command supervisor", () => {
  it("a live process fails the stopped-process probe until its actual exit is reaped", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
    const closed = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    try {
      expect(child.pid).toBeGreaterThan(0);
      expect(await stopped(child.pid!)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await closed;
    }
    expect(await stopped(child.pid!)).toBe(true);
  });

  it("a receipt waits for a TERM-ignoring descendant after delayed KILL delivery", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    const dir = commandSpool(handle);
    const command = `node -e 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync("${dir}/ready","ready");setInterval(()=>{},1000)' >/dev/null 2>&1 & echo $!; while [ ! -f '${dir}/ready' ]; do sleep 0.01; done; exit 0`;
    const delayed = `const realKill=process.kill.bind(process);process.kill=(pid,signal)=>{if(signal==='SIGKILL'){setTimeout(()=>{try{realKill(pid,signal)}catch{}},200);return true;}return realKill(pid,signal);};`;
    const child = spawn(process.execPath, ["-e", delayed + commandSupervisor(handle, command)]);
    const closed = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", () => resolve());
    });
    let descendant = 0;
    try {
      let terminal;
      for (let attempt = 0; attempt < 500 && terminal === undefined; attempt++) {
        try {
          terminal = JSON.parse(await readFile(`${dir}/terminal.json`, "utf8"));
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(terminal).toMatchObject({ exitCode: 0, timedOut: false });
      descendant = Number((await readFile(`${dir}/stdout`, "utf8")).trim());
      expect(descendant).toBeGreaterThan(0);
      expect(await stopped(descendant)).toBe(true);
      await closed;
    } finally {
      if (descendant > 0) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await closed;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["unavailable", "malformed", "stalled"] as const)(
    "a %s process-group probe refuses terminal publication",
    async (mode) => {
      const handle = {
        id: `native-${crypto.randomUUID()}`,
        container: { id: "explicit" },
        fingerprint: "native",
        startedAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      const probes = {
        unavailable: `Object.defineProperty(process,'platform',{value:'linux'});const probeFs=require('node:fs'),realRead=probeFs.readdirSync;probeFs.readdirSync=(path,...args)=>{if(path==='/proc')throw new Error('probe unavailable');return realRead(path,...args)};`,
        malformed: `Object.defineProperty(process,'platform',{value:'linux'});const probeFs=require('node:fs'),realRead=probeFs.readFileSync,realList=probeFs.readdirSync;probeFs.readdirSync=(path,...args)=>path==='/proc'?['1']:realList(path,...args);probeFs.readFileSync=(path,...args)=>path==='/proc/1/stat'?'malformed':realRead(path,...args);`,
        stalled: `Object.defineProperty(process,'platform',{value:'linux'});const probeFs=require('node:fs'),realRead=probeFs.readFileSync,realList=probeFs.readdirSync,cp=require('node:child_process'),realSpawn=cp.spawn;let ownedPid,scans=0;cp.spawn=(...args)=>{const child=realSpawn(...args);ownedPid=child.pid;return child};probeFs.readdirSync=(path,...args)=>{if(path!=='/proc')return realList(path,...args);if(++scans===1)return ['1'];Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);return []};probeFs.readFileSync=(path,...args)=>path==='/proc/1/stat'?'1 (owned) S 1 '+ownedPid+' 0':realRead(path,...args);`,
      };
      const unavailable = probes[mode];
      const child = spawn(process.execPath, [
        "-e",
        unavailable +
          commandSupervisor(handle, "sleep 30 >/dev/null 2>&1 & echo $!; sleep 0.05; exit 0"),
      ]);
      let descendant = 0;
      try {
        const actual = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        expect(actual).toBe(1);
        descendant = Number((await readFile(`${commandSpool(handle)}/stdout`, "utf8")).trim());
        expect(descendant).toBeGreaterThan(0);
        await expect(
          readFile(`${commandSpool(handle)}/terminal.json`, "utf8"),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (descendant > 0) {
          try {
            process.kill(descendant, "SIGKILL");
          } catch {}
        }
        await rm(commandSpool(handle), { recursive: true, force: true });
      }
    },
  );
  it.each(["unavailable", "malformed", "live"] as const)(
    "a %s Darwin process-group probe refuses terminal publication",
    async (mode) => {
      const handle = { id: `native-${crypto.randomUUID()}`, container: { id: "explicit" }, fingerprint: "native",
        startedAt: Date.now(), deadline: Date.now() + 5000 };
      const override = `Object.defineProperty(process,'platform',{value:'darwin'});const cp=require('node:child_process'),realSpawn=cp.spawn;let ownedPid;cp.spawn=(...args)=>{const child=realSpawn(...args);ownedPid=child.pid;return child};cp.spawnSync=()=>${mode === "unavailable" ? "{throw new Error('probe unavailable')}" : "({status:0,stdout:" + (mode === "malformed" ? "'malformed'" : "ownedPid+' S'") + "})"};`;
      const child = spawn(process.execPath, ["-e", override + commandSupervisor(handle, "sleep 30 >/dev/null 2>&1 & echo $!; sleep 0.05; exit 0")]);
      let descendant = 0;
      try {
        const actual = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
        descendant = Number((await readFile(`${commandSpool(handle)}/stdout`, "utf8")).trim());
        expect(actual).toBe(1);
        await expect(readFile(`${commandSpool(handle)}/terminal.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (descendant > 0) { try { process.kill(descendant, "SIGKILL"); } catch {} }
        await rm(commandSpool(handle), { recursive: true, force: true });
      }
    },
  );
  it("a successful parent exit cleans redirected descendants before publishing its receipt", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    let descendant = 0;
    try {
      const child = spawn(process.execPath, [
        "-e",
        commandSupervisor(handle, "sleep 30 >/dev/null 2>&1 & echo $!; exit 0"),
      ]);
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      descendant = Number((await readFile(`${commandSpool(handle)}/stdout`, "utf8")).trim());
      expect(
        JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
      ).toMatchObject({ exitCode: 0, timedOut: false });
      expect(descendant).toBeGreaterThan(0);
      expect(await stopped(descendant)).toBe(true);
    } finally {
      if (descendant > 0) {
        try {
          process.kill(descendant, "SIGKILL");
        } catch {}
      }
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
  it("records actual zero and nonzero exits with separate output spools", async () => {
    for (const code of [0, 7]) {
      const handle = {
        id: `native-${crypto.randomUUID()}`,
        container: { id: "explicit" },
        fingerprint: "native",
        startedAt: Date.now(),
        deadline: Date.now() + 5000,
      };
      try {
        const child = spawn(process.execPath, [
          "-e",
          commandSupervisor(handle, `printf 'real-output'; printf 'real-error' >&2; exit ${code}`),
        ]);
        const actual = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("exit", resolve);
        });
        expect(actual).toBe(code);
        expect(
          JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
        ).toMatchObject({ exitCode: code, timedOut: false });
        expect(await readFile(`${commandSpool(handle)}/stdout`, "utf8")).toBe("real-output");
        expect(await readFile(`${commandSpool(handle)}/stderr`, "utf8")).toBe("real-error");
      } finally {
        await rm(commandSpool(handle), { recursive: true, force: true });
      }
    }
  });
  it("the absolute deadline stops the owned POSIX process group", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 500,
    };
    try {
      const child = spawn(process.execPath, [
        "-e",
        commandSupervisor(handle, "sleep 30 & echo $!; wait"),
      ]);
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      const terminal = JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8"));
      expect(terminal.timedOut).toBe(true);
      expect(terminal.endedAt - handle.startedAt).toBeLessThan(2500);
      const descendant = Number((await readFile(`${commandSpool(handle)}/stdout`, "utf8")).trim());
      expect(descendant).toBeGreaterThan(0);
      expect(await stopped(descendant)).toBe(true);
    } finally {
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
  it("an output flood refuses publication and bounds the persistent spool", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    try {
      const child = spawn(process.execPath, [
        "-e",
        commandSupervisor(handle, "node -e 'process.stdout.write(Buffer.alloc(65*1024*1024,120))'"),
      ]);
      await new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
      expect((await stat(`${commandSpool(handle)}/stdout`)).size).toBeLessThanOrEqual(
        64 * 1024 * 1024,
      );
      expect(
        JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
      ).toMatchObject({ logExceeded: true });
    } finally {
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
  it("a command killed by a signal records the shell's 128+N exit and names the signal", async () => {
    const handle = {
      id: `native-${crypto.randomUUID()}`,
      container: { id: "explicit" },
      fingerprint: "native",
      startedAt: Date.now(),
      deadline: Date.now() + 5000,
    };
    try {
      const child = spawn(process.execPath, ["-e", commandSupervisor(handle, "kill -KILL $$")]);
      const actual = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", resolve);
      });
      expect(actual).toBe(137);
      expect(
        JSON.parse(await readFile(`${commandSpool(handle)}/terminal.json`, "utf8")),
      ).toMatchObject({ exitCode: 137, signal: "SIGKILL", timedOut: false });
      expect(await readFile(`${commandSpool(handle)}/stderr`, "utf8")).toContain("SIGKILL");
    } finally {
      await rm(commandSpool(handle), { recursive: true, force: true });
    }
  });
});
