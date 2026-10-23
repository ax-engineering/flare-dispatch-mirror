// FlareDispatch Dispatcher — typed binding environment.
//
// One field per binding declared in wrangler.jsonc, plus the Worker secrets.
// V0 surface only: Workflow + R2 + D1 + Container. Queue / DO / Browser
// bindings are deferred to V1+ and intentionally absent here.

import type { RunSandbox } from "./sandbox";
import type { SubstrateFacade } from "@fractalboxdev/flare-dispatch-substrate-contract";

export interface Env {
  /**
   * The substrate's `DispatcherFacade` over a service binding — the ONLY way
   * this Worker reaches an execution container once a run is on the facade
   * path (ADR-0003). Which named entrypoint the binding targets IS the consumer
   * identity: the substrate reads no runtime field to decide who is calling, so
   * the choice is made once, in reviewed wrangler config.
   *
   * Typed as the contract interface rather than the entrypoint class so the
   * dispatcher compiles with zero knowledge of the substrate's internals; the
   * shapes are plain structural types precisely so they survive Workers RPC.
   *
   * Optional: a deploy without the binding (or before the substrate worker is
   * deployed — it deploys FIRST, see its wrangler.jsonc) keeps every run on the
   * container path.
   */
  readonly SUBSTRATE?: SubstrateFacade;

  /**
   * Which execution backend a run uses. `"on"` routes every facade-capable run
   * through `SUBSTRATE`; anything else (the default) keeps the container path.
   * A var, not a secret — it is a rollout switch, and flipping it is the
   * cutover the adoption runbook describes.
   *
   * Orthogonal to the per-run rollout POSITION in `grant-catalog.ts`: this
   * decides *where* a run executes, the position decides *how much of the
   * egress floor is enforced* once it is there.
   */
  readonly SUBSTRATE_BACKEND?: string;

  /**
   * `version_metadata` binding — the deployed Worker version, answered to runs
   * as `io.env(DEPLOYED_VERSION_ENV)`. Absent → `unknown`.
   */
  readonly VERSION_METADATA?: WorkerVersionMetadata;

  /**
   * `"off"` stops the container-stop records being written to R2 (the log line
   * is unaffected). Anything else, including absent, leaves them on.
   *
   * A `vars` entry rather than a code path because the deploy that carries the
   * sandbox DO classes also rebuilds three container images, so backing the
   * feature out would otherwise be an image-rebuilding redeploy rather than a
   * config edit. See `apps/dispatcher/src/container-stop.ts`.
   */
  readonly CONTAINER_STOP_RECORDS?: string;

  /**
   * Shared HMAC-SHA256 secret — verifies inbound `POST /v1/dispatch/:run`
   * request bodies (specs/05-byoc.md § Secrets). A Worker secret, set via
   * `wrangler secret put HMAC_SECRET`.
   */
  readonly HMAC_SECRET: string;

  /**
   * Optional dedicated keying material for the per-execution log-viewer
   * capability tokens (apps/dispatcher/src/log-token.ts). A Worker secret. When
   * unset, log tokens derive from `HMAC_SECRET` instead (every Action-mode
   * deploy has one, and the deploy workflow re-syncs it), so the viewer is
   * tokened-by-default with no extra secret. Set a dedicated value on a
   * webhook-only deploy that omits `HMAC_SECRET`, or to rotate log links
   * independently of the dispatch HMAC. Absent AND `HMAC_SECRET` absent → the
   * per-execution log routes default-deny (`503`).
   */
  readonly LOG_LINK_SECRET?: string;

  /**
   * Cloudflare Access application AUD tag — gates every human-facing VIEWER
   * surface (`/logs`, `/demos`, `/replay`, `/v1/executions/...`) behind
   * Zero-Trust SSO. A var, not a secret (the AUD is
   * a public application identifier, not a credential). Pairs with
   * `ACCESS_TEAM_DOMAIN`. With `VIEWER_ACCESS_MODE` unset/"required" and EITHER
   * of these absent, the viewer routes **default-DENY** (`503
   * access_not_configured`) — never silently open. See `access-auth.ts`.
   */
  readonly ACCESS_AUD?: string;

