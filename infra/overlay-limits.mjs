// Merge the committed wrangler.jsonc's `limits` into the operator overlay.
//
// The deploy writes the overlay over the committed file, so a setting with no
// account-specific value reaches production only through this merge. A limit
// the overlay sets wins; one it omits comes from the template.
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
  console.log(`limits: ${JSON.stringify(JSON.parse(merged).limits ?? null)}`);
}
