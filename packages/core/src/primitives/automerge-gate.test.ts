// Unit tests for the auto-merge gate — the one place software reaches `main`
// without a human, so the tests are mostly about it saying no.
//
// The pure half (`parseAutomergeConfig`, `evaluateAutomerge`,
// `matchesSensitivePath`) needs no fakes at all. `loadAutomergeConfig` is
// exercised against the `github` fake plus a hand-built failing service, since
// "unreadable ⇒ refuse" is the condition that matters most and the fake never
// fails on its own.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../errors";
import { Github, type GithubService } from "../services/github";
import { makeCFRuntimeTest } from "../testing";
import {
  AUTOMERGE_CONFIG_CLOSED,
  AUTOMERGE_CONFIG_PATH,
  type AutomergeConfig,
  describeVerdict,
  evaluateAutomerge,
  isUnsupportedPathPattern,
  loadAutomergeConfig,
  matchesSensitivePath,
  type MergeCandidate,
  parseAutomergeConfig,
} from "./automerge-gate";

/**
 * A config in the shape a deployment actually ships: the gate off, no repo or
 * class opted in, and a sensitive-path list broad enough that the "even if it
 * were enabled" assertions below have something to bite on.
 */
const SHIPPED_CONFIG = JSON.stringify({
  version: 1,
  enabled: false,
  repos: [],
  classes: [],
  dailyRateLimit: 3,
  sensitivePaths: [
    "wrangler.jsonc",
    ".github/",
    "CODEOWNERS",
    "migrations/",
    "*secret*",
    "*auth*",
    "*token*",
    "maintenance/",
    "specs/",
  ],
  neverEligibleRuns: ["org-spec-audit", "spec-drift-pr", "upstream-upgrade-pr"],
});

/**
 * A config that permits — deliberately NOT the shipped one. Every refusal test
 * starts from this so it proves the named condition did the refusing, rather
 * than riding on `enabled: false` doing all the work.
 */
const PERMISSIVE: AutomergeConfig = {
  enabled: true,
  repos: ["owner/app"],
  classes: ["dependency-patch"],
  // Both vouched for by name. `botAuthors` is the ONLY thing that clears the
  // author condition, so the loop's own login has to be listed here like any
  // other bot — there is no marker that stands in for it.
  botAuthors: ["dependabot[bot]", "flare-dispatch[bot]"],
  sensitivePaths: ["specs/", "*secret*", "CODEOWNERS"],
  neverEligibleRuns: ["org-spec-audit", "spec-drift-pr", "upstream-upgrade-pr"],
  dailyRateLimit: 3,
};

const candidate = (over: Partial<MergeCandidate> = {}): MergeCandidate => ({
  repo: "owner/app",
  number: 12,
  author: "dependabot[bot]",
  changeClass: "dependency-patch",
  changedPaths: ["package.json", "pnpm-lock.yaml"],
  checksGreen: true,
  reviewPosted: true,
  mergesToday: 0,
  ...over,
});

describe("parseAutomergeConfig", () => {
  it("reads the shipped config as off, with its paths and never-eligible runs", () => {
    const { config, malformed } = parseAutomergeConfig(SHIPPED_CONFIG);
    expect(malformed).toBeUndefined();
    expect(config.enabled).toBe(false);
    expect(config.repos).toEqual([]);
    expect(config.neverEligibleRuns).toContain("spec-drift-pr");
    expect(config.sensitivePaths).toContain("specs/");
  });

  it("refuses to coerce a truthy `enabled` — only the literal boolean opens it", () => {
    for (const raw of ['{"enabled":"true"}', '{"enabled":1}', '{"enabled":"yes"}', "{}"]) {
      expect(parseAutomergeConfig(raw).config.enabled).toBe(false);
    }
    expect(parseAutomergeConfig('{"enabled":true}').config.enabled).toBe(true);
  });

  it("yields the closed config for anything unparseable", () => {
    for (const raw of ["not json", "[]", "null", '"a string"']) {
      const { config, malformed } = parseAutomergeConfig(raw);
      expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
      expect(malformed).toBeDefined();
    }
  });

  it("drops non-string entries rather than trusting a mixed array", () => {
    const { config } = parseAutomergeConfig(
      '{"enabled":true,"repos":["owner/a",42,null,{"x":1},"owner/b"]}',
    );
    expect(config.repos).toEqual(["owner/a", "owner/b"]);
  });

  it("treats a missing or nonsense rate limit as zero — which refuses", () => {
    expect(parseAutomergeConfig("{}").config.dailyRateLimit).toBe(0);
    expect(parseAutomergeConfig('{"dailyRateLimit":-3}').config.dailyRateLimit).toBe(0);
    expect(parseAutomergeConfig('{"dailyRateLimit":"3"}').config.dailyRateLimit).toBe(0);
  });
});