  /**
   * Cloudflare Access team domain (`myteam.cloudflareaccess.com`, or the full
   * `https://...` URL) — the issuer the viewer-Access gate validates `iss`
   * against and fetches the verifying JWKS from
   * (`<issuer>/cdn-cgi/access/certs`). A var, not a secret. Pairs with
   * `ACCESS_AUD`; see that field for the default-deny posture.
   */
  readonly ACCESS_TEAM_DOMAIN?: string;

  /**
   * Cloudflare Access application AUD tag for the DEPLOY CONSOLE (`/deploy`) —
   * a distinct Access app (and AUD) from the viewer `ACCESS_AUD`, because the
   * deploy console is a privileged WRITE surface with its own policy (GitHub
   * team `deploy.env-authz`). A var, not a secret (a public app identifier).
   * Pairs with `ACCESS_TEAM_DOMAIN`. Absent → `/deploy` default-DENIES (503
   * access_not_configured), never silently open. See `deploy-access.ts`.
   */
  readonly DEPLOY_ACCESS_AUD?: string;

  /**
   * Viewer Access enforcement mode. Unset / "required" (the secure default):
   * every viewer surface requires a verified Cloudflare Access JWT. The single
   * explicit opt-out is "token-only" — fall back to the per-execution
   * capability token alone (the pre-Access behaviour, and what `wrangler dev`
   * / local smokes use, since no Access app fronts the Worker there). A var.
   * See `access-auth.ts`.
   */
  readonly VIEWER_ACCESS_MODE?: string;

  /** Workflow binding — instantiates RunWorkflow executions. */
  readonly RUNS_WORKFLOW: Workflow;

  /**
   * Container binding — the LEAN sandbox image, one instance per execution.
   * Typed as a `DurableObjectNamespace<Sandbox>` so `getSandbox(env.RUNS_SANDBOX,
   * id)` in `@fractalboxdev/flare-dispatch-runtime-cf` resolves the typed sandbox RPC surface.
   * The default for every run except those declaring `sandboxImage: "browser"`.
   */
  readonly RUNS_SANDBOX: DurableObjectNamespace<RunSandbox>;

  /**
   * Container binding — the chromium-baked sandbox image (built from the same
   * Dockerfile with `WITH_BROWSER=true`). Runs declaring `sandboxImage:
   * "browser"` (e.g. `playwright-demo`, which launches Playwright's own chromium
   * inside the container) route here. Optional: a deploy that omits the second
   * container degrades by falling back to `RUNS_SANDBOX` rather than crashing on
   * an unbound namespace. NOTE the fallback is only non-fatal if the run's
   * command installs a browser itself (`playwright install …`) — a command that
   * relies on the baked image (the Dockerfile tells those callers to DROP the
   * install step) finds no chromium on the lean image and fails. So this is a
   * soft guard against a missing binding, not a guarantee browser runs work
   * without the second container.
   */
  readonly RUNS_SANDBOX_BROWSER?: DurableObjectNamespace<RunSandbox>;

  /**
   * Container binding — the agent-tier sandbox image (same Dockerfile with
   * `WITH_AGENT=true`): the `flare-agent` CLI + a node/git toolchain baked in,
   * and a MANDATORY egress allowlist (model-proxy + git remote only — the
   * container holds the cloned private repo + incident pack, so an injection-
   * steered agent must not be able to exfiltrate). Runs declaring
   * `sandboxImage: "agent"` (self-heal-pr) route here. Optional: a deploy that
   * omits it soft-degrades to `RUNS_SANDBOX`, where a self-heal run finds no
   * `flare-agent` and fails (not a guarantee, just a non-crash). Egress is NOT
   * configurable away — it is part of the tier. specs/08-self-healing.md § 6.2.
   */
  readonly RUNS_SANDBOX_AGENT?: DurableObjectNamespace<RunSandbox>;

