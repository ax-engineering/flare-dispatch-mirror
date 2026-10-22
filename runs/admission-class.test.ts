// Catalog-level guard for `limits.admissionClass`
// (specs/adr/0009-fast-trustworthy-verdicts.md § Interactive admission class).
//
// An interactive run is admitted ahead of every batch run in its pool, so the
// set is a deliberate list: the PR verdicts and the deploy someone waits on.
// The assertion derives from the whole catalog, so a new run that declares
// `interactive` fails here until the list is updated on purpose.

import { describe, expect, it } from "vitest";
import type { Run } from "@fractalboxdev/flare-dispatch-core";
import * as catalog from "./index";

const runs = Object.values(catalog) as ReadonlyArray<Run<unknown, unknown>>;

describe("admissionClass catalog", () => {
  it("admits exactly the waited-on runs in the interactive class", () => {
    const interactive = runs
      .filter((r) => r.limits.admissionClass === "interactive")
      .map((r) => r.name)
      .sort();
    expect(interactive).toEqual(["offload-test", "oxlint", "pr-review", "worker-deploy"]);
  });

  it("leaves every other run in the default batch class", () => {
    for (const r of runs) {
      expect(["interactive", "batch", undefined]).toContain(r.limits.admissionClass);
    }
  });
});
