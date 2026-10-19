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

const template = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");

describe("the committed wrangler.jsonc", () => {
  it("raises the per-instance subrequest limit to the Workers Paid ceiling", () => {
    const config = parseJsonc(template) as { limits?: { subrequests?: number } };
    expect(config.limits?.subrequests).toBe(10_000_000);
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
});