  /** Pinned Rust, Zig, and native C++ toolchain for release builds. */
  readonly RUNS_SANDBOX_RELEASE?: DurableObjectNamespace<RunSandbox>;

  /** R2 bucket — `logs/<execution-id>/<step>.ndjson` + `artifacts/...`. */
  readonly RUNS_STORAGE: R2Bucket;

  /** D1 database — `executions` + `steps` metadata tables. */
  readonly RUNS_METADATA: D1Database;

  /**
   * KV namespace backing the `config` capability — dynamic config only
   * (commands, feature flags, secret *name* allowlists). Credential *values*
   * live on Worker secrets/vars via the `secrets` capability (`wrangler
   * secret put CLOUDFLARE_API_TOKEN`; `CLOUDFLARE_ACCOUNT_ID` as a var) —
   * never in CONFIG_KV. Optional: a deploy without it degrades to the dying
   * `Config` stub (a config-reading run fails loudly). See
   * `@fractalboxdev/flare-dispatch-runtime-cf` `makeConfigKvLive`.
   */
  readonly CONFIG_KV?: KVNamespace;

  /**
   * Receiver-level dedup KV — specs/04-gha-integration.md § Receiver dedup.
   * Keyed on the caller-supplied `Idempotency-Key` (or the semantic
   * `{run}:{repo}:{sha}` fallback) → the stored `executionId`. A repeat
   * delivery short-circuits to `202 {executionId}` without ever creating the
   * Workflow. Optional: absent → no receiver short-circuit, dedup falls back
   * to CF Workflows' platform-level `create({id})` no-op behaviour, which is
   * still correct just one RPC more expensive per redelivery.
   */
  readonly IDEMPOTENCY_KV?: KVNamespace;

  /**
   * Installation-token cache KV — specs/04-gha-integration.md § Check-runs
   * callback. Keyed by `installation_id`, value is the cached `{ token,
   * expiresAt }` so a Worker eviction does not force a fresh JWT exchange on
   * every check-run callback. Optional: absent → tokens cached in Worker
   * memory only (the V0 behaviour).
   */
  readonly INSTALL_TOKEN_KV?: KVNamespace;

  /**
   * GitHub App id — Worker secret, set via `wrangler secret put GITHUB_APP_ID`.
   * Numeric, carried as a string. With `GITHUB_APP_PRIVATE_KEY` it authorizes
   * the check-run callback; absent, the runtime degrades to a no-op `Checks`
   * Layer (the execution still runs, only the PR check-run is skipped).
   */
  readonly GITHUB_APP_ID?: string;

  /**
   * GitHub App private key — Worker secret, the PKCS#8 PEM piped via
   * `wrangler secret put GITHUB_APP_PRIVATE_KEY < app.pem`. Pairs with
   * `GITHUB_APP_ID` to mint short-lived installation tokens (no PATs).
   */
  readonly GITHUB_APP_PRIVATE_KEY?: string;
  readonly GHCR_USERNAME?: string;
  readonly GHCR_TOKEN?: string;

  /**
   * GitHub App webhook secret — Worker secret. Verifies `X-Hub-Signature-256`
   * on `POST /v1/webhooks/github` (specs/04-gha-integration.md § Webhook
   * mode). Absent → the webhook route refuses (`503 webhook_not_configured`):
   * Webhook mode is opt-in, and silently accepting unsigned deliveries would
   * be a worse failure than rejecting.
   */
  readonly GITHUB_WEBHOOK_SECRET?: string;

  /**
   * Comma-separated GitHub webhook event allowlist. Absent allows every event;
   * empty allows none. Action-mode deployments can accept only
   * `check_run,check_suite` for manual reruns while the App retains its broader
   * subscriptions. Excluded signed deliveries receive 202 without side effects.
   */
  readonly GITHUB_WEBHOOK_EVENTS?: string;

