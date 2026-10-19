// FlareDispatch Dispatcher — the log-viewing surfaces.
//
//   GET /v1/executions/:id/logs/<file> — one log file (ndjson | ?format=text)
//   GET /v1/executions/:id/logs        — every log, in reading order, as text
//   GET /logs/:execution               — the self-contained HTML viewer
//
// All three are capability-token-gated (log-auth.ts). The full, untruncated
// log of every command already lives in R2 under `logs/<id>/`, named by the
// shared grammar (runtime-cf log-names.ts): sandbox exec logs and durable
// check-command chunks with their consolidated log. These routes are the read side,
// replacing the truncated, JSON-escaped blob the Cloudflare Workflows instance
// explorer shows. The HTML viewer follows the routes/replay.ts precedent: one
// self-contained page from the worker's own origin, no build step, no CDN —
// and it renders attacker-controlled log bytes safely (textContent only, ANSI
// control sequences stripped, strict CSP — review M5).

import { Effect, Option } from "effect";
import { logSections, parseLogFile } from "@fractalboxdev/flare-dispatch-runtime-cf/log-names";

import type { Env } from "../env";
import { isTerminal } from "../executions-read";
import { gateLogAccess } from "../log-auth";
import { CurrentEnv, ExecutionsRead } from "../ports";
import { logKey, streamObject } from "../r2-object";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Immutable once the execution is terminal; never cache a running run's logs. */
const cacheFor = (terminal: boolean): string =>
  terminal ? "private, max-age=31536000, immutable" : "no-store";

// ---------------------------------------------------------------------------
// NDJSON → text transform (streaming, never buffers the whole log)
// ---------------------------------------------------------------------------

/** One parsed NDJSON log record. */
type LogRecord = {
  readonly stream?: string;
  readonly command?: string;
  readonly line?: string;
};

/**
 * Render one NDJSON log record as a plain-text line (with trailing newline), or
 * `null` to drop it. `meta` → `$ <command>`, `stdout` → the bare line, `stderr`
 * → `[stderr] <line>`. Exported for unit tests.
 */
export const recordToText = (rec: LogRecord): string | null => {
  switch (rec.stream) {
    case "meta":
      return `$ ${rec.command ?? ""}\n`;
    case "stdout":
      return `${rec.line ?? ""}\n`;
    case "stderr":
      return `[stderr] ${rec.line ?? ""}\n`;
    default:
      return null;
  }
};

/**
 * Decide whether an exec-log section is "housekeeping" — an internal probe the
 * orchestrator emits (poll a `.done`/`.err` sentinel, `pkill`/`mkdir` setup)
 * that carries no signal for a human reading the run. The demo runner alone
 * emits dozens of these per run (`cat …/play-0.done` → `DONE:0`, …); surfacing
 * them as headline sections, each titled by its meaningless `exec-N.ndjson`
 * filename, buries the few records that matter (the narrative JSON, the gif
 * outputs, the summary table).
 *
 * Signal = any stdout/stderr line that isn't a bare `DONE:<n>` sentinel. A
 * section with real output is always kept; one with only sentinels (or no
 * output) is housekeeping iff its command is a known probe/setup shape.
 *
 * `command` is the meta line's command (without the leading `$ `); `outputs`
 * are the rendered stdout/stderr text lines (meta excluded). Exported for unit
 * tests, and inlined verbatim into the viewer script via `.toString()` so the
 * classifier has exactly one definition.
 */
export const isHousekeeping = (command: string, outputs: readonly string[]): boolean => {
  const hasSignal = outputs.some((l) => {
    const t = l.trim();
    return t !== "" && !/^DONE:\d+$/.test(t);
  });
  if (hasSignal) return false;
  const c = command.trim();
  return (
    /\bcat\b[^|]*\.(done|err|out)\b/.test(c) || // poll a sentinel / empty capture
    /(^|;|\s)pkill\b/.test(c) ||
    /(^|;|\s)mkdir\b/.test(c) ||
    c === ""
  );
};

/**
 * A `TransformStream` that turns an NDJSON byte stream into plain-text bytes,
 * line-buffered so a chunk boundary mid-line is handled. Used for `?format=text`.
 */
export const makeNdjsonTextTransform = (): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const flushLine = (
    rawLine: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return;
    let rec: LogRecord;
    try {
      rec = JSON.parse(trimmed) as LogRecord;
    } catch {
      // A non-JSON line (corrupt / partial flush) is surfaced verbatim rather
      // than dropped — better to show the bytes than hide them.
      controller.enqueue(encoder.encode(`${rawLine}\n`));
      return;
    }
    const text = recordToText(rec);
    if (text !== null) controller.enqueue(encoder.encode(text));
  };

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) flushLine(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer.length > 0) flushLine(buffer, controller);
    },
  });
};

