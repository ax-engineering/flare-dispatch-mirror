// @fractalboxdev/flare-dispatch-core — the cost engine (rate card + pure cost functions).
//
// The single source of truth for "what did an execution cost". Pure: no Effect,
// no I/O, no bindings — just the rate card (mirrored from `specs/06-cost.md` and
// the model rate cards) and pure functions over usage components. Consumed by:
//
//   * the runtime (`packages/runtime-cf`) — to persist a per-execution cost
//     rollup at `finishExecution`;
//   * the docs site (`apps/docs/src/data/benchmarks.ts`) — to price a per-run
//     modeled speed+cost table at build time;
//   * the analytics endpoint + dashboard — to display per-execution cost.
//
// --- metered vs modeled — the load-bearing distinction --------------------------
//
// Cost is METERED only where we have a real measured number. Today that is model
// tokens, and ONLY for backends whose gateway response carries a usage block
// (Anthropic / Bedrock / DeepSeek / OpenAI). It is MODELED everywhere else:
//
//   * container compute is ALWAYS modeled — `instance vCPU/mem rate × active
//     seconds`. Cloudflare meters container vCPU-s at the ACCOUNT level only
//     (the `cloudflare.usage` GraphQL surface), never per-execution, so a
//     per-execution container number is a model, not a meter.
//   * Workers AI catalog models (`@cf/…`) expose NO token usage (the binding is
//     the auth, billing is account-level Neurons) — so their model cost is
//     UNMETERED. We never invent a USD figure for them; `microUsd` is `null`.
//
// `estimateExecutionCost` returns a per-component breakdown plus an overall
// `basis` so every surface can label honestly. NEVER present a modeled number as
// metered (the project pressure-tests cost claims).
//
// Money is integer **micro-USD** (1 USD = 1_000_000 µ$) to avoid float drift in
// the persisted rollup. The published rate cards are USD-per-million-tokens and
// USD-per-vCPU-second, which fall out to clean µ$ factors (see below).
//
// Spec: specs/06-cost.md (pricing model + worked per-execution anatomy).

/** One micro-USD. 1 USD = 1_000_000 µ$. The persisted/returned unit. */
export const MICRO_USD_PER_USD = 1_000_000;

// --- Container instance types ---------------------------------------------------
//
// Provisioned vCPU, memory and disk per Cloudflare Containers instance type
// (specs/05-byoc.md § Wrangler config, "Instance types (2026-05)"). A run's
// instance type is fixed by the container class its `sandboxImage` selects in
// wrangler.jsonc — the one table is `SANDBOX_CONTAINER` in runtime-cf
// execution-cost.ts, checked against that file by its test.

export type InstanceType =
  | "lite"
  | "basic"
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4";

export type InstanceSpec = {
  /** Allotted vCPU for the instance type. */
  readonly vcpu: number;
  /** Allotted memory in GiB. */
  readonly gib: number;
  /** Provisioned disk in GB. */
  readonly diskGb: number;
};

/** vCPU / memory / disk by instance type (specs/05-byoc.md § Wrangler config). */
export const INSTANCE_SPECS: Record<InstanceType, InstanceSpec> = {
  lite: { vcpu: 1 / 16, gib: 0.25, diskGb: 2 },
  basic: { vcpu: 1 / 4, gib: 1, diskGb: 4 },
  "standard-1": { vcpu: 1 / 2, gib: 4, diskGb: 8 },
  "standard-2": { vcpu: 1, gib: 6, diskGb: 12 },
  "standard-3": { vcpu: 2, gib: 8, diskGb: 16 },
  "standard-4": { vcpu: 4, gib: 12, diskGb: 20 },
} as const;

// --- Container rates (specs/06-cost.md § Pricing model) -------------------------
//
// List prices on the PROVISIONED size: $0.000020 / vCPU-s, $0.0000025 / GiB-s
// and $0.00000007 / GB-s of disk. In µ$: multiply USD by 1e6.
//   $0.000020 × 1e6 = 20 µ$ per vCPU-second
//   $0.0000025 × 1e6 = 2.5 µ$ per GiB-second
//   $0.00000007 × 1e6 = 0.07 µ$ per disk GB-second
// Cloudflare bills active vCPU, so a provisioned-size rate is an upper bound on
// the billed rate — the direction a spend cap wants (ADR-0006 § Meter).

/** Container vCPU-second rate, in micro-USD (`$0.000020/vCPU-s`). */
export const CONTAINER_VCPU_MICRO_USD_PER_SEC = 20;
/** Container memory GiB-second rate, in micro-USD (`$0.0000025/GiB-s`). */
export const CONTAINER_GIB_MICRO_USD_PER_SEC = 2.5;
/** Container disk GB-second rate, in micro-USD (`$0.00000007/GB-s`). */
export const CONTAINER_DISK_MICRO_USD_PER_SEC = 0.07;