  /**
   * Admin bearer token — Worker secret. Gates `POST /v1/admin/events/:wf_id`
   * (the `step.waitForEvent` signalling surface, specs/03-dsl.md
   * § Human-in-the-loop). Production deploys put Cloudflare Access in front
   * of the route and let CF Access enforce the SSO; the bearer token is the
   * cheap-and-correct fallback for deploys without CF Access. Absent → the
   * admin route refuses (`503 admin_not_configured`).
   */
  readonly ADMIN_TOKEN?: string;

  /**
   * OIDC signing key — ES256 private JWK as a JSON string. Worker secret
   * (`wrangler secret put OIDC_SIGNING_JWK < ./oidc-signing.jwk.json`).
   * Pairs with `OIDC_ISSUER_URL` to back the live `oidc` capability and the
   * `/.well-known/jwks.json` endpoint. Absent → `OidcDeferred` (a run that
   * calls `oidc.sign` fails with `OidcSigningFailed`). Spec: 03-dsl § oidc.
   */
  readonly OIDC_SIGNING_JWK?: string;

  /**
   * OIDC issuer URL — the Worker's stable origin (e.g.
   * `https://flare-dispatch.<account>.workers.dev`). Pinned by AWS / GCP
   * trust policies, so it must match exactly what's registered as the
   * OIDC provider. Worker secret (or var; semantics are the same).
   */
  readonly OIDC_ISSUER_URL?: string;

  /**
   * Browser Rendering CDP `/connect` WebSocket URL — Worker secret. The
   * `cdp-acceptance` run hands this (with `BROWSER_CDP_API_TOKEN` appended) to
   * the container's Playwright process. Absent, the runtime degrades to the
   * dying `Browser` stub — a browser run fails loudly, non-browser runs are
   * unaffected.
   */
  readonly BROWSER_CDP_CONNECT_URL?: string;

  /**
   * Cloudflare API token authorizing the Browser Rendering connect — Worker
   * secret, paired with `BROWSER_CDP_CONNECT_URL`. Also the bearer token the
   * `GET /v1/browser/cdp` proxy route validates: a `cdp-acceptance` container
   * connects with `?token=<this>` (or `Authorization: Bearer <this>`).
   */
  readonly BROWSER_CDP_API_TOKEN?: string;

  /**
   * Cloudflare Browser Rendering binding. When present, `GET /v1/browser/cdp`
   * bridges a container's `connectOverCDP` to a Browser Rendering session via
   * `env.BROWSER.fetch(/v1/acquire)` + `/v1/devtools/browser/<sessionId>` — the
   * only supported way to reach CF Browser Rendering CDP (it is not a public,
   * token-dialable WebSocket). Absent → that route 503s; non-browser runs are
   * unaffected. Declared as `"browser": { "binding": "BROWSER" }` in wrangler.
   */
  readonly BROWSER?: Fetcher;

  /**
   * Workers Static Assets binding for the dashboard SPA (apps/dashboard/dist).
   * Declared as `"assets": { "binding": "ASSETS", … }` in wrangler.jsonc. Used
   * by the navigation routes (`/`, `/executions/*`) to serve the SPA shell from
   * the asset layer AFTER the Cloudflare Access gate, so the shell is gated
   * in-Worker while hashed `/assets/*` stay public (not in `run_worker_first`).
   * Absent (no-asset deploys + the route tests) → those routes fall back to the
   * SSR `renderDashboard` page.
   */
  readonly ASSETS?: Fetcher;

  /**
   * CF Browser session `keep_alive` ceiling in ms for the `/v1/browser/cdp`
   * proxy (default 600000 = CF's documented 10-min max). A var, not a secret.
   */
  readonly KEEP_ALIVE_MS?: string;

  /**
   * The Worker's public domain (e.g. `flare-dispatch.<account>.workers.dev`,
   * or a custom domain) the `sandbox` capability's `exposePort` uses to build
   * container preview URLs — the publicly-reachable URL a cloud browser dials
   * instead of the container's `localhost`. A var, not a secret (it is the
   * public origin, not a credential). Absent → `exposePort` fails with
   * `ExposePortFailed`, so a browser-acceptance run that needs a reachable URL
   * fails loudly. Non-browser runs are unaffected.
   */
  readonly SANDBOX_PREVIEW_HOSTNAME?: string;