describe("matchesSensitivePath", () => {
  it("treats a trailing slash as a directory prefix", () => {
    expect(matchesSensitivePath("specs/03-dsl.md", "specs/")).toBe(true);
    expect(matchesSensitivePath("specs", "specs/")).toBe(true);
    expect(matchesSensitivePath("src/specs-helper.ts", "specs/")).toBe(false);
  });

  it("treats *x* as a case-insensitive substring", () => {
    expect(matchesSensitivePath("src/authGuard.ts", "*auth*")).toBe(true);
    expect(matchesSensitivePath("src/MY_SECRET.ts", "*secret*")).toBe(true);
    expect(matchesSensitivePath("src/plain.ts", "*secret*")).toBe(false);
  });

  it("matches a bare name exactly, at any depth", () => {
    expect(matchesSensitivePath("CODEOWNERS", "CODEOWNERS")).toBe(true);
    expect(matchesSensitivePath(".github/CODEOWNERS", "CODEOWNERS")).toBe(true);
    expect(matchesSensitivePath("docs/CODEOWNERS.md", "CODEOWNERS")).toBe(false);
  });
});

describe("isUnsupportedPathPattern", () => {
  it("flags the glob shapes that look like protection and match nothing", () => {
    for (const pattern of ["*.env", ".github/workflows/*", "src/**", "*secret", "pkg/*/dist"]) {
      expect(`${pattern}:${isUnsupportedPathPattern(pattern)}`).toBe(`${pattern}:true`);
      // The point of flagging them: they really do match nothing.
      expect(matchesSensitivePath("src/app.env", pattern)).toBe(false);
    }
  });

  it("accepts the three shapes the matcher actually implements", () => {
    for (const pattern of ["specs/", "*secret*", "CODEOWNERS", "wrangler.jsonc"]) {
      expect(`${pattern}:${isUnsupportedPathPattern(pattern)}`).toBe(`${pattern}:false`);
    }
  });
});

describe("evaluateAutomerge — the refusals", () => {
  it("refuses everything when the config is off", () => {
    const verdict = evaluateAutomerge(parseAutomergeConfig(SHIPPED_CONFIG).config, candidate());
    expect(verdict).toMatchObject({ permitted: false, reason: "disabled" });
  });

  it("refuses everything on the closed config an unreadable file yields", () => {
    const verdict = evaluateAutomerge(AUTOMERGE_CONFIG_CLOSED, candidate());
    expect(verdict.permitted).toBe(false);
  });

  it("refuses a repo nobody opted in", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ repo: "owner/other" }));
    expect(verdict).toMatchObject({ permitted: false, reason: "repo-not-opted-in" });
  });

  it("refuses a never-eligible run even when its class and repo are opted in", () => {
    // The important one: `spec-drift-pr` emits a specs/-only diff that would
    // pass every green-check condition trivially.
    const verdict = evaluateAutomerge(
      { ...PERMISSIVE, classes: ["dependency-patch", "inert-prose-only"] },
      candidate({ producedByRun: "spec-drift-pr", changeClass: "inert-prose-only" }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "never-eligible-run" });
  });

  it("refuses every run on the shipped never-eligible list", () => {
    for (const run of ["org-spec-audit", "spec-drift-pr", "upstream-upgrade-pr"]) {
      const verdict = evaluateAutomerge(PERMISSIVE, candidate({ producedByRun: run }));
      expect(`${run}:${verdict.permitted}`).toBe(`${run}:false`);
    }
  });

  it("refuses an undeclared change class", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ changeClass: undefined }));
    expect(verdict).toMatchObject({ permitted: false, reason: "class-not-opted-in" });
  });

  it("refuses a major bump class that is simply not on the list", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ changeClass: "dependency-major" }));
    expect(verdict).toMatchObject({ permitted: false, reason: "class-not-opted-in" });
  });

  it("refuses a human author, and an author it cannot place", () => {
    for (const author of ["a-real-person", "", "some-external-contributor"]) {
      const verdict = evaluateAutomerge(PERMISSIVE, candidate({ author }));
      expect(verdict).toMatchObject({ permitted: false, reason: "human-author" });
    }
  });

  it("refuses a diff touching a sensitive path, and names the file", () => {
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({ changedPaths: ["package.json", "specs/03-dsl.md"] }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "sensitive-path" });
    expect(verdict.permitted === false && verdict.detail).toContain("specs/03-dsl.md");
  });

  it("refuses on red checks, on a missing pr-review, and at the rate limit", () => {
    expect(evaluateAutomerge(PERMISSIVE, candidate({ checksGreen: false }))).toMatchObject({
      reason: "checks-not-green",
    });
    expect(evaluateAutomerge(PERMISSIVE, candidate({ reviewPosted: false }))).toMatchObject({
      reason: "review-not-posted",
    });
    expect(evaluateAutomerge(PERMISSIVE, candidate({ mergesToday: 3 }))).toMatchObject({
      reason: "rate-limited",
    });
  });
});

