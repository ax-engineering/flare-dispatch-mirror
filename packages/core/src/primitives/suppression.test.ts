// Unit tests for the `suppression` primitive — the maintenance loop's memory.
//
// The pure half (`parseDeclinedLedger`, `parseMaintenanceKeys`,
// `decideSuppression`) is tested with plain data and no fakes at all; the I/O
// half (`checkSuppression`) is tested against the in-memory `github` fake, plus
// hand-built failing services for the fail-open paths — the fake is the
// green-path simulator by design.

import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { GitHubApiError } from "../errors";
import { Github, type GithubService, type PullRequestHistoryRef } from "../services/github";
import { makeCFRuntimeTest } from "../testing";
import {
  checkSuppression,
  COOLDOWN_DAYS_DEFAULT,
  decideSuppression,
  describeVerdict,
  parseDeclinedLedger,
  parseMaintenanceKeys,
  renderSuppressionNote,
  type CheckSuppressionArgs,
  type DeclineEntry,
} from "./suppression";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 8); // 2026-08-08

const declineLine = (key: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ key, reason: "answered in ADR-0011", by: "@ada", at: "2026-07-01", ...over });

const prior = (over: Partial<PullRequestHistoryRef> = {}): PullRequestHistoryRef => ({
  repo: "owner/control",
  number: 12,
  title: "docs(maintenance): open questions",
  body: "maintenance-key: org-spec-audit/spend-caps",
  headBranch: "flare-dispatch/spec-audit-questions-2026-07-01",
  headSha: "abc123",
  state: "closed",
  draft: true,
  labels: [],
  author: "flare-dispatch[bot]",
  requestedReviewers: [],
  url: "https://github.com/owner/control/pull/12",
  createdAt: NOW - 40 * DAY,
  updatedAt: NOW - 5 * DAY,
  closedAt: NOW - 5 * DAY,
  ...over,
});

const declined = (...keys: string[]): ReadonlyMap<string, DeclineEntry> =>
  new Map(keys.map((key) => [key, { key, reason: "settled", by: "@ada", at: "2026-07-01" }]));