  /**
   * The Worker-wide sandbox transport for a repo no `sandbox.transport:<repo>`
   * key pins: `http`, `websocket` or `rpc`, and `rpc` when unset or not a
   * transport name. The dispatcher pins the resolved transport onto every
   * container (`resolveSandboxTransport`). A var, not a secret.
   */
  readonly SANDBOX_TRANSPORT?: string;

  /**
   * The dispatcher's own public origin (e.g.
   * `https://flare-dispatch.<account>.workers.dev`, or a custom domain) —
   * prefixed onto the `/v1/artifacts/...` URLs runs upload so the links a
   * GitHub check-run summary embeds are absolute (GitHub resolves relative
   * markdown links against `github.com`, breaking them) — and the base the
   * tokened log-viewer link (`/logs/<execution>?t=…`) on every check-run
   * summary is built on. A var, not a secret.
   * Optional: HTTP dispatches (dispatch, deploy, webhook, signals) fall back
   * to the request's own origin; cron-scheduled runs have no request, so their
   * artifact links stay relative (GitHub-broken) and their summaries carry no
   * viewer link until this is set. Distinct from
   * `SANDBOX_PREVIEW_HOSTNAME`, which is the *sandbox preview* domain — they
   * may differ (e.g. previews on a wildcard subdomain).
   */
  readonly PUBLIC_ORIGIN?: string;

  /**
   * Compile-cache bounds (routes/compile-cache.ts): one entry's bytes, one
   * repository's bytes, one execution's written bytes, and the entry age in
   * days the sweep deletes. Unset or malformed → 100 MiB, 20 GiB, 10 GiB,
   * 14 days.
   */
  readonly COMPILE_CACHE_MAX_OBJECT_BYTES?: string;
  readonly COMPILE_CACHE_MAX_REPO_BYTES?: string;
  readonly COMPILE_CACHE_MAX_EXECUTION_BYTES?: string;
  readonly COMPILE_CACHE_TTL_DAYS?: string;

  /**
   * Cloudflare Email Routing `send_email` binding — backs the `email`
   * capability + the Workflow's completion-notify (`notify.emails` in the
   * dispatch body). Declared as `"send_email": [{ "name": "SEND_EMAIL" }]` in
   * wrangler. Cloudflare only delivers to **verified destination addresses** on
   * the zone, and `from` must be `EMAIL_FROM` on that zone. Absent (no Email
   * Routing configured) → the no-op `Email` Layer: notifications are logged and
   * skipped, never failing a run.
   */
  readonly SEND_EMAIL?: SendEmail;

  /**
   * Verified sender address for completion-notify email — the `From`. A var,
   * not a secret (a public address, not a credential). Must be on the Email
   * Routing zone `SEND_EMAIL` is bound to. Absent → `Email` degrades to the
   * no-op Layer even when `SEND_EMAIL` is present.
   */
  readonly EMAIL_FROM?: string;

  /** Optional display name for the notify `From` header (e.g. "FlareDispatch"). */
  readonly EMAIL_FROM_NAME?: string;

  /**
   * Optional comma-separated allowlist of recipient addresses. When set, a
   * `notify.emails` recipient not on it is rejected before the provider call —
   * a cheap guard so a dispatch can't fan notifications at arbitrary addresses
   * on top of Cloudflare's own verified-destination enforcement. A var.
   */
  readonly EMAIL_ALLOWED_RECIPIENTS?: string;

  /**
   * Where the `mailbox` capability mints disposable test inboxes. Two forms:
   *
   *   - **Sub-addressing** `base@domain` (e.g. `flare-dispatch-inbox@example.com`):
   *     mints `base+demo-<rand>@domain`. ONE Email Routing custom-address rule for
   *     `base@domain` → this Worker matches every `base+…@domain` (RFC 5233
   *     sub-addressing must be ON in Email Routing settings), so the zone's
   *     existing catch-all is untouched — the way to reuse a shared zone with NO
   *     disruption to other mail.
   *   - **Catch-all** bare `domain` (e.g. `inbox.example.com`): mints
   *     `demo-<rand>@domain`, for a dedicated zone whose catch-all → this Worker.
   *
   * A var, not a secret (a public domain). Absent → the `mailbox` capability is
   * the dying stub (an `email-otp-login` run fails loudly). See
   * recipes/email-otp-login/README.md for the one-time Email Routing setup.
   */
  readonly INBOX_DOMAIN?: string;