// ---------------------------------------------------------------------------
// GET /v1/executions/:id/logs/:file
// ---------------------------------------------------------------------------

export const handleLogFile = (
  executionId: string,
  file: string,
  url: URL,
): Effect.Effect<Response, never, CurrentEnv | ExecutionsRead> =>
  Effect.gen(function* () {
    const env = yield* CurrentEnv;
    const denied = yield* Effect.promise(() => gateLogAccess(env, executionId, url));
    if (denied !== null) return denied;

    if (parseLogFile(file) === null) {
      return json({ error: "invalid_log_file", message: `not a log file name: "${file}"` }, 400);
    }

    const reads = yield* ExecutionsRead;
    const rowOpt = yield* reads.get(executionId);
    const status = Option.match(rowOpt, {
      onNone: () => undefined,
      onSome: (row) => row.status,
    });
    const cacheControl = cacheFor(isTerminal(status));
    const format = url.searchParams.get("format") ?? "ndjson";

    if (format === "text") {
      const object = yield* Effect.promise(() => env.RUNS_STORAGE.get(logKey(executionId, file)));
      if (object === null) {
        return json({ error: "log_not_found", message: file }, 404);
      }
      const body = object.body.pipeThrough(makeNdjsonTextTransform());
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": cacheControl,
          "x-content-type-options": "nosniff",
        },
      });
    }

    const res = yield* Effect.promise(() =>
      streamObject(env.RUNS_STORAGE, logKey(executionId, file), {
        contentType: "application/x-ndjson",
        cacheControl,
        nosniff: true,
      }),
    );
    return res ?? json({ error: "log_not_found", message: file }, 404);
  });

// ---------------------------------------------------------------------------
// GET /v1/executions/:id/logs  — aggregated plain-text roll-up
// ---------------------------------------------------------------------------

export const handleLogsAggregate = (
  executionId: string,
  url: URL,
): Effect.Effect<Response, never, CurrentEnv | ExecutionsRead> =>
  Effect.gen(function* () {
    const env = yield* CurrentEnv;
    const denied = yield* Effect.promise(() => gateLogAccess(env, executionId, url));
    if (denied !== null) return denied;

    const listed = yield* Effect.promise(() =>
      env.RUNS_STORAGE.list({
        prefix: `logs/${executionId}/`,
        limit: 1000,
      }),
    );
    const files = logSections(
      listed.objects.map((o) => ({
        file: o.key.slice(`logs/${executionId}/`.length),
        uploaded: o.uploaded.getTime(),
      })),
    ).flatMap((section) => section.files);

    if (files.length === 0) {
      return json({ error: "no_logs", message: `no logs for execution "${executionId}"` }, 404);
    }

    const reads = yield* ExecutionsRead;
    const rowOpt = yield* reads.get(executionId);
    const status = Option.match(rowOpt, {
      onNone: () => undefined,
      onSome: (row) => row.status,
    });
    const cacheControl = cacheFor(isTerminal(status));
    const encoder = new TextEncoder();

    // Stream each file sequentially through the text transform, with a separator
    // header per file. Never buffers a whole log in memory.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const file of files) {
          controller.enqueue(encoder.encode(`\n===== ${file} =====\n`));
          const object = await env.RUNS_STORAGE.get(logKey(executionId, file));
          if (object === null) continue;
          const reader = object.body.pipeThrough(makeNdjsonTextTransform()).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        }
        controller.close();
      },
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
      },
    });
  });

// ---------------------------------------------------------------------------
// GET /logs/:execution  — the HTML viewer
// ---------------------------------------------------------------------------

export const handleLogViewer = async (
  env: Env,
  executionId: string,
  url: URL,
): Promise<Response> => {
  const denied = await gateLogAccess(env, executionId, url);
  if (denied !== null) return denied;

  // A per-response nonce lets the inline script/style run under a strict CSP
  // while injected scripts are blocked. All log content is inserted via
  // textContent — no log bytes ever reach an HTML/script context.
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const html = viewerPage(nonce);
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
    },
  });
};

/**
 * The viewer page. Data is NOT inlined (logs are large) — the page reads the
 * execution id + token from its own URL and fetches the JSON/NDJSON routes.
 * Everything dynamic is set via `textContent`; ANSI control bytes are stripped.
 */