describe("parseDeclinedLedger", () => {
  it("reads one entry per line and ignores blanks", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      `${declineLine("org-spec-audit/a")}\n\n${declineLine("org-spec-audit/b")}\n`,
    );
    expect([...byKey.keys()]).toEqual(["org-spec-audit/a", "org-spec-audit/b"]);
    expect(malformed).toEqual([]);
    expect(byKey.get("org-spec-audit/a")?.reason).toBe("answered in ADR-0011");
  });

  it("skips a malformed line, reports it, and keeps the rest of the ledger", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      [
        declineLine("org-spec-audit/good"),
        "{ this is not json",
        '["an","array"]',
        '{"reason":"no key here"}',
        declineLine("org-spec-audit/also-good"),
      ].join("\n"),
    );
    expect([...byKey.keys()]).toEqual(["org-spec-audit/good", "org-spec-audit/also-good"]);
    expect(malformed).toEqual([
      { line: 2, why: "not JSON" },
      { line: 3, why: "not a JSON object" },
      { line: 4, why: "no usable `key`" },
    ]);
  });

  it("treats a non-string or absurdly long key as unusable", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      [
        JSON.stringify({ key: { nested: "object" }, reason: "x" }),
        JSON.stringify({ key: "k".repeat(500), reason: "x" }),
      ].join("\n"),
    );
    expect(byKey.size).toBe(0);
    expect(malformed).toHaveLength(2);
  });

  it("flattens a reason so ledger prose cannot restructure a PR body", () => {
    const { byKey } = parseDeclinedLedger(
      declineLine("org-spec-audit/a", { reason: "line one\n## Injected heading\n`code`" }),
    );
    // One line, and the backticks are escaped rather than deleted — the prose
    // survives verbatim, it just cannot open a code span.
    expect(byKey.get("org-spec-audit/a")?.reason).toBe("line one ## Injected heading \\`code\\`");
  });

  it("escapes markdown and HTML in a reason, so a ledger edit cannot forge content", () => {
    const { byKey } = parseDeclinedLedger(
      declineLine("org-spec-audit/a", {
        reason:
          '[click here](https://evil.example/phish) <img src=x onerror="alert(1)"> **bold** _em_',
      }),
    );
    const reason = byKey.get("org-spec-audit/a")?.reason ?? "";
    // Nothing that opens a link, an image, a raw tag, or emphasis survives
    // unescaped — every metacharacter is preceded by a backslash.
    expect(reason).toBe(
      "\\[click here\\]\\(https://evil.example/phish\\) " +
        '\\<img src=x onerror="alert\\(1\\)"\\> \\*\\*bold\\*\\* \\_em\\_',
    );
    for (const meta of ["[", "]", "(", ")", "<", ">", "*", "_"]) {
      expect(reason).not.toMatch(new RegExp(`(^|[^\\\\])\\${meta}`));
    }
  });

  it("escapes `by` and `at` too — every ledger-controlled field reaches a PR body", () => {
    const { byKey } = parseDeclinedLedger(
      declineLine("org-spec-audit/a", {
        by: "[@ada](https://evil.example)",
        at: "<b>2026-07-01</b>",
      }),
    );
    const entry = byKey.get("org-spec-audit/a");
    expect(entry?.by).toBe("\\[@ada\\]\\(https://evil.example\\)");
    expect(entry?.at).toBe("\\<b\\>2026-07-01\\</b\\>");
  });

  it("strips zero-width and bidi-override characters instead of escaping them", () => {
    // A right-to-left override can make rendered text read as its reverse,
    // and a zero-width space can split a word a reader thinks they matched;
    // escaping would faithfully preserve both deceptions, so they are removed.
    const RLO = "\u202E";
    const PDF = "\u202C";
    const ZWSP = "\u200B";
    const { byKey } = parseDeclinedLedger(
      declineLine("org-spec-audit/a", {
        reason: `safe${RLO}reversed${PDF}${ZWSP}text`,
      }),
    );
    const reason = byKey.get("org-spec-audit/a")?.reason ?? "";
    expect(reason).toBe("safereversedtext");
    for (const invisible of [RLO, PDF, ZWSP]) {
      expect(reason).not.toContain(invisible);
    }
  });

  it("bounds the visible reason, and never truncates mid-escape", () => {
    const { byKey } = parseDeclinedLedger(
      // 400 metacharacters: the visible cap is 200, and escaping happens after
      // the slice, so the result is exactly 200 escape pairs — never a string
      // ending in a lone backslash that would eat the next character.
      declineLine("org-spec-audit/a", { reason: "*".repeat(400) }),
    );
    const reason = byKey.get("org-spec-audit/a")?.reason ?? "";
    expect(reason).toBe("\\*".repeat(200));
    expect(reason.endsWith("\\")).toBe(false);
  });

  it("stops at the line cap and says so, rather than reading an unbounded file", () => {
    const { byKey, malformed } = parseDeclinedLedger(
      Array.from({ length: 6_000 }, (_, i) => declineLine(`org-spec-audit/k${i}`)).join("\n"),
    );
    expect(byKey.size).toBe(5_000);
    expect(byKey.has("org-spec-audit/k4999")).toBe(true);
    expect(byKey.has("org-spec-audit/k5000")).toBe(false);
    // Reported, not silent — an unread decline would otherwise be re-proposed
    // with nothing anywhere saying why.
    expect(malformed.some((m) => m.why.includes("exceeds 5000 lines"))).toBe(true);
  });

  it("lets a later line win — the ledger is append-only", () => {
    const { byKey } = parseDeclinedLedger(
      [
        declineLine("org-spec-audit/a", { reason: "first" }),
        declineLine("org-spec-audit/a", { reason: "second" }),
      ].join("\n"),
    );
    expect(byKey.get("org-spec-audit/a")?.reason).toBe("second");
  });
});

describe("parseMaintenanceKeys", () => {
  it("reads every key line, deduplicated", () => {
    expect(
      parseMaintenanceKeys(
        "prose\nmaintenance-key: a/one\nmaintenance-key: a/two\nmaintenance-key: a/one\n",
      ),
    ).toEqual(["a/one", "a/two"]);
  });

  it("ignores the phrase used mid-sentence", () => {
    expect(parseMaintenanceKeys("we set the maintenance-key: a/one on each proposal")).toEqual([]);
  });
});

