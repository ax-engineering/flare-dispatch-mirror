// Cost-engine unit tests — pins the rate card to specs/06-cost.md's worked
// numbers and exercises the metered-vs-modeled basis logic. The docs benchmark
// (apps/docs/src/data/benchmarks.ts) imports this engine directly, so a rate
// change here reprices the site on its next build.

import { describe, expect, it } from "vitest";
import {
  CONTAINER_DISK_MICRO_USD_PER_SEC,
  CONTAINER_GIB_MICRO_USD_PER_SEC,
  CONTAINER_VCPU_MICRO_USD_PER_SEC,
  INSTANCE_SPECS,
  MICRO_USD_PER_USD,
  containerCostMicroUsd,
  containerMicroUsdPerHour,
  estimateExecutionCost,
  formatMicroUsd,
  microUsdToUsd,
  modelCost,
  modelRate,
} from "./cost.js";

describe("rate card (pinned to specs/06-cost.md)", () => {
  it("standard-2 is 1 vCPU / 6 GiB / 12 GB disk", () => {
    expect(INSTANCE_SPECS["standard-2"]).toEqual({ vcpu: 1, gib: 6, diskGb: 12 });
  });

  it("basic, standard-3 and standard-4 carry their provisioned disk", () => {
    expect(INSTANCE_SPECS.basic).toEqual({ vcpu: 1 / 4, gib: 1, diskGb: 4 });
    expect(INSTANCE_SPECS["standard-3"]).toEqual({ vcpu: 2, gib: 8, diskGb: 16 });
    expect(INSTANCE_SPECS["standard-4"]).toEqual({ vcpu: 4, gib: 12, diskGb: 20 });
  });

  it("disk is $0.00000007/GB-s in micro-USD", () => {
    expect(CONTAINER_DISK_MICRO_USD_PER_SEC).toBe(0.07);
  });

  it("prices an hour on the provisioned size", () => {
    // standard-4: 4 × 0.072 + 12 × 0.009 + 20 × 0.000252 = $0.40104/h.
    expect(containerMicroUsdPerHour("standard-4")).toBe(401_040);
    // standard-2: 0.072 + 6 × 0.009 + 12 × 0.000252 = $0.129024/h.
    expect(containerMicroUsdPerHour("standard-2")).toBe(129_024);
  });

  it("container rates are $0.000020/vCPU-s and $0.0000025/GiB-s in micro-USD", () => {
    expect(CONTAINER_VCPU_MICRO_USD_PER_SEC).toBe(20);
    expect(CONTAINER_GIB_MICRO_USD_PER_SEC).toBe(2.5);
    expect(MICRO_USD_PER_USD).toBe(1_000_000);
  });
});

describe("containerCostMicroUsd — spec-06 per-execution anatomy", () => {
  it("standard-2 for an 8-minute run ≈ $0.0172 (the spec's ~$0.017 example)", () => {
    // specs/06-cost.md § Per-execution cost anatomy: a standard-2 (1 vCPU,
    // 6 GiB, 12 GB) running 8 min (480 s) = $0.0096 vCPU + $0.0072 mem +
    // $0.000403 disk ≈ $0.0172.
    const micro = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 480 });
    expect(micro).toBe(17_203);
    expect(microUsdToUsd(micro)).toBeCloseTo(0.0172, 4);
  });

  it("scales linearly with active seconds", () => {
    const a = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 100 });
    const b = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 200 });
    expect(b).toBe(a * 2);
  });

  it("a basic lint container is far cheaper than standard-2", () => {
    const basic = containerCostMicroUsd({ instance: "basic", activeSeconds: 25 });
    const std = containerCostMicroUsd({ instance: "standard-2", activeSeconds: 25 });
    expect(basic).toBeLessThan(std);
  });
});

