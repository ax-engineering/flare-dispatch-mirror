import { Schema } from "effect";
import {
  CheckCommandHandle,
  CheckCommandObservation,
  CheckCommandChunk,
  CheckCommandLogState,
  ExecResultSchema,
  type CheckCommandOwner,
  type ExecResult,
} from "@fractalboxdev/flare-dispatch-core";

export interface CheckCommandStorage {
  load(key: string): Promise<unknown>;
  reserve(key: string, value: unknown): Promise<boolean>;
  save(key: string, value: unknown, expected: unknown): Promise<boolean>;
}
/** Only the pinned SDK's public methods reach the container. */
export interface CheckCommandBox {
  writeFile(path: string, content: string): Promise<{ success: boolean }>;
  startProcess(
    command: string,
    options: {
      processId: string;
      autoCleanup: boolean;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<unknown>;
  getProcess(id: string): Promise<{ status: string; exitCode?: number } | null>;
  exec(
    command: string,
    options: { timeout: number },
  ): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
}
/**
 * Prefix of every spool-read failure. A spool read is a short `node -e` inside a
 * container the check itself may saturate, so its failure is the container's
 * state, never the check's verdict.
 */
export const SPOOL_UNAVAILABLE = "check command spool unavailable";
export const isSpoolUnavailable = (error: unknown): boolean =>
  error instanceof Error && error.message.startsWith(SPOOL_UNAVAILABLE);
/** Per-attempt exec ceilings: a loaded container starts `node` slowly. Worst case 63 s per read. */
const SPOOL_READ_TIMEOUTS_MS = [10_000, 20_000, 30_000] as const;
const SPOOL_READ_PAUSE_MS = 1_000;
const Terminal = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  timedOut: Schema.Boolean,
  logExceeded: Schema.optional(Schema.Boolean),
  endedAt: Schema.Number,
});
const Intent = Schema.Struct({
  handle: CheckCommandHandle,
  launched: Schema.optional(Schema.Boolean),
  receipt: Schema.optional(ExecResultSchema),
  logs: CheckCommandLogState,
});
const emptyLogs: typeof CheckCommandLogState.Type = {
  stdoutOffset: 0,
  stderrOffset: 0,
  stdoutTail: "",
  stderrTail: "",
  chunks: [],
};
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const path = (h: CheckCommandHandle) => `/tmp/flare-check-${h.id}`;
export const commandSpool = path;
export async function commandFingerprint(
  command: string,
  cwd?: string,
  env: Record<string, string> = {},
  timeoutSec = 600,
  containerId = "",
  redactValues: readonly string[] = [],
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        command,
        cwd ?? "",
        Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        timeoutSec,
        containerId,
        [...new Set(redactValues.filter((value) => value.length > 0))],
      ]),
    ),
  );
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Node is present in the pinned SDK Dockerfile and the checked-in sandbox image. */
export function commandSupervisor(handle: CheckCommandHandle, command: string): string {
  return `const fs=require('node:fs'),{spawn,spawnSync}=require('node:child_process');
const dir=${JSON.stringify(path(handle))};fs.mkdirSync(dir,{recursive:true});
const out=fs.openSync(dir+'/stdout','a'),err=fs.openSync(dir+'/stderr','a');
const child=spawn('/bin/sh',['-lc',${JSON.stringify(command)}],{detached: true,stdio:['ignore','pipe','pipe'],env:process.env});
let timedOut=false,logExceeded=false,killTimer,bytes=0,cleanupComplete=false,closed=false,closeCode=null,closeSignal=null,endedAt;
const publish=()=>{if(!closed||(killTimer&&!cleanupComplete))return;const value={exitCode:closeCode,signal:closeSignal,timedOut,logExceeded,endedAt:endedAt??Date.now()};fs.writeFileSync(dir+'/terminal.tmp',JSON.stringify(value));fs.renameSync(dir+'/terminal.tmp',dir+'/terminal.json');process.exitCode=closeCode===null?1:closeCode;};
const groupAbsent=()=>{try{process.kill(-child.pid,0);return false}catch(error){if(error.code==='ESRCH')return true;throw error}};
const groupStopped=()=>{
if(process.platform==='darwin'){
const probe=spawnSync('/bin/ps',['-x','-g',String(child.pid),'-o','pgid=,state='],{encoding:'utf8',timeout:250,maxBuffer:1024*1024,env:{...process.env,COMMAND_MODE:'unix2003',LC_ALL:'C'}});
if(probe.error||probe.signal||typeof probe.stdout!=='string')throw new Error('process probe unavailable');
const text=probe.stdout.trim();
if(text===''){if((probe.status===0||probe.status===1)&&groupAbsent())return true;throw new Error('process probe incomplete')}
if(probe.status!==0)throw new Error('process probe failed');
const entries=text.split(String.fromCharCode(10));if(entries.length>65536)throw new Error('process probe exceeds bound');
let live=false;
for(const entry of entries){const fields=entry.trim().split(/ +/);if(fields.length!==2||!Number.isSafeInteger(Number(fields[0]))||Number(fields[0])!==child.pid||!/^([IRSTUZ])[A-Za-z+<>=-]*$/.test(fields[1]))throw new Error('invalid process probe');if(fields[1][0]!=='Z')live=true}
return !live}
if(process.platform!=='linux')return groupAbsent();const entries=fs.readdirSync('/proc');if(entries.length>65536)throw new Error('process probe exceeds bound');for(const pid of entries){if(!/^[0-9]+$/.test(pid))continue;let value;try{value=fs.readFileSync('/proc/'+pid+'/stat','utf8')}catch(error){if(error.code==='ENOENT'||error.code==='ESRCH')continue;throw error}const fields=value.slice(value.lastIndexOf(')')+2).split(' ');if(fields.length<3||!Number.isSafeInteger(Number(fields[2])))throw new Error('invalid process probe');if(Number(fields[2])===child.pid&&fields[0]!=='Z'&&fields[0]!=='X')return false}return true};
const failCleanup=()=>{process.exit(1)};
const stop=()=>{if(killTimer)return;try{if(groupStopped())return;process.kill(-child.pid,'SIGTERM')}catch(error){if(error.code!=='ESRCH'){failCleanup();return}}killTimer=setTimeout(async()=>{try{try{process.kill(-child.pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}const until=Date.now()+1000;for(;;){const stopped=groupStopped();if(Date.now()>=until)throw new Error('process group did not stop within cleanup bound');if(stopped)break;await new Promise(resolve=>setTimeout(resolve,10))}cleanupComplete=true;publish()}catch{failCleanup()}},1000)};
const capture=(fd,data)=>{const count=Math.min(data.length,Math.max(0,64*1024*1024-bytes));if(count)fs.writeSync(fd,data,0,count);bytes+=count;if(count<data.length){logExceeded=true;stop()}};
child.stdout.on('data',data=>capture(out,data));child.stderr.on('data',data=>capture(err,data));
const timer=setTimeout(()=>{timedOut=true;stop()},Math.max(0,${handle.deadline}-Date.now()));
child.on('exit',()=>{endedAt=Date.now();clearTimeout(timer);stop()});
child.on('close',(code,signal)=>{closed=true;closeCode=code;if(code===null&&signal){closeSignal=signal;closeCode=128+(require('node:os').constants.signals[signal]??0);fs.writeSync(err,'\\nflare-dispatch: check command terminated by '+signal+'\\n')}clearTimeout(timer);stop();publish()});`;
}

