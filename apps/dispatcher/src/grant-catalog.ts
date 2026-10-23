// FlareDispatch Dispatcher — the per-run grant catalog.
//
// One entry per registered run: which substrate grant profiles it needs, which
// rollout position it is at, which dynamic targets its inputs may name, and
// which irreversible commands its reviewed definition pre-asserts.
//
// Why this file rather than a field on each `defineRun` spec: the entries are
// **security review surface**, and the property ADR-0005 rests on is that a
// grant derives from reviewed code and never from a dispatch payload. Keeping
// the whole selection in one file next to the registry makes "what may this
// deploy reach" a single diff to read, and makes the coverage assertion below
// — every registered run has an entry — mechanical rather than aspirational.
//
// Nothing here defines a grant. The vocabulary lives in the substrate
// (`apps/substrate/src/engine/profiles.ts`), which is the only place host sets
// and method/path rules can change; an entry may only *select* among names.
//
// Spec: apps/substrate/specs/adr/0005-deny-all-egress-with-grant-profiles.md,
//       apps/substrate/specs/adr/0007-approval-attestation-at-exec.md.

import type {
  ApprovalAttestation,
  EnforcementPosition,
  GrantProfileName,
} from "@fractalboxdev/flare-dispatch-substrate-contract";

/**
 * A facade surface a run needs that the substrate does not serve yet
 * (ADR-0003 enumerates the boundary; these are the calls it deliberately left
 * out). A run declaring one cannot execute through the facade at all, whatever
 * its rollout position — it is not a weaker grant, it is a missing method.
 */
export type FacadeGap =
  /**
   * `runDetached` / `waitForExit` — a process that outlives the exec fence's
   * grant window. Answered by the substrate's ADR-0012 (it holds no grant) and
   * served by `startDetached` / `detachedStatus` / `stopDetached`; this gap
   * clears per run once the run body moves off `sandbox.runDetached`, and
   * `waitForPort` becomes a fenced exec polling `localhost`.
   */
  | "detached-process"
  /**
   * `exposePort` — a public preview URL for a container port. Deliberately NOT
   * on the facade (ADR-0012): the substrate worker would have to own a proxy
   * route of its own, and until it does these runs stay on this fleet.
   */
  | "expose-port"
  /**
   * `artifact.upload({ container })` — tar a container directory out to R2.
   * ADR-0012 answers this without a new method: the substrate mounts R2 at
   * `/artifacts` per container, so a run writes its own archive there. What is
   * still missing is retrieval — a consumer holds a sandbox key and never the
   * container id, so it cannot address what the run wrote.
   */
  | "container-artifact";

/**
 * Where a run's dynamic egress target comes from, and what it is allowed to be.
 *
 * ADR-0005's rule is that the check happens at the dispatch, not in the policy:
 * an input host outside `hostPatterns` fails the dispatch with a 4xx a caller
 * can read, rather than becoming a container that silently cannot reach its own
 * test target. `hostPatterns` uses the substrate's glob shape — `*` matches
 * exactly one label and never a dot.
 */
export type TargetSchema = {
  readonly hostPatterns: readonly string[];
  /** Pull candidate target URLs out of the (already Schema-decoded) inputs. */
  readonly from: (inputs: unknown) => readonly string[];
};

export type RunGrant = {
  readonly profiles: readonly GrantProfileName[];
  /** Rollout position (ADR-0005). Every run starts at `legacy` and graduates on a clean report window. */
  readonly rollout: EnforcementPosition;
  /** Admits the LFS object host. Off unless a run actually clones LFS content. */
  readonly lfs?: boolean;
  readonly targets?: TargetSchema;
  /**
   * Floor rules this run's reviewed definition pre-asserts (ADR-0007) — the
   * `approvedBy: "run-definition"` case. Names are keys of `FLOOR_MIRROR`.
   */
  readonly preAsserts?: readonly string[];
  readonly facadeGaps?: readonly FacadeGap[];
};

