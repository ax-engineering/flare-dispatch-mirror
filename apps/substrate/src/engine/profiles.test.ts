import { describe, expect, it } from "vitest";
import type {
  DenialEvent,
  GrantProfileName,
} from "@fractalboxdev/flare-dispatch-substrate-contract";
import {
  applyGrant,
  buildGrant,
  decide,
  egressHandlers,
  hostMatches,
  OPEN_HOST,
  serveGrantedRequest,
  revokeGrant,
  WOULD_DENY_PREFIX,
  type GrantTarget,
  type OutboundContext,
} from "./egress";
import {
  GRANT_PROFILES,
  isProfileName,
  grantPolicy,
  PROFILE_NAMES,
  selectionProblem,
  WRITE_SINKS,
  type GrantParams,
} from "./profiles";

const CONTAINER = "b1946ac92492d2347c6235b4d2611184";

const params = (over: Partial<GrantParams> = {}): GrantParams => ({
  repo: "acme/widget",
  containerId: CONTAINER,
  ...over,
});

const allows = (p: GrantParams, method: string, url: string): boolean =>
  decide(grantPolicy(p), method, new URL(url)).ok;

const reason = (p: GrantParams, method: string, url: string): string => {
  const d = decide(grantPolicy(p), method, new URL(url));
  return d.ok ? "" : d.reason;
};

/** A GrantTarget that records every call in order. */
function target() {
  const calls: string[] = [];
  const t: GrantTarget = {
    allowHost: async (h) => void calls.push(`allow:${h}`),
    removeAllowedHost: async (h) => void calls.push(`unallow:${h}`),
    denyHost: async (h) => void calls.push(`deny:${h}`),
    removeDeniedHost: async (h) => void calls.push(`undeny:${h}`),
    setOutboundByHost: async (h, m) => void calls.push(`map:${h}:${m}`),
    removeOutboundByHost: async (h) => void calls.push(`unmap:${h}`),
    setOutboundHandler: async (m) => void calls.push(`catchall:${m}`),
  };
  return { calls, t };
}

describe("the catalog covers exactly the contract's vocabulary", () => {
  it("names every profile the contract declares, and no others", () => {
    // The contract's union and this record are the same set by construction
    // (the record is typed by the union), so what this asserts is the half a
    // type cannot: that no name maps to a profile whose `name` field drifted.
    for (const name of PROFILE_NAMES) expect(GRANT_PROFILES[name].name).toBe(name);
    expect(PROFILE_NAMES).toHaveLength(6);
  });

  it("recognises catalog names and rejects invented ones", () => {
    expect(isProfileName("js-install")).toBe(true);
    expect(isProfileName("js-install-plus")).toBe(false);
    // Not a prototype walk — `toString` is on Object.prototype, not the catalog.
    expect(isProfileName("toString")).toBe(false);
  });

  it("admits only concrete hosts — a glob would get an uninspected fetch", () => {
    for (const name of PROFILE_NAMES) {
      const targets = GRANT_PROFILES[name].acceptsTargets ? ["staging.acme.dev"] : [];
      const policy = grantPolicy(params({ profiles: [name], targets }));
      for (const host of policy.hosts) expect(host.host).not.toContain("*");
    }
  });
});

describe("public-repo-read", () => {
  const p = params({ profiles: ["public-repo-read"] });

  it("serves discovery and negotiation for the recipe's repo only", () => {
    expect(
      allows(p, "GET", "https://github.com/acme/widget/info/refs?service=git-upload-pack"),
    ).toBe(true);
    expect(allows(p, "POST", "https://github.com/acme/widget/git-upload-pack")).toBe(true);
    expect(allows(p, "POST", "https://github.com/other/repo/git-upload-pack")).toBe(false);
  });

  it("refuses the push counterparts that share those URLs", () => {
    expect(
      allows(p, "GET", "https://github.com/acme/widget/info/refs?service=git-receive-pack"),
    ).toBe(false);
    expect(allows(p, "POST", "https://github.com/acme/widget/git-receive-pack")).toBe(false);
  });

  it("needs a repo to scope its rules against", () => {
    expect(selectionProblem(params({ repo: "", profiles: ["public-repo-read"] }))).toMatch(
      /needs a repo to compose onto/,
    );
  });
});