export function makeCheckCommandOwner(
  storage: CheckCommandStorage,
  box: CheckCommandBox,
  now = Date.now,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): CheckCommandOwner {
  const key = (h: CheckCommandHandle) => `check-command:${h.id}`;
  const load = async (raw: CheckCommandHandle) => {
    const h = Schema.decodeUnknownSync(CheckCommandHandle)(raw);
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(h.id) ||
      !Number.isSafeInteger(h.startedAt) ||
      !Number.isSafeInteger(h.deadline) ||
      h.deadline <= h.startedAt
    )
      throw new Error("invalid check command identity");
    const value = await storage.load(key(h));
    if (value === undefined) throw new Error("uncertain check command: no durable launch intent");
    const entry = Schema.decodeUnknownSync(Intent)(value);
    if (JSON.stringify(entry.handle) !== JSON.stringify(h))
      throw new Error("check command identity changed");
    return entry;
  };
  // The pinned SDK throws `ProcessNotFoundError` for an id its container never
  // started — what a recycled container answers — rather than returning null.
  const processOf = async (id: string) => {
    try {
      return await box.getProcess(id);
    } catch (error) {
      if (error instanceof Error && error.name === "ProcessNotFoundError") return null;
      throw error;
    }
  };
  const execJson = async (script: string): Promise<unknown> => {
    let reason = "";
    for (const [attempt, timeout] of SPOOL_READ_TIMEOUTS_MS.entries()) {
      if (attempt > 0) await pause(SPOOL_READ_PAUSE_MS * attempt);
      try {
        const result = await box.exec(`node -e ${quote(script)}`, { timeout });
        if (result.exitCode === 0) return JSON.parse(result.stdout);
        const stderr = (result.stderr ?? "").trim().slice(-200);
        reason = `exit ${result.exitCode}${stderr === "" ? "" : `: ${stderr}`}`;
      } catch (error) {
        reason = (error instanceof Error ? error.message : String(error)).slice(-200);
      }
    }
    throw new Error(`${SPOOL_UNAVAILABLE} (${reason})`);
  };
  return {
    async prepare(candidate) {
      const h = Schema.decodeUnknownSync(CheckCommandHandle)(candidate);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(h.id) || !Number.isSafeInteger(h.startedAt)
        || !Number.isSafeInteger(h.deadline) || h.deadline <= h.startedAt)
        throw new Error("invalid check command identity");
      if (await storage.reserve(key(h), { handle: h, launched: false, logs: emptyLogs })) return h;
      const entry = Schema.decodeUnknownSync(Intent)(await storage.load(key(h)));
      if (entry.handle.id !== h.id || entry.handle.container.id !== h.container.id
        || entry.handle.fingerprint !== h.fingerprint
        || entry.handle.deadline - entry.handle.startedAt !== h.deadline - h.startedAt)
        throw new Error("check command identity changed");
      return entry.handle;
    },
    async start(opts) {
      const h = Schema.decodeUnknownSync(CheckCommandHandle)(opts.handle);
      if (
        !/^[a-zA-Z0-9_-]{1,100}$/.test(h.id) ||
        !Number.isSafeInteger(h.startedAt) ||
        !Number.isSafeInteger(h.deadline) ||
        h.deadline <= h.startedAt
      )
        throw new Error("invalid check command identity");
      Schema.decodeUnknownSync(Schema.String)(opts.command);
      const env = Schema.decodeUnknownSync(
        Schema.Record({ key: Schema.String, value: Schema.String }),
      )(opts.env ?? {});
      if (
        h.fingerprint !==
        (await commandFingerprint(
          opts.command,
          opts.cwd,
          env,
          (h.deadline - h.startedAt) / 1000,
          h.container.id,
          Schema.decodeUnknownSync(Schema.Array(Schema.String))(opts.redactValues ?? []),
        ))
      )
        throw new Error("check command identity changed");
      const claimed = await storage.reserve(key(h), { handle: h, launched: true, logs: emptyLogs });
      if (!claimed) {
        const entry = await load(h);
        if (entry.receipt !== undefined) return;
        // An absent flag is an existing launch intent from an earlier schema.
        // A recorded launch is never launched again under this handle. If its
        // process is gone — the container recycled after `startProcess`
        // reached it — `observe` reports `missing`, and the run relaunches
        // under a new identity in a destroyed container.
        if (entry.launched !== false) return;
        if (!(await storage.save(key(h), { ...entry, launched: true }, entry)))
          throw new Error("check command launch reservation changed concurrently");
      }
      if (now() >= h.deadline) throw new Error("check command deadline expired before launch");
      const file = `${path(h)}.cjs`;
      const written = await box.writeFile(file, commandSupervisor(h, opts.command));
      if (!written.success) throw new Error("check command supervisor could not be written");
      await box.startProcess(`node ${quote(file)}`, {
        processId: h.id,
        autoCleanup: false,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
    },
    async observe(h) {
      const entry = await load(h);
      if (entry.receipt !== undefined)
        return {
          state: "exited",
          exitCode: entry.receipt.exitCode,
          durationMs: entry.receipt.durationMs,
        };
      const proc = await processOf(h.id);
      if (proc === null) return { state: "missing" };
      if (proc.status === "running" || proc.status === "starting")
        return { state: now() >= h.deadline + 1500 ? "timeout" : "running" };
      // A process that ended without publishing — its supervisor killed with
      // the container — leaves no record, and no exit status to report.
      // An unreadable spool is not that loss: the process ended and its record
      // may exist, so the read fails the observation and the step's retries
      // re-read it. Reporting `missing` would relaunch over a real verdict.
      const spool = await execJson(
        `const fs=require('node:fs'),p=${JSON.stringify(path(h) + "/terminal.json")};process.stdout.write(fs.existsSync(p)?fs.readFileSync(p,'utf8'):'null')`,
      );
      const terminal = Schema.decodeUnknownSync(Schema.NullOr(Terminal))(spool);
      if (terminal === null) return { state: "missing" };
      if (terminal.logExceeded)
        throw new Error("check command output exceeds bounded spool; no verdict published");
      if (terminal.timedOut || terminal.endedAt > h.deadline) return { state: "timeout" };
      if (
        terminal.exitCode === null ||
        !Number.isInteger(terminal.exitCode) ||
        terminal.exitCode !== proc.exitCode
      )
        return { state: "missing" };
      return Schema.decodeUnknownSync(CheckCommandObservation)({
        state: "exited",
        exitCode: terminal.exitCode,
        durationMs: terminal.endedAt - h.startedAt,
      });
    },
    async read(h, stream, offset, length) {
      await load(h);
      Schema.decodeUnknownSync(Schema.Literal("stdout", "stderr"))(stream);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 1 ||
        length > 65536
      )
        throw new Error("invalid bounded check log read");
      return Schema.decodeUnknownSync(CheckCommandChunk)(
        await execJson(
          `const fs=require('node:fs'),p=${JSON.stringify(path(h) + "/" + stream)};if(!fs.existsSync(p)){process.stdout.write(JSON.stringify({text:'',bytes:0}))}else{const f=fs.openSync(p,'r'),b=Buffer.alloc(${length}+4),n=fs.readSync(f,b,0,b.length,${offset});fs.closeSync(f);let end=Math.min(n,${length});if(end<n){while(end>0&&(b[end]&192)===128)end--;}process.stdout.write(JSON.stringify({text:b.subarray(0,end).toString('utf8'),bytes:end}))}`,
        ),
      );
    },
    async logs(h) {
      return (await load(h)).logs;
    },
    async advanceLogs(h, expected, next) {
      const entry = await load(h);
      if (JSON.stringify(entry.logs) !== JSON.stringify(expected))
        throw new Error("check log progress changed concurrently");
      if (
        !(await storage.save(
          key(h),
          { ...entry, logs: Schema.decodeUnknownSync(CheckCommandLogState)(next) },
          entry,
        ))
      )
        throw new Error("check log progress changed concurrently");
    },
    async receipt(h) {
      return (await load(h)).receipt;
    },
    async finish(h, result) {
      const entry = await load(h);
      if (entry.receipt !== undefined) return entry.receipt;
      const status = await this.observe(h);
      if (
        status.state !== "exited" ||
        status.exitCode !== result.exitCode ||
        status.durationMs !== result.durationMs
      )
        throw new Error("check command has no matching actual exit receipt");
      const receipt: ExecResult = Schema.decodeUnknownSync(ExecResultSchema)(result);
      if (!(await storage.save(key(h), { ...entry, receipt }, entry))) {
        const current = await load(h);
        if (current.receipt !== undefined) return current.receipt;
        throw new Error("check command receipt changed concurrently");
      }
      return receipt;
    },
  };
}
