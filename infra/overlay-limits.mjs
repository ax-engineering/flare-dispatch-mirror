// Merge the committed wrangler.jsonc's `limits`, and each container's
// `rollout_*` settings, into the operator overlay.
//
// The deploy writes the overlay over the committed file, so a setting with no
// account-specific value reaches production only through this merge. A value
// the overlay sets wins; one it omits comes from the template. Rollout
// settings join by `class_name`; a container the template lacks is unchanged.
//
// Usage: node infra/overlay-limits.mjs <template.jsonc> <overlay.jsonc>
// rewrites <overlay.jsonc> in place as JSON.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Parse JSONC: block and line comments, trailing commas. */
export const parseJsonc = (text) =>
  JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/,(\s*[}\]])/g, "$1"),
  );

/** The overlay with the template's limits filled in under its own; JSON text. */
export const mergeOverlayLimits = (templateText, overlayText) => {
  const template = parseJsonc(templateText);
  const overlay = parseJsonc(overlayText);
  if (template.limits !== undefined) {
    overlay.limits = { ...template.limits, ...overlay.limits };
  }
  if (Array.isArray(template.containers) && Array.isArray(overlay.containers)) {
    overlay.containers = overlay.containers.map((container) => {
      const own = template.containers.find((entry) => entry.class_name === container.class_name);
      if (own === undefined) return container;
      const rollout = Object.fromEntries(Object.entries(own).filter(([key]) => key.startsWith("rollout_")));
      return { ...container, ...rollout, ...container };
    });
  }
  return `${JSON.stringify(overlay, null, 2)}\n`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [templatePath, overlayPath] = process.argv.slice(2);
  if (templatePath === undefined || overlayPath === undefined) {
    console.error("usage: node infra/overlay-limits.mjs <template.jsonc> <overlay.jsonc>");
    process.exit(2);
  }
  const merged = mergeOverlayLimits(readFileSync(templatePath, "utf8"), readFileSync(overlayPath, "utf8"));
  writeFileSync(overlayPath, merged);
  const config = JSON.parse(merged);
  console.log(`limits: ${JSON.stringify(config.limits ?? null)}`);
  for (const container of config.containers ?? []) {
    const rollout = Object.entries(container).filter(([key]) => key.startsWith("rollout_"));
    if (rollout.length > 0) console.log(`${container.class_name}: ${JSON.stringify(Object.fromEntries(rollout))}`);
  }
}