describe("js-install", () => {
  const p = params({ profiles: ["js-install"] });

  it("reads the registry", () => {
    expect(allows(p, "GET", "https://registry.npmjs.org/effect")).toBe(true);
    expect(allows(p, "GET", "https://registry.npmjs.org/effect/-/effect-3.21.2.tgz")).toBe(true);
    expect(allows(p, "GET", "https://registry.yarnpkg.com/effect")).toBe(true);
  });

  it("refuses publish, which lives on the same host", () => {
    // `npm publish` is `PUT /:package`; `npm token create` is a POST. Neither
    // is named by a rule, so the method check is what separates read from write.
    // PUT is in the method union — `wrangler deploy` needs it — so what
    // refuses a publish is the absence of a rule naming it on this host, not
    // the width of the vocabulary.
    expect(reason(p, "PUT", "https://registry.npmjs.org/@acme/widget")).toMatch(
      /is outside the grant/,
    );
    expect(allows(p, "POST", "https://registry.npmjs.org/-/npm/v1/tokens")).toBe(false);
  });

  it("does not reach a registry it was not told about", () => {
    expect(allows(p, "GET", "https://npm.pkg.github.com/@acme/widget")).toBe(false);
  });

  it("still needs a repo to compose onto — ADR-0005's no-repo-no-egress rule", () => {
    // The profile itself asks for no repository, but a recipe without one is
    // "a shell and no egress", so a selection has nothing to compose onto.
    expect(selectionProblem(params({ repo: "", profiles: ["js-install"] }))).toMatch(
      /needs a repo to compose onto/,
    );
  });
});

describe("rust-install", () => {
  const p = params({ profiles: ["rust-install"] });

  it("serves the sparse index and the crate CDN", () => {
    expect(allows(p, "GET", "https://index.crates.io/ef/fe/effect")).toBe(true);
    expect(allows(p, "GET", "https://static.crates.io/crates/serde/serde-1.0.0.crate")).toBe(true);
    expect(allows(p, "GET", "https://crates.io/api/v1/crates/serde/1.0.0/download")).toBe(true);
  });

  it("refuses publish and anything off the crates path", () => {
    expect(allows(p, "PUT", "https://crates.io/api/v1/crates/new")).toBe(false);
    expect(allows(p, "GET", "https://crates.io/me")).toBe(false);
  });
});

describe("browser-fetch and the dynamic-target schema", () => {
  it("admits the browser CDN but not an arbitrary object store", () => {
    const p = params({ profiles: ["browser-fetch"] });
    expect(allows(p, "GET", "https://cdn.playwright.dev/dbazure/chromium-1234.zip")).toBe(true);
    // One bucket host serves every bucket on the platform; admitting it admits
    // an arbitrary object store, so it is deliberately absent.
    expect(allows(p, "GET", "https://storage.googleapis.com/chromium-browser/1.zip")).toBe(false);
  });

  it("admits exactly the hosts the recipe declared as targets", () => {
    const p = params({ profiles: ["browser-fetch"], targets: ["staging.acme.dev"] });
    expect(allows(p, "GET", "https://staging.acme.dev/login")).toBe(true);
    expect(allows(p, "POST", "https://staging.acme.dev/api/session")).toBe(true);
    expect(allows(p, "GET", "https://prod.acme.dev/login")).toBe(false);
  });

  it("refuses targets when no selected profile accepts one", () => {
    // The dispatch already checked the host against the run definition's
    // pattern; this is the substrate refusing to be handed a target by a
    // profile set that never asked for one.
    expect(
      selectionProblem(params({ profiles: ["js-install"], targets: ["staging.acme.dev"] })),
    ).toMatch(/no selected profile accepts them/);
  });

  it("refuses a target that is a pattern or a URL rather than a hostname", () => {
    for (const bad of ["*.acme.dev", "acme.dev/login", " acme.dev", ""])
      expect(selectionProblem(params({ profiles: ["browser-fetch"], targets: [bad] }))).toMatch(
        /not a bare hostname/,
      );
  });
});

describe("cf-api", () => {
  const p = params({ profiles: ["cf-api"] });

  it("serves the writes a wrangler deploy makes", () => {
    // The floor that decides whether a deploy may run at all is ADR-0007's
    // attestation, one layer up; this profile only decides where it may send.
    const account = "0123456789abcdef0123456789abcdef";
    expect(
      allows(
        p,
        "PUT",
        `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/w`,
      ),
    ).toBe(true);
    // The pre-flight wrangler runs before it uploads anything.
    expect(allows(p, "GET", "https://api.cloudflare.com/client/v4/user/tokens/verify")).toBe(true);
    expect(allows(p, "GET", "https://api.cloudflare.com/client/v4/memberships")).toBe(true);
  });

  it("scopes the path to one account's Workers surface, not the whole API", () => {
    // A write-scoped token can also edit DNS, delete R2 buckets and read
    // billing; the path rule is what keeps an injected header off all of it.
    expect(allows(p, "GET", "https://api.cloudflare.com/oauth/token")).toBe(false);
    expect(allows(p, "GET", "https://dash.cloudflare.com/client/v4/user")).toBe(false);
    expect(
      allows(
        p,
        "GET",
        "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects",
      ),
    ).toBe(false);
  });
});