  /**
   * Optional comma-separated allowlist of envelope-From DOMAINS the inbound
   * `email()` handler will accept mail from (e.g.
   * `auth0.com,clerk.com,accounts.google.com`). When set, mail whose sender
   * domain is not listed is `setReject`ed before storage — the recommended
   * hardening for a catch-all (the prefix guard alone already refuses non-`demo-`
   * RCPTs). Absent → all senders to a valid `demo-` address are accepted (a
   * warning is logged). A var, not a secret.
   */
  readonly INBOX_ALLOWED_SENDERS?: string;

  /**
   * Optional dedicated keying material for the mailbox read-route capability
   * tokens (apps/dispatcher/src/mailbox-token.ts). A Worker secret. When unset,
   * mailbox tokens derive from `HMAC_SECRET` instead (HKDF label keeps them
   * independent). Set a dedicated value to rotate mailbox-read links
   * independently of the dispatch HMAC. Absent AND `HMAC_SECRET` absent → the
   * `GET /v1/mailbox/:localPart` route default-denies (`503`).
   */
  readonly MAILBOX_LINK_SECRET?: string;

  /**
   * Cloudflare Workers AI binding — backs the `modelGateway` capability the
   * `pr-review` engine calls. The binding IS the auth (Workers AI is
   * account-billed), so no model API key is configured. Declared as
   * `"ai": { "binding": "AI" }` in wrangler. Absent (no `"ai"` binding) → the
   * dying `ModelGateway` stub: a model-calling run fails loudly, others are
   * unaffected.
   */
  readonly AI?: Ai;

  /**
   * AgentBudget Durable Object — one instance per self-heal execution, the
   * single-writer home for the model-proxy's per-execution token budget +
   * request cap + liveness (`agent-budget-do.ts`). Absent → the model-proxy
   * route default-denies (503); other paths are unaffected. Declared in
   * wrangler `durable_objects` + a `new_sqlite_classes` migration.
   * Spec: specs/08-self-healing.md § 6.3.
   */
  readonly AGENT_BUDGET?: DurableObjectNamespace<import("./agent-budget-do").AgentBudget>;

  /**
   * One compile-cache ledger per repository (compile-cache-ledger.ts): the
   * byte count every compile-cache PUT reserves against, and each
   * execution's write budget and end marker. Absent → the compile cache
   * serves reads and refuses every write.
   */
  readonly COMPILE_CACHE_LEDGER?: DurableObjectNamespace<import("./compile-cache-ledger-do").CompileCacheLedger>;

  /**
   * Optional dedicated secret for the agent model-proxy capability token. Falls
   * back to `HMAC_SECRET` (HKDF label keeps them independent). Neither set → the
   * model-proxy route default-denies. `wrangler secret put AGENT_PROXY_SECRET`.
   */
  readonly AGENT_PROXY_SECRET?: string;

  /**
   * Optional fallback model id for the agent model-proxy when CONFIG_KV
   * `self-heal.proxy.model` is unset. A var, not a secret (the binding is the
   * auth). Absent → a Workers AI catalog default.
   */
  readonly AGENT_PROXY_MODEL?: string;

  /**
   * Optional AI Gateway id the `modelGateway` routes Workers AI calls through
   * (for caching / rate-limiting / observability). A var, not a secret. Absent
   * / empty → call Workers AI directly (no gateway). Set per-deploy via the
   * `vars` block in wrangler (e.g. wrangler.numu.jsonc).
   */
  readonly AI_GATEWAY_ID?: string;

