import { describe, expect, it } from "vitest";
import { lookupRun, triggersByEvent } from "./registry";

const CONTEXTFUL_REPO = "fractalboxdev/contextful";

describe("contextful runs", () => {
  it("only a tag release starts a contextful run from a webhook", () => {
    const events = ["pull_request", "push", "pull_request_target", "check_suite", "workflow_dispatch"];
    const started = events.flatMap((event) =>
      triggersByEvent(event)
        .filter((m) => m.run.name.startsWith("contextful-"))
        .map((m) => m.run.name),
    );
    expect([...new Set(started)]).toEqual(["contextful-release"]);
  });

  it("keeps the gate dispatchable by name", () => {
    expect(lookupRun("contextful-gate")).toBeDefined();
    expect(lookupRun("contextful-gate")?.triggers).toEqual([]);
  });

  it("starts a release on a v-tag push", () => {
    const sha = "a".repeat(40);
    const payload = { repository: { full_name: CONTEXTFUL_REPO }, ref: "refs/tags/v1.2.3", after: sha };
    const fired = triggersByEvent("push").filter(
      (m) => m.run.name === "contextful-release" && m.trigger.gate?.({ payload } as never),
    );
    expect(fired).toHaveLength(1);
  });
});
