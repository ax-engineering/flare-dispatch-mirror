// The modeled per-run benchmark behind /benchmarks/ and the landing page's cost card:
// a curated workload profile per run (instance type, typical wall-time, model-call
// shape), priced at build time through the cost engine that meters real executions
// (packages/core/src/cost.ts). The rate card is imported, not restated, so a rate change
// there reprices this page on the next build.
//
// MODELED, not metered: the profiles are planning estimates. `instance` is the run's
// container class (lean/browser → standard-2, agent → standard-3). `wallSeconds` is a
// typical end-to-end time; `containerSeconds` is the container-active window — the whole
// wall for test-running runs, far less for model-calling runs whose container only clones
// and diffs. Model-calling runs are priced on the Anthropic backend as a representative
// metered figure; the default Workers AI catalog backend bills as account-level Neurons.
import {
  INSTANCE_SPECS,
  containerCostMicroUsd,
  containerMicroUsdPerSec,
  modelCost,
  type InstanceType,
} from "@fractalboxdev/flare-dispatch-core/cost";

type Profile = {
  readonly name: string;
  readonly kind: "github-event" | "wall-clock";
  readonly instance: InstanceType;
  readonly wallSeconds: number;
  readonly containerSeconds: number;
  readonly model: { readonly id: string; readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly note: string;
};

const REP_MODEL = "anthropic/claude-sonnet-4-6";

const PROFILES: readonly Profile[] = [
  {
    name: "pr-review",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 45,
    containerSeconds: 6,
    model: { id: REP_MODEL, inputTokens: 105_000, outputTokens: 7_000 },
    note: "Multi-agent fan-out (up to 7 reviewers, each embedding the diff). Model cost on the Anthropic backend; the default Workers AI catalog backend is account-billed.",
  },
  {
    name: "offload-test",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 480,
    containerSeconds: 480,
    model: null,
    note: "Clone → install → `pnpm test` → log. Container compute is ~95% of marginal cost.",
  },
  {
    name: "matrix-fanout",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 480,
    containerSeconds: 480,
    model: null,
    note: "Per shard; N shards run concurrently across containers (×N container cost).",
  },
  {
    name: "vitest-shard",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 300,
    containerSeconds: 300,
    model: null,
    note: "One container per `--shard=i/n` slice.",
  },
  {
    name: "oxlint",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 25,
    containerSeconds: 25,
    model: null,
    note: "Install-free lint gate; the cheapest run (no node_modules, short wall-time).",
  },
  {
    name: "cdp-acceptance",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 120,
    containerSeconds: 120,
    model: null,
    note: "Boot app + CDP assertions. Browser Rendering hours add on top (within the included 10 hr/mo at low volume).",
  },
  {
    name: "playwright-e2e",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 480,
    containerSeconds: 480,
    model: null,
    note: "Playwright specs → signed R2 tarball. Browser Rendering hours add on top.",
  },
  {
    name: "playwright-demo",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 120,
    containerSeconds: 120,
    model: null,
    note: "Smaller Playwright walkthrough.",
  },
  {
    name: "product-demo",
    kind: "wall-clock",
    instance: "standard-3",
    wallSeconds: 180,
    containerSeconds: 180,
    model: { id: "@cf/demo-agent", inputTokens: 0, outputTokens: 0 },
    note: "AI-driven CDP walkthrough on the agent image (chromium + demo-agent). The demo-agent's model cost is account-billed Workers AI.",
  },
  {
    name: "deploy-smoke",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 60,
    containerSeconds: 60,
    model: null,
    note: "Post-deploy health probe.",
  },
  {
    name: "email-otp-login",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 90,
    containerSeconds: 90,
    model: null,
    note: "Drives an OTP / magic-link login through a disposable inbox.",
  },
  {
    name: "refresh-fixtures",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 120,
    containerSeconds: 120,
    model: null,
    note: "Regenerates fixtures and proposes a writeback PR.",
  },
  {
    name: "ci-triage-pr",
    kind: "github-event",
    instance: "standard-2",
    wallSeconds: 40,
    containerSeconds: 5,
    model: { id: REP_MODEL, inputTokens: 12_000, outputTokens: 1_500 },
    note: "Reads the failure signals and asks a model to triage. Model cost on the Anthropic backend.",
  },
  {
    name: "spec-drift-pr",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 90,
    containerSeconds: 30,
    model: { id: REP_MODEL, inputTokens: 40_000, outputTokens: 4_000 },
    note: "Reconciles specs and code into a draft PR. Model cost on the Anthropic backend.",
  },
  {
    name: "release-notes",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 30,
    containerSeconds: 5,
    model: { id: REP_MODEL, inputTokens: 8_000, outputTokens: 2_000 },
    note: "Summarizes merged PRs since the last tag. Model cost on the Anthropic backend.",
  },
  {
    name: "finops-audit",
    kind: "wall-clock",
    instance: "standard-2",
    wallSeconds: 30,
    containerSeconds: 2,
    model: { id: REP_MODEL, inputTokens: 3_000, outputTokens: 1_500 },
    note: "Weekly cost review from account usage. Model cost on the Anthropic backend.",
  },
];

export type BenchmarkRow = Profile & {
  readonly containerMicroUsd: number;
  /** null when the model is unmetered (Workers AI catalog) or the run calls none. */
  readonly modelMicroUsd: number | null;
  readonly modelMetered: boolean;
  readonly totalMicroUsd: number;
};

export const benchmarks: readonly BenchmarkRow[] = PROFILES.map((p) => {
  const container = containerCostMicroUsd({ instance: p.instance, activeSeconds: p.containerSeconds });
  const model = p.model === null ? null : modelCost({ model: p.model.id, ...p.model });
  const modelMicroUsd = model?.microUsd ?? null;
  return {
    ...p,
    containerMicroUsd: container,
    modelMicroUsd,
    modelMetered: model?.rateKnown ?? false,
    totalMicroUsd: container + (modelMicroUsd ?? 0),
  };
});

/** Container rate for an instance, in micro-USD per active second. */
export { containerMicroUsdPerSec, INSTANCE_SPECS };