describe("evaluateAutomerge — the one path that permits", () => {
  it("permits only the full conjunction, and only at rung 0", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate());
    expect(verdict).toEqual({ permitted: true, rung: 0 });
    // Even a permit must not read as "merged" — the ladder does not exist.
    expect(describeVerdict(verdict)).toContain("a human still merges");
  });

  it("permits a loop-authored PR whose run is not on the never-eligible list", () => {
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({ producedByRun: "refresh-fixtures", author: "flare-dispatch[bot]" }),
    );
    expect(verdict.permitted).toBe(true);
  });

  it("permits a vouched-for author with no marker at all — the marker is not a condition", () => {
    const verdict = evaluateAutomerge(PERMISSIVE, candidate({ producedByRun: undefined }));
    expect(verdict.permitted).toBe(true);
  });

  it("cannot be permitted by the shipped config under any candidate", () => {
    // The property that matters: with what is actually committed in `org`,
    // there is no PR shape that merges itself.
    const shipped = parseAutomergeConfig(SHIPPED_CONFIG).config;
    for (const over of [
      {},
      { producedByRun: "refresh-fixtures" },
      { changedPaths: [] },
      { author: "dependabot[bot]", changeClass: "dependency-patch" },
    ]) {
      expect(evaluateAutomerge(shipped, candidate(over)).permitted).toBe(false);
    }
  });
});

// --- The marker is a claim, not a credential --------------------------------
//
// A PR body is written by whoever opens the PR. These tests pin the property
// that makes that safe: `producedByRun` may narrow a verdict and may never
// widen one. The gate once skipped the author check whenever a marker was
// present, which made pasting one HTML comment a complete bypass.

describe("evaluateAutomerge — a self-declared run marker is not authorship", () => {
  it("refuses a human-authored PR carrying a forged loop marker", () => {
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({ author: "a-real-person", producedByRun: "refresh-fixtures" }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "human-author" });
    expect(verdict.permitted === false && verdict.detail).toContain("a-real-person");
  });

  it("refuses every forgeable marker an attacker could pick, on an otherwise perfect PR", () => {
    // Everything else about this candidate is exactly what the gate wants:
    // opted-in repo, allowlisted class, clean paths, green checks, review
    // posted, under the rate limit. The author is the only thing wrong, and it
    // must be enough on its own.
    for (const forged of ["refresh-fixtures", "dependency-patch", "triage-prs", "pr-review"]) {
      const verdict = evaluateAutomerge(
        PERMISSIVE,
        candidate({ author: "some-external-contributor", producedByRun: forged }),
      );
      expect(verdict).toMatchObject({ permitted: false, reason: "human-author" });
    }
  });

  it("refuses an author it cannot place, marker or no marker", () => {
    for (const producedByRun of [undefined, "refresh-fixtures"]) {
      expect(evaluateAutomerge(PERMISSIVE, candidate({ author: "", producedByRun }))).toMatchObject(
        {
          permitted: false,
          reason: "human-author",
        },
      );
    }
  });

  it("gives a marker no power to widen: same author, same verdict either way", () => {
    for (const author of ["a-real-person", "dependabot[bot]"]) {
      const bare = evaluateAutomerge(PERMISSIVE, candidate({ author }));
      const marked = evaluateAutomerge(
        PERMISSIVE,
        candidate({ author, producedByRun: "refresh-fixtures" }),
      );
      expect(marked).toEqual(bare);
    }
  });

  it("still lets a marker NARROW — a never-eligible run is refused even for a vouched author", () => {
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({ author: "flare-dispatch[bot]", producedByRun: "spec-drift-pr" }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "never-eligible-run" });
  });

  it("checks every claimed run, so a prepended marker cannot shadow a banned one", () => {
    // Anyone who can edit a PR body can put a second marker above the real one.
    // If only the first were read, this would launder a `spec-drift-pr` PR into
    // an eligible one.
    const verdict = evaluateAutomerge(
      PERMISSIVE,
      candidate({
        author: "flare-dispatch[bot]",
        producedByRun: "refresh-fixtures",
        claimedRuns: ["refresh-fixtures", "spec-drift-pr"],
      }),
    );
    expect(verdict).toMatchObject({ permitted: false, reason: "never-eligible-run" });
    expect(verdict.permitted === false && verdict.detail).toContain("spec-drift-pr");
  });

  it("names the banned run, wherever in the list it sits", () => {
    for (const claims of [
      ["org-spec-audit", "refresh-fixtures"],
      ["refresh-fixtures", "org-spec-audit"],
      ["a", "b", "org-spec-audit"],
    ]) {
      const verdict = evaluateAutomerge(
        PERMISSIVE,
        candidate({ author: "flare-dispatch[bot]", claimedRuns: claims }),
      );
      expect(verdict).toMatchObject({ permitted: false, reason: "never-eligible-run" });
    }
  });

  it("cannot be opened by a marker when no author is vouched for at all", () => {
    // The shipped-shaped case: `botAuthors` empty. No marker, no class, no
    // author can reach a permit — the lane is shut until an operator adds a
    // login by PR.
    const noBots: AutomergeConfig = { ...PERMISSIVE, botAuthors: [] };
    for (const author of ["flare-dispatch[bot]", "dependabot[bot]", "a-real-person"]) {
      expect(
        evaluateAutomerge(noBots, candidate({ author, producedByRun: "refresh-fixtures" }))
          .permitted,
      ).toBe(false);
    }
  });
});

