// Merge the committed wrangler.jsonc's `limits`, each container's `rollout_*`
// settings, and its Durable Object bindings and migrations into the operator
// overlay.
//
// The deploy writes the overlay over the committed file, so a setting with no
// account-specific value reaches production only through this merge. A value
// the overlay sets wins; one it omits comes from the template. Rollout
// settings join by `class_name`; a container the template lacks is unchanged.
// Durable Objects merge only when the overlay's migration tags are a strict
// prefix of the template's: the overlay then takes the template's migrations
// and every template binding it lacks. An overlay whose migrations diverge
// keeps its own Durable Objects unchanged.
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
  const templateMigrations = Array.isArray(template.migrations) ? template.migrations : [];
  const overlayMigrations = Array.isArray(overlay.migrations) ? overlay.migrations : undefined;
  if (
    overlayMigrations !== undefined &&
    overlayMigrations.length < templateMigrations.length &&
    overlayMigrations.every((migration, i) => migration?.tag === templateMigrations[i]?.tag)
  ) {
    overlay.migrations = templateMigrations;
    const own = overlay.durable_objects?.bindings ?? [];
    const added = (template.durable_objects?.bindings ?? []).filter(
      (binding) => !own.some((existing) => existing.name === binding.name),
    );
    overlay.durable_objects = { ...overlay.durable_objects, bindings: [...own, ...added] };
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
  console.log(`durable objects: ${(config.durable_objects?.bindings ?? []).map((binding) => binding.class_name).join(", ")}`);
  for (const container of config.containers ?? []) {
    const rollout = Object.entries(container).filter(([key]) => key.startsWith("rollout_"));
    if (rollout.length > 0) console.log(`${container.class_name}: ${JSON.stringify(Object.fromEntries(rollout))}`);
  }
}