describe("modelRate — backend-prefixed id resolution", () => {
  it("resolves Claude families from prefixed ids", () => {
    expect(modelRate("anthropic/claude-sonnet-4-6")).toMatchObject({
      inputPerMTokUsd: 3,
      outputPerMTokUsd: 15,
    });
    expect(modelRate("bedrock/us.anthropic.claude-opus-4-6-v1")).toMatchObject({
      inputPerMTokUsd: 5,
      outputPerMTokUsd: 25,
    });
    expect(modelRate("anthropic/claude-haiku-4-5")).toMatchObject({
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 5,
    });
  });

  it("hosted DeepSeek gets the approximate reasoner rate", () => {
    expect(modelRate("deepseek/deepseek-reasoner")).toMatchObject({
      inputPerMTokUsd: 0.55,
      outputPerMTokUsd: 2.19,
    });
  });

  it("GPT-5.6 Luna gets its rate; an unknown -pro sibling stays unmetered", () => {
    expect(modelRate("openai/gpt-5.6-luna")).toMatchObject({
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 6,
    });
    // `endsWith` matching — a differently-priced sibling must NOT silently
    // bill at Luna's rate.
    expect(modelRate("openai/gpt-5.6-luna-pro")).toBeNull();
  });

  it("Workers AI catalog (@cf/…) is UNMETERED — even a catalog distill named deepseek", () => {
    expect(modelRate("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBeNull();
    // The @cf check MUST precede the deepseek substring match.
    expect(modelRate("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b")).toBeNull();
  });
});

describe("modelCost — tokens × rate", () => {
  it("opus: 1000 in + 500 out = 17500 µ$ ($0.0175)", () => {
    // 1000 × $5/1M + 500 × $25/1M = $0.005 + $0.0125 = $0.0175.
    const mc = modelCost({
      model: "anthropic/claude-opus-4-6",
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(mc.rateKnown).toBe(true);
    expect(mc.microUsd).toBe(17_500);
  });

  it("catalog model: microUsd is null but tokens are retained", () => {
    const mc = modelCost({
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      inputTokens: 4000,
      outputTokens: 800,
    });
    expect(mc.microUsd).toBeNull();
    expect(mc.rateKnown).toBe(false);
    expect(mc.inputTokens).toBe(4000);
    expect(mc.outputTokens).toBe(800);
  });
});

describe("estimateExecutionCost — honesty basis", () => {
  it("metered model tokens + modeled container → mixed (the pr-review shape)", () => {
    const cost = estimateExecutionCost({
      container: { instance: "standard-2", activeSeconds: 10 },
      model: {
        model: "anthropic/claude-sonnet-4-6",
        inputTokens: 20_000,
        outputTokens: 2_000,
        metered: true,
      },
    });
    expect(cost.basis).toBe("mixed");
    expect(cost.modelMicroUsd).toBe(20_000 * 3 + 2_000 * 15); // 90_000
    expect(cost.containerMicroUsd).toBeGreaterThan(0);
    expect(cost.totalMicroUsd).toBe((cost.modelMicroUsd ?? 0) + (cost.containerMicroUsd ?? 0));
  });

  it("container only → modeled (the offload-test shape)", () => {
    const cost = estimateExecutionCost({
      container: { instance: "standard-2", activeSeconds: 480 },
    });
    expect(cost.basis).toBe("modeled");
    expect(cost.modelMicroUsd).toBeNull();
    expect(cost.totalMicroUsd).toBe(17_203);
  });

  it("metered model with no container → metered", () => {
    const cost = estimateExecutionCost({
      model: {
        model: "anthropic/claude-opus-4-6",
        inputTokens: 1000,
        outputTokens: 0,
        metered: true,
      },
    });
    expect(cost.basis).toBe("metered");
  });

  it("estimated tokens (docs benchmark) → modeled, not metered", () => {
    const cost = estimateExecutionCost({
      model: {
        model: "anthropic/claude-sonnet-4-6",
        inputTokens: 30_000,
        outputTokens: 3_000,
        metered: false,
      },
    });
    expect(cost.basis).toBe("modeled");
    expect(cost.modelMicroUsd).toBe(30_000 * 3 + 3_000 * 15);
  });

  it("a catalog model with no container → unmetered", () => {
    const cost = estimateExecutionCost({
      model: {
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        inputTokens: 5000,
        outputTokens: 900,
        metered: true,
      },
    });
    expect(cost.basis).toBe("unmetered");
    expect(cost.modelMicroUsd).toBeNull();
    expect(cost.totalMicroUsd).toBe(0);
  });
});

describe("formatMicroUsd", () => {
  it("renders sub-cent figures at 4 decimals, dollars at 2", () => {
    expect(formatMicroUsd(16_800)).toBe("$0.0168");
    expect(formatMicroUsd(1_500_000)).toBe("$1.50");
    expect(formatMicroUsd(0)).toBe("$0");
  });

  it("renders null (unmetered) as the placeholder", () => {
    expect(formatMicroUsd(null)).toBe("—");
    expect(formatMicroUsd(null, "n/a")).toBe("n/a");
  });
});
