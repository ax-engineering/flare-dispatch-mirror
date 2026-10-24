// Cron parity — every armed `triggers.crons` expression MUST bind a registered
// run, and every run whose schedule is not deliberately unarmed MUST be armed.
//
// The two halves of arming a scheduled run live in different files: the cron in
// `wrangler.jsonc`, the run in `RUN_REGISTRY`. Exporting a run from
// `@fractalboxdev/flare-dispatch-runs` is NOT registration — a run exported but
// not in the registry deploys a cron that fires into
// `console.warn("matched no registered runs")`, which nobody reads, and the
// symptom is a scheduled run that silently never ran.
//
// The reverse drift is quieter still: retiring a run leaves an expression that
// wakes the Worker daily to do nothing.
//
// Runs under plain Node (the dispatcher's vitest project), so reading the
// committed wrangler config is fine here.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DELIVERY_SWEEP_CRON } from "./delivery-sweep";
import { COMPILE_CACHE_SWEEP_CRON } from "./routes/compile-cache";
import { runNames, schedulesByCron, scheduledRuns } from "./registry";

/**
 * `wrangler.jsonc` is JSONC — comments and trailing commas. Strip both rather
 * than adding a parser dependency for one test.
 */
const readArmedCrons = (): readonly string[] => {
  const raw = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  const config = JSON.parse(stripped) as { triggers?: { crons?: string[] } };
  return config.triggers?.crons ?? [];
};

/**
 * Runs that declare a schedule and are deliberately NOT armed, each because
 * arming it is a product decision — mirrored from the `wrangler.jsonc` comment
 * that explains why. Adding a name here is the deliberate act; forgetting to is
 * what this test catches.
 */
const DELIBERATELY_UNARMED = new Set(["release-notes", "product-demo", "contextful-measures", "contextful-protocol"]);

describe("cron parity", () => {
  it("every armed cron binds at least one registered run", () => {
    const armed = readArmedCrons();
    // Guard against the parity test's own failure mode: a JSONC strip that
    // silently yields no crons passes every assertion below while checking
    // nothing.
    expect(armed.length).toBeGreaterThan(0);
    // The two sweeps' crons are the armed expressions that bind no run: the
    // scheduled handler routes each to its sweep.
    expect(
      armed.filter(
        (cron) =>
          cron !== DELIVERY_SWEEP_CRON && cron !== COMPILE_CACHE_SWEEP_CRON && schedulesByCron(cron).length === 0,
      ),
    ).toEqual([]);
  });

  it("arms the verdict reconcile sweep", () => {
    expect(readArmedCrons()).toContain(DELIVERY_SWEEP_CRON);
  });

  it("arms the compile-cache sweep", () => {
    expect(readArmedCrons()).toContain(COMPILE_CACHE_SWEEP_CRON);
  });

  it("every cron a scheduled run declares is armed unless deliberately left off", () => {
    const armed = new Set(readArmedCrons());
    // EVERY declared expression, not merely one per run: a run that declares
    // two schedules and has one armed is half-dead in exactly the way the file
    // header describes, and an any-cron assertion reports it as healthy.
    const missing = scheduledRuns()
      .filter((r) => !DELIBERATELY_UNARMED.has(r.name))
      .flatMap((r) =>
        r.crons.filter((cron) => !armed.has(cron)).map((cron) => `${r.name}: ${cron}`),
      );
    expect(missing).toEqual([]);
  });

  it("names every deliberately-unarmed run, so the list can't outlive its runs", () => {
    const known = new Set(runNames());
    expect([...DELIBERATELY_UNARMED].filter((n) => !known.has(n))).toEqual([]);
  });

  it("drops a run from the unarmed list as soon as it is actually armed", () => {
    // The list only rots in one direction without this. Arming `release-notes`
    // in wrangler.jsonc satisfies every assertion above — the run is armed, so
    // nothing reports it missing — while the list keeps asserting it is a
    // deliberate omission, and the comment explaining why it is unarmed
    // silently becomes false.
    const armed = new Set(readArmedCrons());
    const armedButListed = scheduledRuns()
      .filter((r) => DELIBERATELY_UNARMED.has(r.name))
      .filter((r) => r.crons.some((cron) => armed.has(cron)))
      .map((r) => r.name);
    expect(armedButListed).toEqual([]);
  });

  it("arms no contextful schedule", () => {
    // contextful uses FlareDispatch for tag releases only.
    const armed = readArmedCrons();
    const contextful = scheduledRuns().filter((r) => r.name.startsWith("contextful-"));
    for (const { crons } of contextful) {
      for (const cron of crons) expect(armed).not.toContain(cron);
    }
    expect(contextful.length).toBeGreaterThan(0);
  });

});
