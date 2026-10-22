// Tests for `selectSandboxNs` — the pure run → Container-binding routing.
// Sentinels stand in for the real `DurableObjectNamespace<Sandbox>` values.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { selectAdmission, selectSandboxNs } from "./sandbox-routing";

const lean = "LEAN" as const;
const browser = "BROWSER" as const;
const agent = "AGENT" as const;
const release = "RELEASE" as const;

describe("selectSandboxNs", () => {
  it("routes a browser run to the browser binding when it is bound", () => {
    expect(selectSandboxNs("browser", { lean, browser })).toBe(browser);
  });

  it("degrades a browser run to lean when no browser binding is deployed", () => {
    expect(selectSandboxNs("browser", { lean, browser: undefined })).toBe(lean);
  });

  it("routes an agent run to the agent binding when it is bound", () => {
    expect(selectSandboxNs("agent", { lean, browser, agent })).toBe(agent);
  });

  it("routes a release run to the release toolchain binding", () => {
    expect(selectSandboxNs("release", { lean, browser, release })).toBe(release);
  });

  it("degrades an agent run to lean when no agent binding is deployed", () => {
    expect(selectSandboxNs("agent", { lean, browser })).toBe(lean);
  });

  it("routes an explicit lean run to the lean binding", () => {
    expect(selectSandboxNs("lean", { lean, browser, agent })).toBe(lean);
  });

  it("defaults to lean when the run declares no sandboxImage", () => {
    expect(selectSandboxNs(undefined, { lean, browser, agent })).toBe(lean);
  });
});

/** The committed `wrangler.jsonc`, comments and trailing commas stripped. */
const wrangler = (() => {
  const raw = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1")) as {
    vars: Record<string, string>;
    containers: { class_name: string; max_instances: number }[];
  };
})();
const POOL_CLASS = { lean: "RunSandbox", browser: "RunSandboxBrowser", agent: "RunSandboxAgent", release: "RunSandboxRelease" };
const bound = { RUNS_SANDBOX_BROWSER: browser, RUNS_SANDBOX_AGENT: agent, RUNS_SANDBOX_RELEASE: release };

describe("selectAdmission — the pool a run is metered against and its slot cap", () => {
  it("keeps every pool's cap below its container's max_instances under the committed vars", () => {
    for (const image of ["lean", "browser", "agent", "release"] as const) {
      const { pool, cap } = selectAdmission(image, { ...wrangler.vars, ...bound });
      expect(pool).toBe(image);
      const container = wrangler.containers.find((entry) => entry.class_name === POOL_CLASS[pool])!;
      expect(cap, `${pool} pool`).toBeLessThan(container.max_instances);
    }
  });

  it("keeps every pool's cap below its container's max_instances on the code defaults", () => {
    for (const image of ["lean", "browser", "agent", "release"] as const) {
      const { pool, cap } = selectAdmission(image, bound);
      const container = wrangler.containers.find((entry) => entry.class_name === POOL_CLASS[pool])!;
      expect(cap, `${pool} pool`).toBeLessThan(container.max_instances);
    }
  });

  it("meters every sandbox container class as one pool", () => {
    const sandboxClasses = wrangler.containers
      .map((entry) => entry.class_name)
      .filter((name) => name.startsWith("RunSandbox"))
      .sort();
    expect(sandboxClasses).toEqual(Object.values(POOL_CLASS).sort());
  });

  it("caps the browser pool by ADMISSION_CAP_BROWSER", () => {
    expect(wrangler.vars.ADMISSION_CAP_BROWSER).toBeDefined();
    expect(selectAdmission("browser", { ADMISSION_CAP: "16", ADMISSION_CAP_BROWSER: "4", ...bound })).toEqual({
      pool: "browser",
      cap: 4,
    });
  });

  it("caps the release and agent pools at their eight containers", () => {
    expect(selectAdmission("release", { ...wrangler.vars, ...bound })).toEqual({ pool: "release", cap: 8 });
    expect(selectAdmission("agent", { ...wrangler.vars, ...bound })).toEqual({ pool: "agent", cap: 8 });
    expect(selectAdmission("agent", { ADMISSION_CAP: "16", ...bound })).toEqual({ pool: "agent", cap: 8 });
  });

  it("meters an image whose container is unbound against the lean pool and its cap", () => {
    expect(selectAdmission("release", { ADMISSION_CAP: "16" })).toEqual({ pool: "lean", cap: 16 });
  });
});