/** One instance's list rate per active second, in (fractional) micro-USD. */
export const containerMicroUsdPerSec = (instance: InstanceType): number => {
  const spec = INSTANCE_SPECS[instance];
  return (
    spec.vcpu * CONTAINER_VCPU_MICRO_USD_PER_SEC +
    spec.gib * CONTAINER_GIB_MICRO_USD_PER_SEC +
    spec.diskGb * CONTAINER_DISK_MICRO_USD_PER_SEC
  );
};

/**
 * One instance's list rate per hour, in whole micro-USD — the unit the burn
 * ceiling sums across admitted executions (`run_admissions.hourly_rate_micro_usd`).
 * `standard-4` ≈ $0.401/h, `standard-2` ≈ $0.129/h.
 */
export const containerMicroUsdPerHour = (instance: InstanceType): number =>
  Math.round(containerMicroUsdPerSec(instance) * 3600);

// --- Model token rates ----------------------------------------------------------
//
// USD per MILLION tokens, by model family. The handy identity: micro-USD =
// tokens × (USD per million), since µ$ = (tokens / 1e6 × usdPerM) × 1e6.
//
// Claude rates are authoritative (current model rate card). Bedrock-hosted Claude
// bills at roughly the same per-token rate PLUS the AI Gateway hop + AWS markup
// — treated here as the same planning rate (specs/06-cost.md frames all figures
// as planning estimates). DeepSeek (hosted `reasonix`) is an approximate
// published rate. Workers AI catalog (`@cf/…`) has NO per-token rate — it bills
// as account-level Neurons, so it is UNMETERED here (rate `null`).

export type ModelRate = {
  /** USD per 1M input tokens. */
  readonly inputPerMTokUsd: number;
  /** USD per 1M output tokens. */
  readonly outputPerMTokUsd: number;
  /** Provenance of the rate, for the rate-card footnote. */
  readonly source: string;
};

/**
 * Resolve a (possibly backend-prefixed) model id to its per-token rate, or
 * `null` when the model is unmetered (Workers AI catalog) or unknown. Ordered:
 * the `@cf/` catalog check runs FIRST so a catalog distill that happens to carry
 * "deepseek" in its id (e.g. `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`) is
 * correctly classified unmetered, not billed at DeepSeek's hosted rate.
 *
 * Matching is by family substring so the prefixed ids the runtime actually sees
 * resolve: `anthropic/claude-sonnet-4-6`, `bedrock/us.anthropic.claude-opus-4-6-v1`,
 * `deepseek/deepseek-reasoner`, `openai/gpt-5.6-luna`,
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
 */
export const modelRate = (model: string): ModelRate | null => {
  const id = model.toLowerCase();
  // Workers AI catalog: the binding is the auth, billing is account-level
  // Neurons — no per-token rate exists. UNMETERED. Check before any family
  // substring so catalog-hosted distills don't match a hosted rate.
  if (id.startsWith("@cf/")) return null;
  if (id.includes("opus-4")) {
    return {
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
      source: "Claude Opus rate card ($5 / $25 per 1M tok)",
    };
  }
  if (id.includes("sonnet-4")) {
    return {
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
      source: "Claude Sonnet rate card ($3 / $15 per 1M tok)",
    };
  }
  if (id.includes("haiku-4")) {
    return {
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 5,
      source: "Claude Haiku rate card ($1 / $5 per 1M tok)",
    };
  }
  if (id.includes("deepseek")) {
    return {
      inputPerMTokUsd: 0.55,
      outputPerMTokUsd: 2.19,
      source: "DeepSeek reasoner published rate (approx, planning estimate)",
    };
  }
  // GPT-5.6 Luna (`openai/gpt-5.6-luna`, unified billing via AI Gateway).
  // `endsWith`, not `includes`, so a differently-priced sibling (e.g. a
  // `…-luna-pro`) never silently bills at Luna's rate — an unknown sibling
  // stays honestly unmetered until its rate is added.
  if (id.endsWith("gpt-5.6-luna")) {
    return {
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 6,
      source: "GPT-5.6 Luna rate card ($1 / $6 per 1M tok)",
    };
  }
  return null;
};

// --- Cost components ------------------------------------------------------------

/** A model-inference cost component. `microUsd` is `null` when the model is
 *  unmetered (catalog / unknown) — the tokens are still recorded by the caller,
 *  but no USD figure is invented. */