  /**
   * Admission-semaphore slots per container pool (issue #109) — a var, not a
   * secret, carried as a string like every wrangler var. At most this many
   * runs are in flight per pool (lean / browser); the rest queue FIFO in D1.
   * Keep it ≤ each container's `max_instances` (16 today; see the paired
   * comments in wrangler.jsonc) — operators may set it slightly below for
   * slot-turnover headroom. Absent / unparsable → defaults to 16
   * (`ADMISSION_CAP_DEFAULT`), same degrade pattern as
   * `CLOUDFLARE_ACCOUNT_ID` below.
   */
  readonly ADMISSION_CAP?: string;

  /**
   * The release pool's admission slots — a var, carried as a string. The
   * release pool admits at most the smaller of this and `ADMISSION_CAP`; keep
   * it ≤ `RunSandboxRelease`'s `max_instances`. Absent / unparsable → 8
   * (`RELEASE_ADMISSION_CAP_DEFAULT`).
   */
  readonly ADMISSION_CAP_RELEASE?: string;

  /**
   * The agent pool's admission slots — a var, carried as a string. The agent
   * pool admits at most the smaller of this and `ADMISSION_CAP`; keep it ≤
   * `RunSandboxAgent`'s `max_instances`. Absent / unparsable → 8
   * (`AGENT_ADMISSION_CAP_DEFAULT`).
   */
  readonly ADMISSION_CAP_AGENT?: string;

  /**
   * The browser pool's admission slots — a var, carried as a string. The
   * browser pool admits at most the smaller of this and `ADMISSION_CAP`; keep
   * it ≤ `RunSandboxBrowser`'s `max_instances`. Absent / unparsable → 16
   * (`BROWSER_ADMISSION_CAP_DEFAULT`).
   */
  readonly ADMISSION_CAP_BROWSER?: string;

  /**
   * The monthly spend budget in USD (specs/adr/0006-spend-guard.md) — a var.
   * At or over it, admission skips every run with a neutral check. Unset or
   * unparsable → 50; `unlimited` disables it. CONFIG_KV
   * `spend.budgetMonthlyUsd` overrides it without a deploy. The default lives
   * in code (core spend.ts), because an operator overlay replaces the
   * committed wrangler.jsonc.
   */
  readonly SPEND_BUDGET_MONTHLY_USD?: string;

  /**
   * The burn ceiling in USD per hour — a var. The summed hourly rate of every
   * admitted execution, across all pools, stays at or under it. Unset or
   * unparsable → 1.50; `unlimited` disables it. CONFIG_KV
   * `spend.burnMaxUsdPerHour` overrides it.
   */
  readonly SPEND_BURN_MAX_USD_PER_HOUR?: string;

  /**
   * Multiplier on metered container + model spend for Workflow steps and
   * Durable Objects — a var. Unset or outside [1, 10] → 1.10.
   */
  readonly SPEND_OVERHEAD_FACTOR?: string;

  /**
   * Fraction of the monthly budget whose crossing sends the month's one
   * warning on the notice path — a var. Unset or outside (0, 1] → 0.8.
   */
  readonly SPEND_WARN_RATIO?: string;

  /**
   * Cloudflare account id (the 32-hex id in the dashboard URL) — a var, not a
   * secret. When set, `RunWorkflow` builds a `details_url` on the GitHub
   * check-run pointing at the Cloudflare Workflows instance page
   * (`dash.cloudflare.com/<id>/workers/workflows/runs-workflow/instance/<executionId>`),
   * so a reviewer jumps from the PR check straight to the execution's step
   * logs. Absent (the BYOC default — each deploy owns its account) → no
   * `details_url`, the check-run renders exactly as before. Set with
   * `wrangler` via the `vars` block in wrangler.jsonc.
   */
  readonly CLOUDFLARE_ACCOUNT_ID?: string;

