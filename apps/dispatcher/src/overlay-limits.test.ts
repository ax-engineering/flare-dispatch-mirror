// The deploy writes the operator overlay over the committed wrangler.jsonc, so a
// setting that carries no account-specific value reaches production only when
// the deploy merges it back. `limits` is such a setting: a release cell's
// polling steps spend one instance's subrequest budget before its publish
// steps run, and the Workers Paid default (10,000 per instance) ends a long
// build's publish.
//
// Runs under plain Node (the dispatcher's vitest project), so reading the
// committed wrangler config is fine here.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mergeOverlayLimits, parseJsonc } from "../../../infra/overlay-limits.mjs";

type Container = { class_name: string; rollout_active_grace_period?: number; max_instances?: number };

const template = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");

describe("the committed wrangler.jsonc", () => {
  it("raises the per-instance subrequest limit to the Workers Paid ceiling", () => {
    const config = parseJsonc(template) as { limits?: { subrequests?: number } };
    expect(config.limits?.subrequests).toBe(10_000_000);
  });

  it("keeps a deploy's rollout off a release container for a whole build and its collect", () => {
    // A rollout replaces an active instance once its grace has passed, and a
    // replaced release container loses its build: 14400 s build ceiling plus
    // the 1800 s collect step.
    const config = parseJsonc(template) as { containers: Container[] };
    const release = config.containers.find((container) => container.class_name === "RunSandboxRelease");
    expect(release?.rollout_active_grace_period).toBeGreaterThanOrEqual(14_400 + 1_800);
  });
});

describe("mergeOverlayLimits", () => {
  const overlay = `{
  // operator overlay
  "name": "flare-dispatch",
  "vars": { "PUBLIC_ORIGIN": "https://dispatch.example" },
}`;

  it("carries the template's limits into an overlay that sets none", () => {
    const merged = parseJsonc(mergeOverlayLimits(template, overlay)) as {
      name: string; vars: { PUBLIC_ORIGIN: string }; limits: { subrequests: number };
    };
    expect(merged.limits.subrequests).toBe(10_000_000);
    expect(merged.name).toBe("flare-dispatch");
    expect(merged.vars.PUBLIC_ORIGIN).toBe("https://dispatch.example");
  });

  it("keeps a limit the overlay sets and adds the ones it omits", () => {
    const own = `{ "name": "x", "limits": { "subrequests": 50000, "cpu_ms": 30000 } }`;
    const tpl = `{ "limits": { "subrequests": 10000000, "cpu_ms": 1000 } }`;
    expect((parseJsonc(mergeOverlayLimits(tpl, own)) as { limits: unknown }).limits)
      .toEqual({ subrequests: 50000, cpu_ms: 30000 });
    const partial = `{ "name": "x", "limits": { "cpu_ms": 30000 } }`;
    expect((parseJsonc(mergeOverlayLimits(tpl, partial)) as { limits: unknown }).limits)
      .toEqual({ subrequests: 10000000, cpu_ms: 30000 });
  });

  it("leaves an overlay unchanged when the template sets no limits", () => {
    expect(parseJsonc(mergeOverlayLimits(`{ "name": "t" }`, overlay))).toEqual(parseJsonc(overlay));
  });

  it("carries a template container's rollout settings into the overlay container of the same class", () => {
    const tpl = `{ "containers": [
      { "class_name": "RunSandboxRelease", "max_instances": 8, "rollout_active_grace_period": 16800 },
      { "class_name": "RunSandboxAgent", "rollout_step_percentage": 25 },
    ] }`;
    const own = `{ "name": "x", "containers": [
      { "class_name": "RunSandboxRelease", "max_instances": 4 },
      { "class_name": "RunSandboxAgent", "rollout_step_percentage": 100 },
      { "class_name": "RunSandboxBrowser" },
    ] }`;
    const merged = parseJsonc(mergeOverlayLimits(tpl, own)) as { containers: Container[] };
    expect(merged.containers).toEqual([
      { class_name: "RunSandboxRelease", max_instances: 4, rollout_active_grace_period: 16800 },
      { class_name: "RunSandboxAgent", rollout_step_percentage: 100 },
      { class_name: "RunSandboxBrowser" },
    ]);
  });

  describe("Durable Objects", () => {
    type Config = {
      durable_objects?: { bindings: { name: string; class_name: string }[] };
      migrations?: { tag: string; new_sqlite_classes?: string[] }[];
    };
    const tpl = `{
      "durable_objects": { "bindings": [
        { "name": "AGENT_BUDGET", "class_name": "AgentBudget" },
        { "name": "COMPILE_CACHE_LEDGER", "class_name": "CompileCacheLedger" },
      ] },
      "migrations": [
        { "tag": "v0", "new_sqlite_classes": ["AgentBudget"] },
        { "tag": "v1", "new_sqlite_classes": ["CompileCacheLedger"] },
      ],
    }`;

    it("adds a template binding the overlay lacks, with its migration, when the overlay's migrations lead the template's", () => {
      const own = `{ "name": "x",
        "durable_objects": { "bindings": [{ "name": "AGENT_BUDGET", "class_name": "AgentBudget" }] },
        "migrations": [{ "tag": "v0", "new_sqlite_classes": ["AgentBudget"] }] }`;
      const merged = parseJsonc(mergeOverlayLimits(tpl, own)) as Config;
      expect(merged.durable_objects?.bindings.map((binding) => binding.name)).toEqual(["AGENT_BUDGET", "COMPILE_CACHE_LEDGER"]);
      expect(merged.migrations?.map((migration) => migration.tag)).toEqual(["v0", "v1"]);
    });

    it("leaves an overlay whose migrations diverge from the template's unchanged", () => {
      const own = `{ "name": "x",
        "durable_objects": { "bindings": [{ "name": "AGENT_BUDGET", "class_name": "AgentBudget" }] },
        "migrations": [{ "tag": "own-v0", "new_sqlite_classes": ["AgentBudget"] }] }`;
      expect(parseJsonc(mergeOverlayLimits(tpl, own))).toEqual(parseJsonc(own));
    });

    it("keeps a binding the overlay already declares", () => {
      const own = `{ "name": "x",
        "durable_objects": { "bindings": [
          { "name": "AGENT_BUDGET", "class_name": "AgentBudget" },
          { "name": "COMPILE_CACHE_LEDGER", "class_name": "CompileCacheLedger" },
        ] },
        "migrations": [
          { "tag": "v0", "new_sqlite_classes": ["AgentBudget"] },
          { "tag": "v1", "new_sqlite_classes": ["CompileCacheLedger"] },
        ] }`;
      expect(parseJsonc(mergeOverlayLimits(tpl, own))).toEqual(parseJsonc(own));
    });

    it("carries the committed wrangler.jsonc's ledger into an overlay that predates it", () => {
      const committed = parseJsonc(template) as Config;
      const own = JSON.stringify({
        name: "x",
        durable_objects: {
          bindings: committed.durable_objects!.bindings.filter((binding) => binding.name !== "COMPILE_CACHE_LEDGER"),
        },
        migrations: committed.migrations!.filter((migration) => !migration.new_sqlite_classes?.includes("CompileCacheLedger")),
      });
      const merged = parseJsonc(mergeOverlayLimits(template, own)) as Config;
      expect(merged.durable_objects?.bindings).toContainEqual({ name: "COMPILE_CACHE_LEDGER", class_name: "CompileCacheLedger" });
      expect(merged.migrations).toEqual(committed.migrations);
    });
  });
});
