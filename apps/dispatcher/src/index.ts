// FlareDispatch Dispatcher Worker — V0 walking-skeleton entry point.
//
// This file is the Cloudflare-runtime seam: the `fetch` + `scheduled` handlers
// and the two binding-class re-exports wrangler resolves from `main`. All
// routing logic lives in `router.ts` / `routes/scheduled.ts` — kept free of
// `cloudflare:workers` / `@cloudflare/sandbox` imports so they stay testable
// under plain Node + Vitest 2.
//
//   GET  /health                          → routes/health.ts
//   POST /v1/dispatch/:run                 → routes/dispatch.ts
//   GET  /v1/artifacts/:execution/:name    → routes/artifacts.ts
//   (CF Cron Trigger → `scheduled`)        → routes/scheduled.ts
//
// wrangler resolves two Durable Object / Workflow classes from this entry:
//   * `RunWorkflow`  — the Workflow class (workflow.ts).
//   * `RunSandbox`   — the Container-backed Durable Object class (sandbox.ts).
//
// Spec: specs/pm/plan.md § PR5, specs/04-gha-integration.md § Schedule mode.

import { proxyToSandbox, type SandboxEnv } from "@cloudflare/sandbox";

import type { Env } from "./env";
import { handleRequest } from "./router";
import { handleInboundEmail } from "./routes/email-handler";
import { handleScheduled } from "./routes/scheduled";
import { RunSandbox, RunSandboxBrowser, RunSandboxAgent, RunSandboxRelease } from "./sandbox";

// Re-export the binding classes so wrangler's `main` entry resolves them.
export { RunWorkflow } from "./workflow";
export { AgentBudget } from "./agent-budget-do";
export { CompileCacheLedger } from "./compile-cache-ledger-do";
export { RunSandbox, RunSandboxBrowser, RunSandboxAgent, RunSandboxRelease };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Preview-URL proxying for `exposePort` (the `cdp-acceptance` reachability
    // path): a request to `<port>-<sandboxId>-<token>.<SANDBOX_PREVIEW_HOSTNAME>`
    // is forwarded to that container's port. `proxyToSandbox` returns `null`
    // for everything else, so it's a no-op for the dispatch/health/artifact
    // routes. The SDK's `SandboxEnv` hardcodes the binding name `Sandbox`; our
    // binding is `RUNS_SANDBOX`, so we adapt rather than rename the binding.
    //
    // Only the LEAN binding is proxied: the runs that need `exposePort`
    // reachability (`cdp-acceptance`) are `sandboxImage: "lean"`. The browser
    // image's consumer (`playwright-demo`) connects *out* to a deployed URL and
    // never exposes a port, so RUNS_SANDBOX_BROWSER has no preview surface. If a
    // future browser-image run needs `exposePort`, the proxy must learn to pick
    // the binding from the preview host (tracked in issue #68).
    const proxied = await proxyToSandbox<RunSandbox, SandboxEnv<RunSandbox>>(request, {
      Sandbox: env.RUNS_SANDBOX,
    });
    if (proxied !== null) return proxied;
    return handleRequest(request, env, ctx);
  },
  /**
   * Cron Trigger entry — fires once per `triggers.crons` cadence. We hand off
   * to `handleScheduled` via `ctx.waitUntil` so the runtime keeps the Worker
   * alive long enough to fan out (each match's `env.RUNS_WORKFLOW.create()`
   * is an async I/O the runtime would otherwise tear down on handler return).
   */
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(handleScheduled(env, controller.cron, controller.scheduledTime));
  },
  /**
   * Email Routing entry — Cloudflare invokes this for every message a routing
   * rule directs to this Worker (a catch-all on `INBOX_DOMAIN`). The handler
   * is the receive half of the `mailbox` capability: it `setReject`s any RCPT
   * that is not a minted `demo-…` address BEFORE reading the body, then stores
   * the message + signals the paused `email-otp-login` run. See
   * `routes/email-handler.ts`. No wrangler binding is needed for inbound — the
   * routing rule wires the address to this Worker.
   */
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleInboundEmail(message, env);
  },
} satisfies ExportedHandler<Env>;