  /**
   * Cloudflare API token (scoped, e.g. `Pages:Read`) — a Worker secret, set via
   * `wrangler secret put CLOUDFLARE_API_TOKEN`. Backs the read-only `cloudflare`
   * capability the `ci-triage` run uses to read failed Pages deployments
   * (paired with `CLOUDFLARE_ACCOUNT_ID`). Absent → the `cloudflare` capability
   * degrades to empty (the triage sweep finds nothing CF-side). Non-CF runs are
   * unaffected. Read-only: mutating CF state stays a `wrangler` / CI concern.
   */
  readonly CLOUDFLARE_API_TOKEN?: string;

  /**
   * Optional AI Gateway authentication token — a Worker secret, set via
   * `wrangler secret put AI_GATEWAY_AUTH_TOKEN`. Forwarded as
   * `cf-aig-authorization: Bearer <token>` on `bedrock/*` model calls only;
   * required ONLY when the operator's AI Gateway has [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
   * turned on. Orthogonal to AWS SigV4. Absent → no header is sent (the
   * default for an unauthenticated gateway).
   */
  readonly AI_GATEWAY_AUTH_TOKEN?: string;

  /**
   * The one repository slack-origin dispatches may target — the config pin the
   * `slack-origin.ts` policy checks `github.repo` against. A var, not a secret
   * (a public `owner/name`). CONFIG_KV `slack-origin.repo` overrides it so an
   * operator can re-point without a redeploy. With NEITHER set the Slack batch
   * path is **off**: every slack-origin dispatch is refused, never silently
   * allowed against whatever repo the caller named.
   */
  readonly SLACK_ORIGIN_REPO?: string;

  /**
   * Optional SECOND dispatch-signing key, scoped to the Slack path. A Worker
   * secret. A dispatch whose signature verifies under this key is forced
   * through the slack-origin policy whatever its body declares — so the Slack
   * ingress can hold a credential incapable of dispatching outside the
   * envelope, and "server-side enforcement" stops depending on the caller
   * declaring its own origin honestly. Ignored when equal to `HMAC_SECRET`
   * (one value under two names is not a scope). Absent → the body's declared
   * `source` selects the policy.
   */
  readonly SLACK_ORIGIN_HMAC_SECRET?: string;

  /**
   * Where a slack-origin run's verdict is delivered at the finalize boundary —
   * the Slack ingress's own signed callback endpoint, which posts it in-thread
   * with the bot token this dispatcher deliberately never holds. A var, not a
   * secret (a public HTTPS URL). CONFIG_KV `slack-origin.notify-url` overrides
   * it. Absent → the check-run still completes and the verdict is logged; only
   * the in-thread post is skipped.
   */
  readonly SLACK_NOTIFY_URL?: string;

  /**
   * Where a run's NOTICE is delivered — the Slack ingress's
   * `/flare-dispatch/notify` route, which resolves the destination from its own
   * use-case map. A var, not a secret (a public HTTPS URL). CONFIG_KV
   * `slack-notice.url` overrides it. Absent → `notice.publish` is a logged
   * no-op and the run is otherwise unaffected.
   *
   * Separate from `SLACK_NOTIFY_URL` on purpose: a different endpoint, a
   * different payload, and a blast radius an operator must be able to move
   * without silencing the in-thread verdicts a human is waiting on. See
   * `SLACK_NOTICE_URL_KEY` in slack-notify.ts.
   */
  readonly SLACK_NOTICE_URL?: string;

  /**
   * Optional dedicated keying material for BOTH signed callbacks — the verdict
   * and the notice. One secret, but TWO derived keys: each surface derives
   * under its own HKDF label (`flare-dispatch/slack-notify/v1` and
   * `flare-dispatch/slack-notice/v1`, `slack-notify.ts`), because only the
   * verdict body names a channel and a notice key must not be able to sign one.
   * A Worker secret. When unset both keys are HKDF-derived from `HMAC_SECRET`
   * instead, so both surfaces are signed by default with no extra secret and
   * neither derived key can be confused with the dispatch HMAC. Absent AND
   * `HMAC_SECRET` absent → both are skipped rather than sent unsigned.
   */
  readonly SLACK_NOTIFY_SECRET?: string;
}