/**
 * A conservative mirror of the substrate's `APPROVAL_FLOOR`, used for exactly
 * one decision: whether the command about to be sent matches *only* rules this
 * run pre-asserts.
 *
 * The substrate's list is the authority — it is versioned with the substrate
 * and is what actually refuses a command. This mirror can only ever make the
 * dispatcher mint FEWER attestations, so drift fails in the safe direction: a
 * rule the substrate has and this lacks means no attestation is minted and the
 * substrate refuses loudly (`approval-required`); a rule this has and the
 * substrate dropped means an attestation is withheld for a command that needed
 * none, and it runs anyway. Neither direction can approve something silently.
 */
export const FLOOR_MIRROR: Readonly<Record<string, RegExp>> = {
  "git push": /\bgit\b[^\n;|&]*\bpush\b/,
  "wrangler deploy/secret/d1": /\bwrangler\b[^\n;|&]*\b(deploy|secret|d1)\b/,
  "terraform apply": /\bterraform\b[^\n;|&]*\bapply\b/,
  "kubectl apply/delete": /\bkubectl\b[^\n;|&]*\b(apply|delete)\b/,
  "package publish": /\b(npm|pnpm|yarn|cargo)\b[^\n;|&]*\bpublish\b/,
  "gh release": /\bgh\b[^\n;|&]*\brelease\b/,
};

/** Clone-and-build, the shape most of the catalog has. */
const JS_BUILD: readonly GrantProfileName[] = ["public-repo-read", "js-install"];
/** Repos whose CI compiles Rust as well as JS (`offload-test`, `check`). */
const POLYGLOT_BUILD: readonly GrantProfileName[] = [
  "public-repo-read",
  "js-install",
  "rust-install",
];

/**
 * The one target extractor the catalog needs today: both e2e-shaped runs take
 * their target as `inputs.baseURL`.
 *
 * A caveat worth stating where it bites: `playwright-e2e` falls back to
 * `playwright-e2e.base-url` in CONFIG_KV when a webhook dispatch carries no
 * `baseURL`, and a value resolved inside the run body is not visible here — so
 * it never reaches the recipe's targets and would be denied under `enforce`.
 * That run graduates past `report` only once its target is a dispatch input.
 */
const baseUrlTarget = (inputs: unknown): readonly string[] => {
  const value = (inputs as { baseURL?: unknown } | null)?.baseURL;
  return typeof value === "string" && value.length > 0 ? [value] : [];
};

/**
 * name → grant. Every run in `registry.ts` appears exactly once; the coverage
 * test asserts it, so a new run cannot ship without someone deciding what it
 * may reach.
 *
 * Every entry ships at `legacy`: no run has had a report window yet, and the
 * position is a claim about observed behaviour, not an intention. The runbook
 * (apps/substrate/specs/adoption-runbook.md) is how one moves.
 */
