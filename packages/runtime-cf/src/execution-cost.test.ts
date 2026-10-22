// The sandbox → container class → instance type table the meter and the burn
// ceiling price runs from, checked against the committed wrangler.jsonc: a
// container class resized there fails here until the table follows
// (specs/adr/0006-spend-guard.md § Meter).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { containerMicroUsdPerHour, type SandboxImage } from "@fractalboxdev/flare-dispatch-core";
import { hourlyRateForSandboxImage, instanceForSandboxImage, SANDBOX_CONTAINER } from "./execution-cost";

/** The committed `wrangler.jsonc`, comments and trailing commas stripped. */
const wrangler = (() => {
  const raw = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");
  return JSON.parse(
    raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1"),
  ) as {
    containers: { class_name: string; instance_type: string }[];
    durable_objects: { bindings: { name: string; class_name: string }[] };
  };
})();

/** The Container binding each sandbox image routes to (sandbox-routing.ts). */
const IMAGE_BINDING: Record<SandboxImage, string> = {
  lean: "RUNS_SANDBOX",
  browser: "RUNS_SANDBOX_BROWSER",
  agent: "RUNS_SANDBOX_AGENT",
  release: "RUNS_SANDBOX_RELEASE",
};

describe("SANDBOX_CONTAINER — the one instance table", () => {
  it("matches each image's container class and instance_type in wrangler.jsonc", () => {
    for (const image of Object.keys(SANDBOX_CONTAINER) as SandboxImage[]) {
      const binding = wrangler.durable_objects.bindings.find((b) => b.name === IMAGE_BINDING[image]);
      expect(binding?.class_name, `${image} binding`).toBe(SANDBOX_CONTAINER[image].className);
      const container = wrangler.containers.find((c) => c.class_name === SANDBOX_CONTAINER[image].className);
      expect(container?.instance_type, `${image} container`).toBe(SANDBOX_CONTAINER[image].instance);
    }
  });

  it("prices the lean image on its standard-4 class, and an unset image as lean", () => {
    expect(instanceForSandboxImage("lean")).toBe("standard-4");
    expect(instanceForSandboxImage(undefined)).toBe("standard-4");
    expect(instanceForSandboxImage("browser")).toBe("standard-2");
    expect(hourlyRateForSandboxImage("agent")).toBe(containerMicroUsdPerHour("standard-3"));
  });
});
