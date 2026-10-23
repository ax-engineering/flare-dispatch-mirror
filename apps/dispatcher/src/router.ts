// FlareDispatch Dispatcher — the request router seam.
//
// The route table itself is an `@effect/platform` `HttpRouter` (http-app.ts):
// typed path params, the Cloudflare Access gate + capability links as Layers,
// and the `GET /` dashboard. This module keeps the stable `handleRequest`
// entry point (`index.ts`'s `fetch` and the whole test suite drive it) and
// owns the ONE escape hatch the typed router can't model: the
// `GET /v1/browser/cdp` WebSocket `101` upgrade, whose `webSocket` an
// `HttpServerResponse` can't round-trip. It is dispatched before the router,
// the same way `index.ts` handles the `@cloudflare/sandbox` preview proxy.
//
// This module imports NOTHING from the Cloudflare runtime
// (`cloudflare:workers` / `@cloudflare/sandbox`) — only the route handlers and
// the typed `Env` — so it (and the routes) stay testable under plain Node +
// Vitest 2. `index.ts` owns the runtime-coupled binding-class re-exports.
//
// Spec: specs/pm/plan.md § PR5, specs/05-byoc.md § GitHub App setup.

import type { Env } from "./env";
import { handleViaApp } from "./http-app";
import { handleBrowserCdp } from "./routes/browser-cdp";
import { COMPILE_CACHE_ROUTE, handleCompileCache } from "./routes/compile-cache";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Route an inbound request to its handler. */
export const handleRequest = async (
  request: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> => {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  // Escape hatch: GET /v1/browser/cdp is a WebSocket upgrade — it returns a
  // `101` Response carrying a live `webSocket`, which the HttpServerResponse
  // model can't round-trip. Dispatch it here, before the typed router, exactly
  // as index.ts dispatches the sandbox preview proxy before this function.
  if (
    segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "browser" &&
    segments[2] === "cdp"
  ) {
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const requestId = request.headers.get("cf-ray") ?? "no-ray";
    return handleBrowserCdp(request, env, requestId);
  }

  // Escape hatch: the compile cache speaks WebDAV (PROPFIND, MKCOL) under
  // arbitrary-depth paths and streams PUT bodies straight into R2, so it takes
  // the raw `Request` rather than a router route. `waitUntil` carries the
  // rewrite of an aged entry past the response.
  if (url.pathname.startsWith(`${COMPILE_CACHE_ROUTE}/`)) {
    return handleCompileCache(request, env, {
      now: Date.now,
      ...(ctx !== undefined ? { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise) } : {}),
    });
  }

  return handleViaApp(request, env);
};