export type ModelCost = {
  readonly microUsd: number | null;
  /** True when a per-token rate was found (Anthropic/Bedrock/DeepSeek/OpenAI). */
  readonly rateKnown: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * Cost of model inference from token counts. Pure rate application — the caller
 * decides whether the token counts are REAL (metered, from a gateway usage
 * block) or estimated (modeled, for the docs benchmark); `cost.ts` only converts
 * tokens × rate. Unmetered model → `{ microUsd: null, rateKnown: false }`.
 */
export const modelCost = (opts: {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}): ModelCost => {
  const rate = modelRate(opts.model);
  if (rate === null) {
    return {
      microUsd: null,
      rateKnown: false,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
    };
  }
  // µ$ = tokens × (USD per million tokens).
  const microUsd = Math.round(
    opts.inputTokens * rate.inputPerMTokUsd + opts.outputTokens * rate.outputPerMTokUsd,
  );
  return {
    microUsd,
    rateKnown: true,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
  };
};

/**
 * Modeled container-compute cost: `(vCPU-s × vCPU-rate) + (GiB-s × GiB-rate) +
 * (disk GB-s × disk rate)`, each on the instance's provisioned size × active
 * seconds. This is ALWAYS modeled — Cloudflare meters container usage at the
 * account level only, never per-execution.
 */
export const containerCostMicroUsd = (opts: {
  readonly instance: InstanceType;
  /** Seconds the container was active (admission → completion). */
  readonly activeSeconds: number;
}): number => Math.round(containerMicroUsdPerSec(opts.instance) * opts.activeSeconds);

// --- Whole-execution estimate ---------------------------------------------------

/** How a total was arrived at — drives the honesty label on every surface.
 *
 *   `metered`   — every contributing component is metered (real model tokens,
 *                 negligible/absent container compute).
 *   `mixed`     — metered model tokens + modeled container compute.
 *   `modeled`   — no metered component (container-only, or estimated tokens).
 *   `unmetered` — a model ran but its tokens aren't observable (catalog) and
 *                 there's no container compute to model either.
 */
export type CostBasis = "metered" | "mixed" | "modeled" | "unmetered";

export type ExecutionCost = {
  /** Sum of the known component costs, in micro-USD. */
  readonly totalMicroUsd: number;
  /** Modeled container component (µ$), or `null` if no container ran. */
  readonly containerMicroUsd: number | null;
  /** Model component (µ$), or `null` if no model ran or it was unmetered. */
  readonly modelMicroUsd: number | null;
  readonly basis: CostBasis;
};

/**
 * Combine the components into a per-execution rollup with an honest overall
 * `basis`. `modelTokensMetered` tells us whether the model token counts are real
 * (from a gateway usage block) or estimated (docs benchmark) — it only affects
 * the `basis` label, never the arithmetic.
 *
 * Negligible-container rule: when a metered-model execution also ran a tiny
 * container (e.g. `pr-review`'s clone+diff), the overall basis stays `mixed`
 * rather than collapsing to `metered` — the container line, however small, is
 * still modeled. A pure metered result (`basis: "metered"`) only arises when no
 * container component is present at all.
 */
export const estimateExecutionCost = (opts: {
  readonly container?: { readonly instance: InstanceType; readonly activeSeconds: number };
  readonly model?: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    /** Real tokens from a gateway usage block (true) vs estimated (false). */
    readonly metered: boolean;
  };
}): ExecutionCost => {
  const containerMicroUsd =
    opts.container !== undefined ? containerCostMicroUsd(opts.container) : null;

  const mc = opts.model !== undefined ? modelCost(opts.model) : null;
  const modelMicroUsd = mc?.microUsd ?? null;

  const total = (containerMicroUsd ?? 0) + (modelMicroUsd ?? 0);

  // Decide the honesty label.
  const hasMeteredModel =
    mc !== null && mc.rateKnown && opts.model?.metered === true && modelMicroUsd !== null;
  const hasModeledModel =
    mc !== null && mc.rateKnown && opts.model?.metered === false && modelMicroUsd !== null;
  const hasUnmeteredModel = mc !== null && !mc.rateKnown;
  const hasContainer = containerMicroUsd !== null;

  let basis: CostBasis;
  if (hasMeteredModel && hasContainer) basis = "mixed";
  else if (hasMeteredModel) basis = "metered";
  else if (hasContainer || hasModeledModel) basis = "modeled";
  else if (hasUnmeteredModel) basis = "unmetered";
  else basis = "modeled";

  return { totalMicroUsd: total, containerMicroUsd, modelMicroUsd, basis };
};

// --- Display helpers ------------------------------------------------------------

/** Micro-USD → USD (number). */
export const microUsdToUsd = (microUsd: number): number => microUsd / MICRO_USD_PER_USD;

/**
 * Format a micro-USD figure as a short USD string for tables. Picks a precision
 * that keeps sub-cent execution costs legible: 4 decimals under $1, 2 at/above.
 * `null` (unmetered) renders as the supplied placeholder.
 */
export const formatMicroUsd = (microUsd: number | null, placeholder = "—"): string => {
  if (microUsd === null) return placeholder;
  const usd = microUsdToUsd(microUsd);
  if (usd === 0) return "$0";
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
};