// --- loadAutomergeConfig: unreadable must mean refuse -----------------------

const githubService = (over: Partial<GithubService>): GithubService => ({
  issues: () => Effect.succeed([]),
  openIssue: () => Effect.succeed({ number: 1, url: "" }),
  addIssueLabels: () => Effect.void,
  removeIssueLabel: () => Effect.void,
  commentOnIssue: () => Effect.void,
  closeIssueAsDuplicate: () => Effect.void,
  closeBotIssue: ({ issue }) =>
    Effect.succeed({ closed: false, reason: "not-open", number: issue } as const),
  actionRuns: () => Effect.succeed([]),
  pullRequestHistory: () => Effect.succeed([]),
  readTextFile: () => Effect.succeed({ found: false }),
  branchHead: () => Effect.succeed("0".repeat(40)),
  appendMeasureNote: () => Effect.void,
  pullReview: () => Effect.void,
  openDraftPullRequest: () =>
    Effect.succeed({ number: 0, url: "", created: false, skipped: false }),
  closeDraftPullRequest: () => Effect.succeed({ closed: false, reason: "none-open" }),
  createRelease: () => Effect.succeed({ id: 0, url: "", tag: "", published: false }),
  tagCommit: () => Effect.succeed("0".repeat(40)),
  tagTarget: () => Effect.succeed({ refSha: "0".repeat(40), commitSha: "0".repeat(40) }),
  commitOnDefaultBranch: () => Effect.succeed(true),
  releaseByTag: () => Effect.succeed(undefined),
  publishRelease: () => Effect.succeed({ id: 0, url: "", tag: "", published: false }),
  publishReleaseAsset: () => Effect.succeed({ id: 0, name: "", size: 0, downloadUrl: "" }),
  publishContainerImage: () => Effect.void,
  ...over,
});

const load = (service: Partial<GithubService>) => {
  const { layer, handles } = makeCFRuntimeTest();
  return Effect.runPromise(
    loadAutomergeConfig({ repo: "owner/control" }).pipe(
      Effect.provide(Layer.succeed(Github, githubService(service))),
      Effect.provide(layer),
      Effect.map((config) => ({ config, logs: handles.io.logs })),
    ),
  );
};

describe("loadAutomergeConfig", () => {
  it("returns the closed config, loudly, when the file cannot be read", async () => {
    const { config, logs } = await load({
      readTextFile: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
    });
    expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
    expect(evaluateAutomerge(config, candidate()).permitted).toBe(false);
    expect(
      logs.some((l) => l.level === "warn" && l.msg.includes("refusing every auto-merge")),
    ).toBe(true);
  });

  it("returns the closed config, loudly, when the file is simply absent", async () => {
    const { config, logs } = await load({ readTextFile: () => Effect.succeed({ found: false }) });
    expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
    expect(
      logs.some((l) => l.level === "warn" && l.msg.includes("no maintenance/automerge.json")),
    ).toBe(true);
  });

  it("returns the closed config, loudly, when the file is malformed", async () => {
    const { config, logs } = await load({
      readTextFile: () => Effect.succeed({ found: true, content: "{ not json" }),
    });
    expect(config).toEqual(AUTOMERGE_CONFIG_CLOSED);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("not JSON"))).toBe(true);
  });

  it("reads the real file through the github fake at the documented path", async () => {
    const { layer } = makeCFRuntimeTest({
      github: { files: { [`owner/control:${AUTOMERGE_CONFIG_PATH}`]: SHIPPED_CONFIG } },
    });
    const config = await Effect.runPromise(
      loadAutomergeConfig({ repo: "owner/control" }).pipe(Effect.provide(layer)),
    );
    expect(config.enabled).toBe(false);
    expect(config.neverEligibleRuns).toHaveLength(3);
  });
});