describe("decideSuppression", () => {
  const decide = (args: Partial<Parameters<typeof decideSuppression>[0]> = {}) =>
    decideSuppression({
      candidates: ["org-spec-audit/spend-caps"],
      declined: new Map(),
      priorProposals: [],
      nowMs: NOW,
      ...args,
    });

  it("never proposes again once the ledger names the key", () => {
    const verdict = decide({ declined: declined("org-spec-audit/spend-caps") }).get(
      "org-spec-audit/spend-caps",
    );
    expect(verdict?.status).toBe("declined");
    expect(describeVerdict(verdict!)).toBe("declined");
  });

  it("outranks a long-expired cooldown — a decline is permanent", () => {
    const verdict = decide({
      declined: declined("org-spec-audit/spend-caps"),
      priorProposals: [prior({ closedAt: NOW - 900 * DAY, updatedAt: NOW - 900 * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("declined");
  });

  it("holds a cooldown dated from closed_at, not updated_at", () => {
    const verdict = decide({
      // Closed 5 days ago, then touched today — `updated_at` is worthless here,
      // and dating from it is exactly the bug the store could not avoid.
      priorProposals: [prior({ closedAt: NOW - 5 * DAY, updatedAt: NOW })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("cooling");
    expect(describeVerdict(verdict!)).toBe(
      `cooling-until-${new Date(NOW - 5 * DAY + COOLDOWN_DAYS_DEFAULT * DAY)
        .toISOString()
        .slice(0, 10)}`,
    );
  });

  it("proposes again once the cooldown has expired", () => {
    const verdict = decide({
      priorProposals: [prior({ closedAt: NOW - 31 * DAY, updatedAt: NOW - 31 * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("open");
  });

  it("does not suppress on a merged PR — that proposal was accepted", () => {
    const verdict = decide({
      priorProposals: [prior({ mergedAt: NOW - 5 * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("open");
  });

  it("does not suppress on a still-open PR", () => {
    const verdict = decide({
      priorProposals: [prior({ state: "open", closedAt: undefined })],
    }).get("org-spec-audit/spend-caps");
    expect(verdict?.status).toBe("open");
  });

  it("dates the cooldown from the most recent close", () => {
    const verdict = decide({
      priorProposals: [
        prior({ number: 8, closedAt: NOW - 40 * DAY }),
        prior({ number: 9, closedAt: NOW - 2 * DAY }),
      ],
    }).get("org-spec-audit/spend-caps");
    expect(verdict).toMatchObject({ status: "cooling", pr: 9 });
  });

  it("ignores a closed PR with no closed_at rather than guessing a date", () => {
    const verdict = decide({ priorProposals: [prior({ closedAt: undefined })] }).get(
      "org-spec-audit/spend-caps",
    );
    expect(verdict?.status).toBe("open");
  });

  it("expires the cooldown exactly at the boundary, not a tick either side", () => {
    // The rule is `nowMs < closedAt + cooldown`. Without both sides pinned,
    // flipping it to `<=` passes every other test in this file.
    const atExpiry = decide({
      priorProposals: [prior({ closedAt: NOW - COOLDOWN_DAYS_DEFAULT * DAY })],
    }).get("org-spec-audit/spend-caps");
    expect(atExpiry?.status).toBe("open");

    const oneMsShort = decide({
      priorProposals: [prior({ closedAt: NOW - COOLDOWN_DAYS_DEFAULT * DAY + 1 })],
    }).get("org-spec-audit/spend-caps");
    expect(oneMsShort?.status).toBe("cooling");
  });
});

// --- checkSuppression: the two reads, and what happens when they fail --------

/** A `GithubService` with every method stubbed, overridable per test. */
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

const args: CheckSuppressionArgs = {
  keys: ["org-spec-audit/spend-caps", "org-spec-audit/owner-of-x"],
  ledgerRepo: "owner/control",
  headBranchPrefix: "flare-dispatch/spec-audit-questions-",
  nowMs: NOW,
};

/** Run `checkSuppression` against the test runtime with `github` overridden. */
const runWith = (
  service: Partial<GithubService>,
  overrides: Partial<CheckSuppressionArgs> = {},
) => {
  const { layer, handles } = makeCFRuntimeTest();
  return Effect.runPromise(
    checkSuppression({ ...args, ...overrides }).pipe(
      Effect.provide(Layer.succeed(Github, githubService(service))),
      Effect.provide(layer),
      Effect.map((report) => ({ report, logs: handles.io.logs })),
    ),
  );
};

describe("checkSuppression", () => {
  it("suppresses a declined key and lets the other through", async () => {
    const { report } = await runWith({
      readTextFile: () => Effect.succeed({ found: true, content: declineLine(args.keys[0]!) }),
    });
    expect(report.allowed).toEqual([args.keys[1]]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]!.verdict.status).toBe("declined");
    expect(report.degraded).toEqual([]);
  });

  it("treats an absent ledger as declining nothing", async () => {
    const { report } = await runWith({ readTextFile: () => Effect.succeed({ found: false }) });
    expect(report.allowed).toEqual([...args.keys]);
    expect(report.degraded).toEqual([]);
  });

  it("proposes anyway, loudly, when the ledger cannot be read — and still cools", async () => {
    const { report, logs } = await runWith({
      readTextFile: () => Effect.fail(new GitHubApiError({ status: 500, reason: "transient" })),
      // The cooldown half must survive the ledger half failing — that is the
      // independent degradation the module header promises. With no prior
      // proposal seeded, an implementation that abandoned BOTH sources on the
      // first failure would pass this test unchanged.
      pullRequestHistory: () => Effect.succeed([prior()]),
    });
    expect(report.allowed).toEqual([args.keys[1]]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]!.verdict.status).toBe("cooling");
    expect(report.degraded).toHaveLength(1);
    expect(report.degraded[0]).toContain("declines NOT applied");
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("unreadable"))).toBe(true);
  });

  it("reads the ledger at the ref it was given", async () => {
    const seen: Array<string | undefined> = [];
    const { report } = await runWith(
      {
        readTextFile: (req) => {
          seen.push(req.ref);
          return Effect.succeed({ found: true, content: declineLine(args.keys[0]!) });
        },
      },
      { ledgerRef: "release/2026-08" },
    );
    expect(seen).toEqual(["release/2026-08"]);
    expect(report.suppressed).toHaveLength(1);
  });

  it("still applies declines when only the PR history read fails", async () => {
    const { report } = await runWith({
      readTextFile: () => Effect.succeed({ found: true, content: declineLine(args.keys[0]!) }),
      pullRequestHistory: () =>
        Effect.fail(new GitHubApiError({ status: 403, reason: "unauthorized" })),
    });
    expect(report.allowed).toEqual([args.keys[1]]);
    expect(report.degraded[0]).toContain("cooldowns NOT applied");
  });

  it("warns per malformed ledger line and honours the rest", async () => {
    const { report, logs } = await runWith({
      readTextFile: () =>
        Effect.succeed({
          found: true,
          content: `not json at all\n${declineLine(args.keys[0]!)}`,
        }),
    });
    expect(report.suppressed.map((s) => s.key)).toEqual([args.keys[0]]);
    expect(report.degraded).toEqual([]);
    expect(logs.some((l) => l.level === "warn" && l.msg.includes("skipped — not JSON"))).toBe(true);
  });

  it("bounds the history read to the cooldown window and the branch prefix", async () => {
    const seen: unknown[] = [];
    await runWith({
      pullRequestHistory: (opts) => {
        seen.push(opts);
        return Effect.succeed([]);
      },
    });
    expect(seen[0]).toMatchObject({
      repo: "owner/control",
      headBranchPrefix: args.headBranchPrefix,
      state: "all",
      updatedWithinDays: COOLDOWN_DAYS_DEFAULT,
    });
  });

  it("spends no GitHub calls when there is nothing to propose", async () => {
    let calls = 0;
    const count = () => {
      calls += 1;
    };
    const { report } = await runWith(
      {
        readTextFile: () => Effect.sync(() => (count(), { found: false })),
        pullRequestHistory: () => Effect.sync(() => (count(), [])),
      },
      { keys: [] },
    );
    expect(calls).toBe(0);
    expect(report.allowed).toEqual([]);
  });

  it("reads the ledger through the github fake's seeded files", async () => {
    const { layer } = makeCFRuntimeTest({
      github: {
        files: {
          "owner/control:maintenance/declined.jsonl": declineLine(args.keys[0]!),
        },
        pullRequestHistory: [prior({ body: `maintenance-key: ${args.keys[1]}` })],
        now: NOW,
      },
    });
    const report = await Effect.runPromise(checkSuppression(args).pipe(Effect.provide(layer)));
    expect(report.suppressed.map((s) => s.verdict.status)).toEqual(["declined", "cooling"]);
    expect(report.allowed).toEqual([]);
  });
});

describe("renderSuppressionNote", () => {
  it("says nothing when nothing was suppressed", () => {
    expect(renderSuppressionNote({ allowed: ["a"], suppressed: [], degraded: [] })).toEqual([]);
  });

  it("names the count, the split, and each key's reason", () => {
    const note = renderSuppressionNote({
      allowed: [],
      suppressed: [
        {
          key: "org-spec-audit/a",
          verdict: {
            status: "declined",
            reason: "settled in ADR-0011",
            by: "@ada",
            at: "2026-07-01",
          },
        },
        {
          key: "org-spec-audit/b",
          verdict: {
            status: "cooling",
            untilMs: NOW + 25 * DAY,
            until: "2026-09-02",
            pr: 12,
            url: "https://github.com/owner/control/pull/12",
            closedAtMs: NOW - 5 * DAY,
          },
        },
      ],
      degraded: [],
    }).join("\n");
    expect(note).toContain("**Suppressed: 2**");
    expect(note).toContain("1 previously declined, 1 in cooldown");
    expect(note).toContain("declined 2026-07-01 by @ada: settled in ADR-0011");
    // The whole cooling line, so the close date rendered from `closedAtMs` and
    // the PR link are both pinned — not just the `until` string handed in.
    expect(note).toContain(
      "closed unmerged in [#12](https://github.com/owner/control/pull/12) on 2026-08-03; cooling until 2026-09-02",
    );
  });

  it("renders an escaped reason as inert text — end to end from the ledger", () => {
    // The whole path a hostile ledger line takes: parse, decide, render. The
    // note must not contain a usable link, image, or raw tag.
    const { byKey } = parseDeclinedLedger(
      declineLine("org-spec-audit/a", {
        reason: '[click](https://evil.example) <img src=x onerror="alert(1)">',
        by: "<b>@ada</b>",
      }),
    );
    const verdicts = decideSuppression({
      candidates: ["org-spec-audit/a"],
      declined: byKey,
      priorProposals: [],
      nowMs: NOW,
    });
    const verdict = verdicts.get("org-spec-audit/a");
    if (verdict === undefined || verdict.status !== "declined") {
      throw new Error(`expected a declined verdict, got ${verdict?.status ?? "none"}`);
    }
    const note = renderSuppressionNote({
      allowed: [],
      suppressed: [{ key: "org-spec-audit/a", verdict }],
      degraded: [],
    }).join("\n");

    // A markdown link is `](` with no backslash in front of either character.
    expect(note).not.toMatch(/[^\\]\]\(/);
    expect(note).not.toMatch(/[^\\]<img/);
    expect(note).not.toMatch(/[^\\]<b>/);
    // …and the text itself is still there for a human to read.
    expect(note).toContain("evil.example");
  });

  it("keeps a hostile key inside its code span, and a hostile URL inside its link", () => {
    const note = renderSuppressionNote({
      allowed: [],
      suppressed: [
        {
          key: "a/b` <img src=x>",
          verdict: {
            status: "cooling",
            untilMs: NOW + 25 * DAY,
            until: "2026-09-02",
            pr: 12,
            // A `)` here would close the link destination early and spill the
            // rest into the body as markdown.
            url: "https://github.com/owner/control/pull/12) [spoof](https://evil.example",
            closedAtMs: NOW - 5 * DAY,
          },
        },
      ],
      degraded: [],
    }).join("\n");

    // Backslashes do not escape inside a code span, so the stray backtick is
    // removed rather than escaped — the span still opens and closes cleanly.
    expect(note).toContain("`a/b <img src=x>`");
    expect(note).not.toContain("`a/b` <img");
    // The destination's parens and spaces are percent-encoded, so it cannot
    // terminate early and spill `[spoof](…)` into the body as live markdown.
    expect(note).toContain("pull/12%29%20[spoof]%28https://evil.example)");
    expect(note).not.toContain("](https://evil.example");
  });

  it("prints the degradation so a short list is never mistaken for calm", () => {
    const note = renderSuppressionNote({
      allowed: ["a"],
      suppressed: [],
      degraded: ["ledger owner/control:x unreadable (GitHub 500 transient)"],
    }).join("\n");
    expect(note).toContain("Suppression degraded");
    expect(note).toContain("GitHub 500 transient");
  });
});