export const RUN_GRANTS: Readonly<Record<string, RunGrant>> = {
  // --- clone + build + test ------------------------------------------------
  "offload-test": { profiles: POLYGLOT_BUILD, rollout: "legacy" },
  check: { profiles: POLYGLOT_BUILD, rollout: "legacy" },
  "contextful-gate": { profiles: POLYGLOT_BUILD, rollout: "legacy" },
  "contextful-cache-warm": { profiles: POLYGLOT_BUILD, rollout: "legacy" },
  oxlint: { profiles: JS_BUILD, rollout: "legacy" },
  "vitest-shard": { profiles: JS_BUILD, rollout: "legacy" },
  // The parent of a fan-out does no work of its own beyond the checkout; the
  // children carry their own entries.
  "matrix-fanout": { profiles: ["public-repo-read"], rollout: "legacy" },

  // --- read the tree, propose a diff ---------------------------------------
  // The diff is read in-container; every GitHub write rides the Worker's
  // installation token (ADR-0006), so no API host is admitted.
  "pr-review": { profiles: ["public-repo-read"], rollout: "legacy" },
  "spec-drift-pr": { profiles: JS_BUILD, rollout: "legacy" },
  // Narrow for the same reason as `org-spec-audit`, and the run is written to
  // keep it that way: every measurement script is read-only — no install, no
  // build, no network — so a container that could reach a registry would be a
  // grant wider than any use. That bound is what makes `size` report the
  // dependency surface rather than built bundle bytes; the honest grant and the
  // honest measurement are the same decision.
  "improve-pr": { profiles: ["public-repo-read"], rollout: "legacy" },
  // Narrower than its sibling on purpose: the sweep only clones and reads with
  // `git`, never installs or builds, and its single write is the Worker-side
  // draft PR. No `js-install`.
  "org-spec-audit": { profiles: ["public-repo-read"], rollout: "legacy" },
  // `triage-prs` never enters a container: every read is a Worker-side
  // `github` call and its single write is the Worker-side draft PR. An empty
  // profile list is the honest grant, not an oversight.
  "triage-prs": { profiles: [], rollout: "legacy" },
  // Same shape, and the same empty grant. `triage-issues` reads issues and
  // writes labels/comments/closes entirely Worker-side through the `github`
  // capability, and its model call goes through the metered proxy — so it needs
  // no egress profile at all. Notably it never executes the command repros it
  // captures, which is exactly why it needs no container to execute them in.
  "triage-issues": { profiles: [], rollout: "legacy" },
  "ci-triage-pr": { profiles: JS_BUILD, rollout: "legacy" },
  "refresh-fixtures": { profiles: JS_BUILD, rollout: "legacy" },
  "release-notes": { profiles: JS_BUILD, rollout: "legacy" },
  // The Cloudflare reads happen Worker-side through the `cloudflare`
  // capability, not from the container — so `cf-api` is deliberately absent.
  "finops-audit": { profiles: ["public-repo-read"], rollout: "legacy" },
  "contextful-measures": { profiles: ["public-repo-read", "rust-install"], rollout: "legacy" },
  "contextful-protocol": { profiles: ["public-repo-read", "rust-install"], rollout: "legacy", facadeGaps: ["container-artifact"] },
  // The parent uses Worker-side GitHub and child-run capabilities only.
  "contextful-release": { profiles: [], rollout: "legacy" },
  // Cells and the formula clone the public tree, build with Cargo, and upload
  // container artifacts; the substrate facade does not serve that upload yet.
  "contextful-release-cell": {
    profiles: ["public-repo-read", "rust-install"], rollout: "legacy",
    facadeGaps: ["container-artifact"],
  },
  "contextful-release-formula": {
    profiles: ["public-repo-read", "rust-install"], rollout: "legacy",
    facadeGaps: ["container-artifact"],
  },

  // --- deploy --------------------------------------------------------------
  // `cf-api` is where `wrangler deploy` sends its bytes; `wrangler` itself
  // comes off the npm registry. The pre-assertion is the other half: the
  // definition vouches for the deploy verb, and nothing else.
  "worker-deploy": {
    profiles: ["public-repo-read", "js-install", "cf-api"],
    rollout: "legacy",
    preAsserts: ["wrangler deploy/secret/d1"],
  },
  "deploy-smoke": {
    profiles: ["browser-fetch"],
    rollout: "legacy",
    targets: {
      hostPatterns: ["*.workers.dev", "*.pages.dev", "*.fractalbox.dev"],
      from: baseUrlTarget,
    },
  },

  // --- browser / e2e -------------------------------------------------------
  "playwright-e2e": {
    profiles: [...JS_BUILD, "browser-fetch"],
    rollout: "legacy",
    targets: {
      hostPatterns: ["*.workers.dev", "*.pages.dev", "*.fractalbox.dev"],
      from: baseUrlTarget,
    },
  },
  "playwright-demo": {
    profiles: [...JS_BUILD, "browser-fetch"],
    rollout: "legacy",
    facadeGaps: ["container-artifact"],
  },
  "product-demo": {
    profiles: [...JS_BUILD, "browser-fetch"],
    rollout: "legacy",
    facadeGaps: ["detached-process", "expose-port", "container-artifact"],
  },
  "cdp-acceptance": {
    profiles: [...JS_BUILD, "browser-fetch"],
    rollout: "legacy",
    facadeGaps: ["detached-process", "expose-port", "container-artifact"],
  },
  "demo-reel": { profiles: JS_BUILD, rollout: "legacy", facadeGaps: ["container-artifact"] },
  // Drives a third-party auth flow with curl; its endpoints are the run's own
  // config, not a dispatch input, so there is no target schema to declare yet.
  "email-otp-login": { profiles: JS_BUILD, rollout: "legacy", facadeGaps: ["container-artifact"] },

  // --- agent tier ----------------------------------------------------------
  // The agent reaches its model through the Worker's own proxy route, so no
  // model host is admitted. It opens its PR through the Worker as well.
  "self-heal-pr": {
    profiles: JS_BUILD,
    rollout: "legacy",
    facadeGaps: ["detached-process", "container-artifact"],
  },
};