const viewerPage = (nonce: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FlareDispatch logs</title>
<style nonce="${nonce}">
  /* Palette mirrors the FlareDispatch docs site (flare-dispatch-docs.pages.dev),
     dark theme — Vitesse-style warm ink on near-black "paper", coral accent. */
  :root{
    color-scheme:dark;
    --paper:#0a0a0f; --paper-soft:#11121a; --surface:#13141b;
    --ink:#eae7dd; --ink-soft:#b8b6ac; --muted:#7a7d8c; --muted-soft:#51545f;
    --hairline:#23252e; --hairline-strong:#353846;
    --accent:#ff7041; --accent-soft:#2b1810;
    --wait:#8ba0cf; --wait-soft:#222a3d; --ok:#4d9375; --err:#cb7676;
    --mono:"Berkeley Mono","Iosevka Web","SF Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  html,body{margin:0;background:var(--paper);color:var(--ink);font:13px/1.5 var(--mono)}
  header{padding:10px 16px;border-bottom:1px solid var(--hairline);position:sticky;top:0;background:var(--paper);z-index:1}
  header .title{font-size:14px}
  header b{color:var(--accent)}
  .meta{color:var(--muted);font-size:12px;margin-top:4px}
  .meta a{color:var(--accent);text-decoration:none}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .badge.running,.badge.queued{background:var(--wait-soft,#222a3d);color:var(--wait)}
  .badge.success{background:#4d937522;color:var(--ok)}
  .badge.failure{background:#cb767622;color:var(--err)}
  .controls{padding:8px 16px;border-bottom:1px solid var(--hairline);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  .controls input[type=search]{background:var(--surface);border:1px solid var(--hairline-strong);color:var(--ink);border-radius:6px;padding:4px 8px;min-width:220px;font-family:inherit}
  .controls label{color:var(--muted);font-size:12px;user-select:none}
  details{border-bottom:1px solid var(--hairline)}
  details.housekeeping{display:none}
  details.housekeeping summary{background:var(--paper)}
  details.housekeeping summary .cmd{color:var(--ink-soft)}
  body.show-housekeeping details.housekeeping{display:block}
  summary{cursor:pointer;padding:8px 16px;background:var(--paper-soft);list-style:none;position:sticky;top:96px;display:flex;align-items:baseline;gap:8px}
  summary::-webkit-details-marker{display:none}
  /* The command that ran is the section's identity — the exec-N.ndjson
     filename is an internal artifact and carries no signal, so it's demoted to
     a muted suffix. Long commands ellipsize rather than wrap the summary. */
  summary .cmd{color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
  summary .sz{color:var(--muted);font-size:11px;flex:none}
  summary .fn{color:var(--muted-soft);font-size:11px;flex:none}
  .log{padding:4px 0;overflow-x:auto}
  .ln{display:flex;white-space:pre;padding:0 16px}
  .ln:hover{background:var(--surface)}
  .ln .n{color:var(--muted-soft);text-align:right;min-width:48px;padding-right:12px;user-select:none}
  .ln.err .t{color:var(--err)}
  .empty{padding:24px 16px;color:var(--muted)}
  #status{padding:6px 16px;color:var(--muted);font-size:12px}
  /* flame chart / trace waterfall — one row per step, bar width ∝ duration,
     x-offset ∝ start time so concurrent steps reveal their overlap. */
  .flame{padding:8px 16px 12px;border-bottom:1px solid var(--hairline)}
  .flame .axis{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin:0 0 6px 176px;border-bottom:1px solid var(--hairline);padding-bottom:3px}
  .flame .row{display:grid;grid-template-columns:168px 1fr;align-items:center;gap:8px;height:20px}
  .flame .row:hover{background:var(--surface)}
  .flame .lbl2{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
  .flame .lbl2 .nm{color:var(--ink-soft);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .flame .lbl2 .du{color:var(--muted);font-size:11px;flex:none;font-variant-numeric:tabular-nums}
  .flame .track{position:relative;height:14px}
  .flame .bar{position:absolute;top:0;height:14px;border-radius:3px;min-width:3px;background:var(--muted);opacity:.9}
  .flame .row.success .bar{background:var(--ok)}
  .flame .row.failure .bar{background:var(--err)}
  .flame .row.running .bar{background:var(--wait)}
  .summary{padding:8px 16px;border-bottom:1px solid var(--hairline)}
  .summary .verdict{font-weight:600;color:var(--ok)}
  .summary details{border:none}
  .summary summary{position:static;background:none;padding:0;top:auto;color:var(--muted);font-size:12px;cursor:pointer}
  .summary pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;background:var(--paper-soft);border:1px solid var(--hairline);border-radius:6px;padding:8px;max-height:240px;overflow:auto;font-size:12px}
  /* Artifacts are a scrollable rows list (one file per row), not a wrapping
     chip strip — a run can produce many files and the row layout keeps name,
     size, and the raw link aligned in columns. */
  .arts{display:block;padding:8px 16px;border-bottom:1px solid var(--hairline)}
  .arts .lbl{color:var(--muted);font-size:12px;display:block;margin-bottom:6px}
  .arts-list{display:flex;flex-direction:column;gap:4px;max-height:200px;overflow:auto}
  .art{display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--hairline-strong);border-radius:6px;padding:4px 8px 4px 10px;font-size:12px}
  .art.active{border-color:var(--accent);background:var(--accent-soft)}
  .art-name{background:none;border:none;color:var(--accent);font-family:inherit;font-size:12px;cursor:pointer;padding:0;flex:1 1 auto;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .art-name:hover{text-decoration:underline}
  .art-sz{color:var(--muted);font-size:11px;flex:none;font-variant-numeric:tabular-nums}
  .art-raw{color:var(--muted);text-decoration:none;font-size:12px;line-height:1;padding:0 3px;border-radius:4px;flex:none}
  .art-raw:hover{color:var(--accent)}
  /* GitHub-style inline file viewer for a clicked artifact. */
  .artview{border-bottom:1px solid var(--hairline);background:var(--paper-soft)}
  .artview-bar{display:flex;align-items:center;gap:8px;padding:6px 16px;border-bottom:1px solid var(--hairline)}
  .artview-name{color:var(--accent);font-size:12px;font-weight:600;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .artview-act{color:var(--ink-soft);font-size:12px;text-decoration:none;background:var(--surface);border:1px solid var(--hairline-strong);border-radius:6px;padding:2px 8px;cursor:pointer;font-family:inherit;line-height:1.4}
  .artview-act:hover{border-color:var(--accent);color:var(--accent)}
  .artview-body{max-height:60vh;overflow:auto}
  .artview-img{display:block;max-width:100%;height:auto;margin:12px 16px;background:#fff;border-radius:4px}
</style></head>
<body>
<header>
  <div class="title"><b>FlareDispatch</b> logs · <span id="run"></span></div>
  <div class="meta" id="sub"></div>
</header>
<div id="summary" class="summary" hidden></div>
<div id="artifacts" class="arts" hidden></div>
<div id="artview" class="artview" hidden></div>
<div id="steps" class="flame" hidden></div>
<div class="controls">
  <input type="search" id="filter" placeholder="filter lines…" autocomplete="off">
  <label><input type="checkbox" id="stderrOnly"> stderr only</label>
  <label><input type="checkbox" id="showHousekeeping"> <span id="hkLabel">housekeeping</span></label>
  <span id="status"></span>
</div>
<div id="sections"><div class="empty">Loading…</div></div>
<script nonce="${nonce}">
"use strict";
(function(){
  var parts = location.pathname.split("/").filter(Boolean); // ["logs", id]
  var id = decodeURIComponent(parts[parts.length - 1] || "");
  var t = new URLSearchParams(location.search).get("t") || "";
  var qs = "?t=" + encodeURIComponent(t);
  var API = "/v1/executions/" + encodeURIComponent(id);
  var sectionsEl = document.getElementById("sections");
  var statusEl = document.getElementById("status");
  var files = {}; // file -> { section, body, cmdEl, lines:[{text,err}], finalized, housekeeping }

  // Shared with the server module so the heuristic has exactly one definition.
  var isHousekeeping = ${isHousekeeping.toString()};

  // Strip ANSI/control sequences; render is ALWAYS via textContent so log
  // bytes can never become markup (the viewer renders attacker-controlled
  // output — see the route's CSP + this defence).
  function clean(s){
    return String(s == null ? "" : s)
      .replace(/\\u001b\\[[0-9;?]*[ -\\/]*[@-~]/g, "")
      .replace(/[\\u0000-\\u0008\\u000b-\\u001f]/g, "");
  }
  function badge(st){
    var b = document.createElement("span");
    b.className = "badge " + (st || "");
    b.textContent = st || "?";
    return b;
  }
  function setHeader(ex){
    document.getElementById("run").textContent =
      ex.run + " · " + ex.repo + "@" + (ex.sha||"").slice(0,12);
    var sub = document.getElementById("sub");
    sub.textContent = "";
    sub.appendChild(badge(ex.status));
    var dur = (ex.completedAt && ex.startedAt)
      ? " · " + Math.round((ex.completedAt-ex.startedAt)/1000) + "s" : "";
    sub.appendChild(document.createTextNode(" " + ex.id + dur + " "));
    if (ex.dashboardUrl){
      var a=document.createElement("a");
      a.href=ex.dashboardUrl; a.textContent="Cloudflare ↗"; a.rel="noreferrer";
      sub.appendChild(a);
    }
  }
  // Render the D1 step timeline as a flame chart / trace waterfall — a run's
  // shape even when it has sparse exec logs (e.g. a mostly-Worker-side run like
  // pr-review: one container exec, the rest model/GitHub calls). Each row's bar
  // is positioned by its start offset and sized by its duration, so the slow
  // steps read at a glance and concurrent steps reveal their overlap — far more
  // legible than equal-width chips that hid relative cost.
  function fmtMs(ms){ return ms >= 1000 ? (ms/1000).toFixed(ms < 10000 ? 1 : 0) + "s" : Math.round(ms) + "ms"; }
  function renderSteps(steps){
    var el = document.getElementById("steps");
    if (!steps || !steps.length){ el.hidden = true; return; }
    var now = Date.now();
    var started = steps.filter(function(s){ return s.startedAt; });
    if (!started.length){ el.hidden = true; return; }
    // The run window: earliest start → latest end (a running step ends "now").
    var t0 = Infinity, t1 = -Infinity;
    started.forEach(function(s){
      if (s.startedAt < t0) t0 = s.startedAt;
      var end = s.completedAt || now;
      if (end > t1) t1 = end;
    });
    var total = Math.max(t1 - t0, 1);
    el.hidden = false; el.textContent = "";

    var axis = document.createElement("div"); axis.className = "axis";
    var a0 = document.createElement("span"); a0.textContent = "0";
    var a1 = document.createElement("span"); a1.textContent = fmtMs(total);
    axis.appendChild(a0); axis.appendChild(a1);
    el.appendChild(axis);

    var ordered = started.slice().sort(function(a,b){
      return (a.startedAt - b.startedAt) || ((a.completedAt||now) - (b.completedAt||now));
    });
    ordered.forEach(function(s){
      var end = s.completedAt || now;
      var dur = end - s.startedAt;
      var leftPct = ((s.startedAt - t0) / total) * 100;
      var widthPct = ((end - s.startedAt) / total) * 100;

      var row = document.createElement("div"); row.className = "row " + (s.status||"");
      var lbl = document.createElement("div"); lbl.className = "lbl2";
      var nm = document.createElement("span"); nm.className = "nm"; nm.textContent = s.name;
      var du = document.createElement("span"); du.className = "du";
      du.textContent = s.completedAt ? fmtMs(dur) : "…";
      lbl.appendChild(nm); lbl.appendChild(du);

      var track = document.createElement("div"); track.className = "track";
      var bar = document.createElement("div"); bar.className = "bar";
      bar.style.left = leftPct.toFixed(3) + "%";
      bar.style.width = Math.max(widthPct, 0).toFixed(3) + "%";
      bar.title = s.name + " · " + (s.completedAt ? fmtMs(dur) : "running") +
        " · start +" + fmtMs(s.startedAt - t0);
      track.appendChild(bar);

      row.appendChild(lbl); row.appendChild(track);
      el.appendChild(row);
    });
  }
  // Render the run's own terminal output (run-agnostic): a verdict badge when
  // present, plus a collapsible pretty-printed JSON. Always via textContent.
  function renderSummary(summary){
    var el = document.getElementById("summary");
    if (summary == null || typeof summary !== "object"){ el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    if (typeof summary.verdict === "string"){
      var v = document.createElement("span"); v.className = "verdict";
      v.textContent = "verdict: " + clean(summary.verdict);
      el.appendChild(v); el.appendChild(document.createTextNode("  "));
    }
    var det = document.createElement("details");
    var sm = document.createElement("summary"); sm.textContent = "run summary (JSON)";
    var pre = document.createElement("pre");
    try { pre.textContent = JSON.stringify(summary, null, 2); }
    catch(e){ pre.textContent = String(summary); }
    det.appendChild(sm); det.appendChild(pre); el.appendChild(det);
  }
  // Render the run's PRODUCED FILES — what it explicitly uploaded as artifacts
  // to R2 (a report, a video, the captured diff). These are the right surface
  // for "files the run wrote": persisted by opt-in, served (and browsable) at
  // /v1/artifacts/:id/:name. Container scratch files are NOT here by design —
  // the container is destroyed at run end.
  var lastArts = [];   // most recent artifact list (re-render keeps active state)
  var activeArt = null; // name of the artifact open in the inline viewer
  var TEXT_EXT = {md:1,txt:1,log:1,json:1,ndjson:1,jsonl:1,patch:1,diff:1,yaml:1,yml:1,toml:1,csv:1,tsv:1,xml:1,html:1,htm:1,js:1,mjs:1,cjs:1,ts:1,tsx:1,jsx:1,css:1,sh:1,bash:1,zsh:1,py:1,rb:1,rs:1,go:1,java:1,c:1,h:1,cpp:1,sql:1,env:1,ini:1,conf:1,cfg:1,lock:1,gitignore:1};
  var IMG_EXT = {png:1,jpg:1,jpeg:1,gif:1,webp:1,avif:1,svg:1,ico:1,bmp:1};
  function fileExt(name){ var m = /\\.([A-Za-z0-9]+)$/.exec(name); return m ? m[1].toLowerCase() : ""; }
  function fmtBytes(n){
    if (n == null) return "";
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n/1024).toFixed(1) + " KB";
    return (n/1048576).toFixed(1) + " MB";
  }
  function isTextual(ext, ct){
    if (TEXT_EXT[ext]) return true;
    if (!ct) return false;
    return /^text\\//.test(ct) || /(json|xml|javascript|csv|yaml|x-ndjson|x-sh|plain)/.test(ct);
  }
  // The artifacts strip — clicking a name opens the file inline (GitHub-style),
  // the ↗ opens the raw bytes in a new tab. These are the run's PRODUCED FILES
  // (a report, a screenshot, the captured diff), persisted to R2 and served at
  // /v1/artifacts/:id/:name; the endpoint is same-origin so the inline fetch /
  // <img> work under the page's strict CSP (connect-src/img-src 'self').
  function renderArtifacts(arts){
    lastArts = arts || [];
    var el = document.getElementById("artifacts");
    if (!arts || !arts.length){ el.hidden = true; return; }
    el.hidden = false; el.textContent = "";
    var lbl = document.createElement("span"); lbl.className = "lbl";
    lbl.textContent = "artifacts (" + arts.length + ")";
    el.appendChild(lbl);
    var list = document.createElement("div"); list.className = "arts-list";
    arts.forEach(function(a){
      var row = document.createElement("div");
      row.className = "art" + (activeArt === a.name ? " active" : "");
      var name = document.createElement("button");
      name.type = "button"; name.className = "art-name"; name.textContent = a.name;
      name.title = a.name;
      name.addEventListener("click", function(){ openArtifact(a); });
      row.appendChild(name);
      if (a.size != null){
        var sz = document.createElement("span"); sz.className = "art-sz"; sz.textContent = fmtBytes(a.size);
        row.appendChild(sz);
      }
      var raw = document.createElement("a"); raw.className = "art-raw";
      raw.href = a.url; raw.target = "_blank"; raw.rel = "noreferrer";
      raw.title = "open raw in new tab"; raw.textContent = "↗";
      row.appendChild(raw);
      list.appendChild(row);
    });
    el.appendChild(list);
  }
  function artNotice(body, a, msg){
    var box = document.createElement("div"); box.className = "empty";
    box.appendChild(document.createTextNode(msg + " "));
    var raw = document.createElement("a"); raw.className = "art-raw";
    raw.href = a.url; raw.target = "_blank"; raw.rel = "noreferrer"; raw.textContent = "open raw ↗";
    box.appendChild(raw);
    body.appendChild(box);
  }
  // Render textual content with line numbers, mirroring the log view. Always
  // via textContent + clean() — artifact bytes are attacker-controlled too.
  function renderCode(body, txt){
    var rows = txt.split("\\n");
    if (rows.length && rows[rows.length-1] === "") rows.pop();
    if (rows.length === 0){
      var e = document.createElement("div"); e.className = "empty"; e.textContent = "(empty file)";
      body.appendChild(e); return;
    }
    var logEl = document.createElement("div"); logEl.className = "log";
    for (var i=0;i<rows.length;i++){
      var ln = document.createElement("div"); ln.className = "ln";
      var n = document.createElement("span"); n.className = "n"; n.textContent = String(i+1);
      var tt = document.createElement("span"); tt.className = "t"; tt.textContent = clean(rows[i]);
      ln.appendChild(n); ln.appendChild(tt); logEl.appendChild(ln);
    }
    body.appendChild(logEl);
  }
  function closeArtifact(){
    activeArt = null;
    var v = document.getElementById("artview"); v.hidden = true; v.textContent = "";
    renderArtifacts(lastArts);
  }
  function openArtifact(a){
    if (activeArt === a.name){ closeArtifact(); return; } // toggle off
    activeArt = a.name;
    renderArtifacts(lastArts);
    var v = document.getElementById("artview"); v.hidden = false; v.textContent = "";

    var bar = document.createElement("div"); bar.className = "artview-bar";
    var nm = document.createElement("span"); nm.className = "artview-name"; nm.textContent = a.name;
    bar.appendChild(nm);
    var raw = document.createElement("a"); raw.className = "artview-act";
    raw.href = a.url; raw.target = "_blank"; raw.rel = "noreferrer"; raw.textContent = "raw ↗";
    var dl = document.createElement("a"); dl.className = "artview-act";
    dl.href = a.url; dl.setAttribute("download", a.name); dl.textContent = "download";
    var close = document.createElement("button"); close.type = "button"; close.className = "artview-act";
    close.textContent = "✕"; close.title = "close"; close.addEventListener("click", closeArtifact);
    bar.appendChild(raw); bar.appendChild(dl); bar.appendChild(close);
    v.appendChild(bar);

    var body = document.createElement("div"); body.className = "artview-body";
    var loading = document.createElement("div"); loading.className = "empty"; loading.textContent = "Loading " + a.name + "…";
    body.appendChild(loading); v.appendChild(body);

    var ext = fileExt(a.name);
    if (IMG_EXT[ext]){
      var img = new Image(); img.className = "artview-img"; img.alt = a.name;
      img.onload = function(){ body.textContent = ""; body.appendChild(img); };
      img.onerror = function(){ body.textContent = ""; artNotice(body, a, "Couldn't load this image inline."); };
      img.src = a.url;
      return;
    }
    var MAX_INLINE = 2 * 1024 * 1024;
    if (a.size != null && a.size > MAX_INLINE){
      body.textContent = "";
      artNotice(body, a, "File is large (" + fmtBytes(a.size) + ") — inline preview skipped.");
      return;
    }
    fetch(a.url).then(function(r){
      var ct = (r.headers.get("content-type") || "").toLowerCase();
      return r.text().then(function(txt){ return { ct: ct, txt: txt }; });
    }).then(function(res){
      if (activeArt !== a.name) return; // user moved on while it loaded
      body.textContent = "";
      if (isTextual(ext, res.ct)) renderCode(body, res.txt);
      else artNotice(body, a, "This file type can't be previewed inline.");
    }).catch(function(e){
      if (activeArt !== a.name) return;
      body.textContent = "";
      var er = document.createElement("div"); er.className = "empty"; er.textContent = "Failed to load: " + e.message;
      body.appendChild(er);
    });
  }
  function applyFilter(){
    var q = document.getElementById("filter").value.toLowerCase();
    var errOnly = document.getElementById("stderrOnly").checked;
    for (var f in files){
      var rec = files[f];
      var els = rec.body.querySelectorAll(".ln");
      for (var i=0;i<rec.lines.length;i++){
        var ll = rec.lines[i];
        var show = (!errOnly || ll.err) && (q==="" || ll.text.toLowerCase().indexOf(q)>=0);
        if (els[i]) els[i].style.display = show ? "" : "none";
      }
    }
  }
  function renderInto(rec, ndjson){
    var logEl = document.createElement("div"); logEl.className = "log";
    var lines = [];
    var outputs = [];       // stdout/stderr only — fed to the housekeeping classifier
    var command = "";       // the meta line's command, drives the section title
    var rows = ndjson.split("\\n");
    var num = 0;
    for (var i=0;i<rows.length;i++){
      var raw = rows[i].trim(); if (!raw) continue;
      var parsed; try { parsed = JSON.parse(raw); } catch(e){ parsed = { stream:"stdout", line: rows[i] }; }
      var text, err=false;
      // The meta line's command becomes the SECTION TITLE (set below) — don't
      // ALSO render it as the first body line, which duplicated "$ <command>"
      // (once as the title, once as line 1). writeLog emits exactly one meta
      // per file, so the body is purely the command's stdout/stderr output.
      if (parsed.stream==="meta"){ command = clean(parsed.command); continue; }
      else if (parsed.stream==="stderr"){ text = clean(parsed.line); err=true; outputs.push(text); }
      else if (parsed.stream==="stdout"){ text = clean(parsed.line); outputs.push(text); }
      else continue;
      num++;
      var ln = document.createElement("div"); ln.className = "ln" + (err?" err":"");
      var n = document.createElement("span"); n.className="n"; n.textContent = String(num);
      var tt = document.createElement("span"); tt.className="t"; tt.textContent = text;
      ln.appendChild(n); ln.appendChild(tt); logEl.appendChild(ln);
      lines.push({ text: text, err: err });
    }
    rec.body.innerHTML = "";
    if (lines.length===0){
      var e=document.createElement("div"); e.className="empty"; e.textContent="(no output)";
      rec.body.appendChild(e);
    } else rec.body.appendChild(logEl);
    rec.lines = lines;
    // Promote the command to the section title; classify as housekeeping so the
    // probe/setup noise collapses by default. Signal sections open automatically.
    if (command){ rec.cmdEl.textContent = "$ " + command; rec.cmdEl.title = "$ " + command; }
    rec.housekeeping = isHousekeeping(command, outputs);
    rec.section.classList.toggle("housekeeping", rec.housekeeping);
    rec.section.open = !rec.housekeeping;
  }
  function ensureSection(l){
    var rec = files[l.id];
    if (rec){ rec.szEl.textContent = (l.size/1024).toFixed(1)+" KB"; return rec; }
    var det = document.createElement("details");
    det.id = l.id;
    var sum = document.createElement("summary");
    // Title is the COMMAND once the log is fetched; until then fall back to the
    // filename. The filename is demoted to a muted suffix (still the deep-link
    // anchor via det.id) since it carries no signal on its own.
    var cmd = document.createElement("span"); cmd.className="cmd"; cmd.textContent = l.id;
    var sz = document.createElement("span"); sz.className="sz"; sz.textContent = (l.size/1024).toFixed(1)+" KB";
    var fn = document.createElement("span"); fn.className="fn"; fn.textContent = l.id;
    sum.appendChild(cmd); sum.appendChild(sz); sum.appendChild(fn);
    var body = document.createElement("div");
    det.appendChild(sum); det.appendChild(body);
    sectionsEl.appendChild(det);
    rec = files[l.id] = { section: det, body: body, cmdEl: cmd, szEl: sz, lines: [], finalized: false, housekeeping: false };
    return rec;
  }
  // A section is one exec log, or one check process: its consolidated log once
  // finalized, its durable chunks in stream order while it runs. The chunks are
  // read in the order the index lists them and rendered as one log.
  function fetchSection(l, rec){
    return Promise.all(l.files.map(function(f){
      return fetch(API + "/logs/" + encodeURIComponent(f.file) + qs)
        .then(function(r){ return r.ok ? r.text() : ""; });
    })).then(function(txts){ renderInto(rec, txts.join("\\n")); applyFilter(); });
  }
  function syncSections(detail, terminal){
    var logs = detail.sections || [];
    if (logs.length===0 && Object.keys(files).length===0){
      sectionsEl.innerHTML = '<div class="empty">No logs yet for this execution.</div>';
      return Promise.resolve();
    }
    var empty = sectionsEl.querySelector(".empty");
    if (empty) empty.remove();
    var jobs = [];
    logs.forEach(function(l){
      var rec = ensureSection(l);
      // Re-fetch only files not yet finalized (the last/growing one while live).
      if (!rec.finalized){
        if (terminal) rec.finalized = true;
        jobs.push(fetchSection(l, rec));
      }
    });
    return Promise.all(jobs).then(updateHousekeepingLabel);
  }
  // Reflect how many sections are collapsed as housekeeping, so the toggle reads
  // as a deliberate filter ("housekeeping (62)") rather than a mystery checkbox.
  function updateHousekeepingLabel(){
    var n = 0;
    for (var f in files){ if (files[f].housekeeping) n++; }
    var lbl = document.getElementById("hkLabel");
    lbl.textContent = n ? "housekeeping (" + n + ")" : "housekeeping";
  }
  function tick(){
    fetch(API + qs).then(function(r){
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function(detail){
      setHeader(detail.execution);
      renderSteps(detail.steps);
      renderSummary(detail.summary);
      renderArtifacts(detail.artifacts);
      var st = detail.execution.status;
      var terminal = (st !== "running" && st !== "queued");
      return syncSections(detail, terminal).then(function(){
        if (terminal){
          statusEl.textContent = "done";
          if (location.hash){ var el=document.getElementById(location.hash.slice(1)); if(el) el.scrollIntoView(); }
        } else {
          statusEl.textContent = "● live — refreshing…";
          setTimeout(tick, 5000);
        }
      });
    }).catch(function(e){
      statusEl.textContent = "error: " + e.message;
    });
  }
  document.getElementById("filter").addEventListener("input", applyFilter);
  document.getElementById("stderrOnly").addEventListener("change", applyFilter);
  var hkToggle = document.getElementById("showHousekeeping");
  hkToggle.addEventListener("change", function(){
    document.body.classList.toggle("show-housekeeping", hkToggle.checked);
  });
  // Validate the deep-link fragment before any DOM lookup uses it.
  if (location.hash && !/^#[A-Za-z0-9_.-]+$/.test(location.hash)){
    location.hash = "";
  }
  // A deep link may point at a section that classified as housekeeping (hidden
  // by default) — reveal the housekeeping group so the anchor isn't a dead jump.
  if (location.hash){
    hkToggle.checked = true;
    document.body.classList.add("show-housekeeping");
  }
  tick();
})();
</script>
</body></html>`;