describe("github-api-read trades one deny for a narrower rule", () => {
  it("keeps api.github.com denied when the profile is not selected", () => {
    const p = params({ profiles: ["public-repo-read"] });
    expect(grantPolicy(p).deny).toEqual([...WRITE_SINKS]);
    expect(reason(p, "GET", "https://api.github.com/repos/acme/widget")).toMatch(
      /denied write sink/,
    );
  });

  it("admits GET when it is, and still refuses every write verb", () => {
    const p = params({ profiles: ["github-api-read"] });
    expect(grantPolicy(p).deny).not.toContain("api.github.com");
    expect(allows(p, "GET", "https://api.github.com/repos/acme/widget/pulls/7")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(allows(p, method, "https://api.github.com/repos/acme/widget/issues")).toBe(false);
    // A GraphQL POST is a mutation surface no path can distinguish from a query.
    expect(allows(p, "POST", "https://api.github.com/graphql")).toBe(false);
  });

  it("never trades the sinks that have no read half", () => {
    for (const name of PROFILE_NAMES) {
      const deny = grantPolicy(params({ profiles: [name] })).deny;
      expect(deny).toContain("gist.github.com");
      expect(deny).toContain("uploads.github.com");
    }
  });
});

describe("composition", () => {
  it("unions the host sets of every selected profile", () => {
    const p = params({ profiles: ["public-repo-read", "js-install", "rust-install"] });
    const hosts = grantPolicy(p).hosts.map((h) => h.host);
    expect(hosts).toContain("github.com");
    expect(hosts).toContain("registry.npmjs.org");
    expect(hosts).toContain("index.crates.io");
  });

  it("merges rules for a host two profiles both name, rather than shadowing", () => {
    // `github-api-read` and `public-repo-read` name different hosts today, so
    // the merge is asserted on the one host a profile pair can collide on:
    // selecting a profile twice must not drop the first copy's rules.
    const p = params({ profiles: ["public-repo-read", "public-repo-read"] });
    const github = grantPolicy(p).hosts.find((h) => h.host === "github.com");
    expect(github?.rules.length).toBeGreaterThan(4);
    expect(allows(p, "POST", "https://github.com/acme/widget/git-upload-pack")).toBe(true);
  });

  it("defaults an empty selection to cloning the recipe's repo and nothing else", () => {
    const hosts = grantPolicy(params()).hosts.map((h) => h.host);
    expect(hosts).toEqual(["github.com", "codeload.github.com"]);
  });

  it("rejects a profile name the catalog does not carry", () => {
    const bogus = ["nmp-install"] as unknown as readonly GrantProfileName[];
    expect(selectionProblem(params({ profiles: bogus }))).toMatch(/not in the catalog/);
    expect(() => grantPolicy(params({ profiles: bogus }))).toThrow(/not in the catalog/);
  });
});

describe("the rollout-position gate", () => {
  it("enforce maps one handler per admitted host and carries the deny floor", () => {
    const grant = buildGrant(params({ profiles: ["js-install"], position: "enforce" }));
    expect(grant.position).toBe("enforce");
    // The repo read composes in, so the registry hosts arrive on top of it.
    expect(grant.allow).toEqual([
      "github.com",
      "codeload.github.com",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
    ]);
    expect(grant.handlers.map((h) => h.host)).toEqual(grant.allow);
    expect(grant.catchAll).toBeUndefined();
    expect(grant.deny).toEqual([...WRITE_SINKS]);
  });

  it("enforce is the default when a recipe names no position", () => {
    expect(buildGrant(params()).position).toBe("enforce");
  });

  it("report admits every host and maps the catch-all that records", () => {
    const grant = buildGrant(params({ profiles: ["js-install"], position: "report" }));
    expect(grant.allow).toEqual([OPEN_HOST]);
    expect(grant.handlers).toEqual([]);
    expect(grant.catchAll?.method).toBe("reportOnly");
    // A deny in an open posture is a bodyless 520 the engine never sees — the
    // exact undiagnosable failure the report window exists to replace.
    expect(grant.deny).toEqual([]);
  });

  it("report's wildcard is what makes a missing HOST recordable, not just a bad path", () => {
    // The proxy gates on `allowedHosts` strictly before it consults a handler,
    // so a report grant carrying the enforce host set would 520 on the one
    // finding the window exists to produce. This asserts the shape that avoids
    // it, against the PLATFORM's glob semantics (`*` = any substring), which
    // are deliberately wider than this module's own `hostMatches` (`*` = one
    // label) — the divergence is safe because ours only re-checks denies.
    const sdkGlobMatchesEverything = (host: string) => {
      const parts = OPEN_HOST.split("*");
      return host.startsWith(parts[0]!) && host.endsWith(parts[parts.length - 1]!);
    };
    for (const host of ["registry.npmjs.org", "telemetry.example.com", "a.b.c.evil.tld"])
      expect(sdkGlobMatchesEverything(host)).toBe(true);
    expect(hostMatches(OPEN_HOST, "registry.npmjs.org")).toBe(false);
  });

  it("legacy admits every host and records nothing", () => {
    const grant = buildGrant(params({ position: "legacy" }));
    expect(grant.allow).toEqual([OPEN_HOST]);
    expect(grant.catchAll).toBeUndefined();
    expect(grant.handlers).toEqual([]);
  });

  it("validates the selection in every position, so graduating cannot surprise", () => {
    for (const position of ["legacy", "report", "enforce"] as const)
      expect(() =>
        buildGrant(params({ repo: "", profiles: ["public-repo-read"], position })),
      ).toThrow(/needs a repo to compose onto/);
  });

  it("applies the catch-all before admitting, and re-points it on revoke", async () => {
    const { calls, t } = target();
    const grant = buildGrant(params({ position: "report" }));
    await applyGrant(t, grant);
    expect(calls.indexOf("catchall:reportOnly")).toBeLessThan(calls.indexOf(`allow:${OPEN_HOST}`));

    calls.length = 0;
    await revokeGrant(t, grant);
    // The SDK has no removal call for a catch-all, so "gone" has to be
    // expressed as "points at the handler that refuses everything".
    expect(calls).toEqual([`unallow:${OPEN_HOST}`, "catchall:denyAll"]);
  });
});

describe("the report position forwards and records", () => {
  const ctx = (position: "report" | "enforce"): OutboundContext<GrantParams> => ({
    containerId: CONTAINER,
    className: "SubstrateSandboxLean",
    params: params({ profiles: ["js-install"], position }),
  });

  const recorder = () => {
    const events: Omit<DenialEvent, "count">[] = [];
    return { events, recordDenial: (e: Omit<DenialEvent, "count">) => void events.push(e) };
  };

  it("passes a would-be-denied request straight through and records it", async () => {
    const rec = recorder();
    const upstream = new Response("ok", { status: 200 });
    const res = await serveGrantedRequest(
      new Request("https://telemetry.example.com/collect", { method: "POST", body: "x" }),
      ctx("report"),
      { fetchImpl: (async () => upstream) as unknown as typeof fetch, recordDenial: rec.recordDenial },
    );

    expect(res.status).toBe(200);
    expect(rec.events).toHaveLength(1);
    expect(rec.events[0]?.host).toBe("telemetry.example.com");
    expect(rec.events[0]?.reason.startsWith(WOULD_DENY_PREFIX)).toBe(true);
  });

  it("records nothing for a request the grant would have allowed", async () => {
    const rec = recorder();
    await serveGrantedRequest(new Request("https://registry.npmjs.org/effect"), ctx("report"), {
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      recordDenial: rec.recordDenial,
    });
    expect(rec.events).toEqual([]);
  });

  it("still refuses the same request under enforce", async () => {
    const rec = recorder();
    const res = await serveGrantedRequest(
      new Request("https://telemetry.example.com/collect", { method: "POST", body: "x" }),
      ctx("enforce"),
      {
        fetchImpl: (async () => new Response("unreached", { status: 200 })) as unknown as typeof fetch,
        recordDenial: rec.recordDenial,
      },
    );
    expect(res.status).toBe(403);
    expect(rec.events[0]?.reason.startsWith(WOULD_DENY_PREFIX)).toBe(false);
  });

  it("denyAll refuses without params, a network call, or an oracle", async () => {
    const res = egressHandlers.denyAll();
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("registry.npmjs.org");
  });
});