/**
 * The grant for a run. An unregistered name gets the closed default — no
 * profiles, `legacy` — rather than an inherited one: a run nobody has reviewed
 * must not pick up another run's reach.
 */
export const runGrant = (run: string): RunGrant =>
  Object.hasOwn(RUN_GRANTS, run) ? RUN_GRANTS[run]! : { profiles: [], rollout: "legacy" };

/** Whether the facade can serve this run at all — see `FacadeGap`. */
export const runsOnFacade = (run: string): boolean => (runGrant(run).facadeGaps ?? []).length === 0;

/**
 * Host glob matching, the substrate's shape: anchored at both ends, `*` matches
 * exactly one label and never a dot. Duplicated here on purpose — the check has
 * to run at the dispatch, before anything crosses the service binding.
 */
export const hostMatchesPattern = (pattern: string, host: string): boolean => {
  const p = pattern.trim().toLowerCase();
  const h = host.trim().toLowerCase();
  if (!p || !h) return false;
  if (!p.includes("*")) return p === h;
  const source = p
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]+");
  return new RegExp(`^${source}$`).test(h);
};

export type TargetResolution =
  | { readonly ok: true; readonly hosts: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve a run's dynamic targets from its decoded inputs, refusing any host
 * outside the declared pattern (ADR-0005 — this fails the dispatch, not the
 * policy). A run with no target schema resolves to no targets, and a target it
 * cannot parse as an https URL is a refusal rather than a silently dropped host.
 */
export const resolveTargets = (run: string, inputs: unknown): TargetResolution => {
  const schema = runGrant(run).targets;
  if (schema === undefined) return { ok: true, hosts: [] };

  const hosts: string[] = [];
  for (const raw of schema.from(inputs)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: `target ${JSON.stringify(raw)} is not a URL` };
    }
    if (url.protocol !== "https:")
      return { ok: false, reason: `target ${url.origin} is not https` };
    const host = url.hostname.toLowerCase();
    if (!schema.hostPatterns.some((pattern) => hostMatchesPattern(pattern, host)))
      return {
        ok: false,
        reason: `target host ${host} is outside ${run}'s declared pattern (${schema.hostPatterns.join(", ")})`,
      };
    if (!hosts.includes(host)) hosts.push(host);
  }
  return { ok: true, hosts };
};

/** Lowercase hex SHA-256 — binds an attestation to the exact command text. */
const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Mint the `approvedBy: "run-definition"` attestation for one command, or
 * `undefined` when this run's definition does not vouch for it (ADR-0007).
 *
 * The rule is a subset test, not a match test: the command must match at least
 * one floor rule and *every* rule it matches must be pre-asserted. A deploy
 * command that grew a `git push` therefore mints nothing and is refused by the
 * substrate, which is the whole point of pre-asserting a verb rather than a run.
 *
 * `taskId`/`ordinal` scope the attestation to one step of one execution — a
 * decision for step 3 cannot satisfy step 7.
 */
export const preAssertedApproval = async (
  run: string,
  command: string,
  scope: { taskId: string; ordinal: number },
): Promise<ApprovalAttestation | undefined> => {
  const matched = Object.keys(FLOOR_MIRROR).filter((rule) => FLOOR_MIRROR[rule]!.test(command));
  if (matched.length === 0) return undefined;

  const preAsserts = runGrant(run).preAsserts ?? [];
  if (!matched.every((rule) => preAsserts.includes(rule))) return undefined;

  return {
    taskId: scope.taskId,
    ordinal: scope.ordinal,
    commandSha256: await sha256Hex(command),
    approvedBy: "run-definition",
    approvedAt: Date.now(),
  };
};
