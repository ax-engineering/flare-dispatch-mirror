// Cloudflare Access viewer-gate unit tests — pure WebCrypto, no Worker fixture.
//
// `crypto.subtle` (RSA generate/sign/verify, JWK export) is on the Node ≥ 20
// test runtime, so the JWT verifier and the request gate are tested directly: a
// throwaway RSA keypair signs real RS256 JWTs and a stubbed `fetch` serves the
// public JWK as the team's JWKS.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessIssuer,
  accessLoginUrl,
  clearAccessCertsCache,
  gateViewerAccess,
  resolveViewerAccessMode,
  verifyAccessJwt,
  type AccessJwk,
} from "./access-auth";
import type { Env } from "./env";

const ISSUER = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-deadbeef";
const KID = "test-kid-1";

const b64url = (bytes: Uint8Array | ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlJson = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let keyPair: CryptoKeyPair;
let publicJwk: AccessJwk;

beforeEach(async () => {
  clearAccessCertsCache();
  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  publicJwk = { kid: KID, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e };
});

afterEach(() => vi.restoreAllMocks());

/** Sign an RS256 JWT with the throwaway keypair. */
const makeJwt = async (
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" },
): Promise<string> => {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput) as BufferSource,
  );
  return `${signingInput}.${b64url(sig)}`;
};

const nowS = (): number => Math.floor(Date.now() / 1000);
const validClaims = (): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUD,
  exp: nowS() + 600,
  nbf: nowS() - 10,
  email: "operator@example.com",
});

describe("accessIssuer", () => {
  it("normalizes a bare team domain to an https origin", () => {
    expect(accessIssuer("team.cloudflareaccess.com")).toBe(ISSUER);
  });
  it("accepts a full URL and strips any trailing path/slash", () => {
    expect(accessIssuer("https://team.cloudflareaccess.com/")).toBe(ISSUER);
  });
});

describe("accessLoginUrl", () => {
  it("builds the team login URL with kid + the request path as redirect_url", () => {
    const url = accessLoginUrl(
      "team.cloudflareaccess.com",
      AUD,
      new Request("https://flare-dispatch.example/?from=check"),
    );
    expect(url).toBe(
      `${ISSUER}/cdn-cgi/access/login/flare-dispatch.example?kid=${AUD}&redirect_url=%2F%3Ffrom%3Dcheck`,
    );
  });
});

describe("resolveViewerAccessMode", () => {
  it("defaults to required when unset", () => {
    expect(resolveViewerAccessMode({} as Env)).toBe("required");
  });
  it("honours the explicit token-only opt-out", () => {
    expect(resolveViewerAccessMode({ VIEWER_ACCESS_MODE: "token-only" } as Env)).toBe("token-only");
  });
  it("treats any other value as the secure default", () => {
    expect(resolveViewerAccessMode({ VIEWER_ACCESS_MODE: "off" } as Env)).toBe("required");
  });
});

describe("verifyAccessJwt", () => {
  const params = () => ({ keys: [publicJwk], aud: AUD, issuer: ISSUER, nowSeconds: nowS() });

  it("accepts a well-formed, correctly-signed token", async () => {
    expect(await verifyAccessJwt(await makeJwt(validClaims()), params())).toBe(true);
  });

  it("accepts an aud array that contains the expected audience", async () => {
    const jwt = await makeJwt({ ...validClaims(), aud: ["other", AUD] });
    expect(await verifyAccessJwt(jwt, params())).toBe(true);
  });

  it("rejects a wrong audience", async () => {
    const jwt = await makeJwt({ ...validClaims(), aud: "someone-else" });
    expect(await verifyAccessJwt(jwt, params())).toBe(false);
  });

  it("rejects a wrong issuer", async () => {
    const jwt = await makeJwt({ ...validClaims(), iss: "https://evil.cloudflareaccess.com" });
    expect(await verifyAccessJwt(jwt, params())).toBe(false);
  });

  it("rejects an expired token (beyond skew)", async () => {
    const jwt = await makeJwt({ ...validClaims(), exp: nowS() - 120 });
    expect(await verifyAccessJwt(jwt, params())).toBe(false);
  });

  it("rejects a not-yet-valid token (beyond skew)", async () => {
    const jwt = await makeJwt({ ...validClaims(), nbf: nowS() + 120 });
    expect(await verifyAccessJwt(jwt, params())).toBe(false);
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const jwt = await makeJwt(validClaims());
    const [h, , s] = jwt.split(".");
    const forged = `${h}.${b64urlJson({ ...validClaims(), email: "attacker@evil.com" })}.${s}`;
    expect(await verifyAccessJwt(forged, params())).toBe(false);
  });

  it("rejects a non-RS256 alg (alg-confusion guard)", async () => {
    const jwt = await makeJwt(validClaims(), { alg: "none", kid: KID, typ: "JWT" });
    expect(await verifyAccessJwt(jwt, params())).toBe(false);
  });

  it("rejects when no key matches the token kid", async () => {
    const jwt = await makeJwt(validClaims(), { alg: "RS256", kid: "unknown", typ: "JWT" });
    expect(await verifyAccessJwt(jwt, params())).toBe(false);
  });

  it("rejects a structurally malformed token", async () => {
    expect(await verifyAccessJwt("not.a.jwt.at.all", params())).toBe(false);
    expect(await verifyAccessJwt("onlyonesegment", params())).toBe(false);
  });

  it("rejects (never throws on) an undecodable signature segment", async () => {
    // `atob` throws a DOMException on chars outside the base64 alphabet or a
    // length % 4 === 1. The header/payload are guarded; this asserts the
    // signature segment is too — otherwise the gate's `Effect.promise` turned
    // the rejection into a 500. A valid header+payload with a bad signature must
    // return false, not throw.
    const jwt = await makeJwt(validClaims());
    const [h, p] = jwt.split(".");
    expect(await verifyAccessJwt(`${h}.${p}.@@@@`, params())).toBe(false);
    expect(await verifyAccessJwt(`${h}.${p}.aaaaa`, params())).toBe(false);
  });
});

describe("gateViewerAccess", () => {
  const req = (headers: Record<string, string> = {}): Request =>
    new Request("https://flare-dispatch.example/logs/run:owner_repo:abc123", { headers });

  const configured = (): Env =>
    ({ ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }) as Env;

  const stubCerts = (keys: readonly AccessJwk[]): void => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u === `${ISSUER}/cdn-cgi/access/certs`) {
        return new Response(JSON.stringify({ keys }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  };

  it("token-only mode proceeds without any Access check", async () => {
    const env = { VIEWER_ACCESS_MODE: "token-only" } as Env;
    expect(await gateViewerAccess(env, req())).toBeNull();
  });

  it("required + unconfigured → 503 (default-secure, never falls open)", async () => {
    const denied = await gateViewerAccess({} as Env, req());
    expect(denied?.status).toBe(503);
    expect(await denied!.json()).toMatchObject({ error: "access_not_configured" });
  });

  it("required + configured but no JWT → 403", async () => {
    stubCerts([publicJwk]);
    const denied = await gateViewerAccess(configured(), req());
    expect(denied?.status).toBe(403);
    expect(await denied!.json()).toMatchObject({ error: "access_denied" });
  });

  it("required + configured, no JWT, browser navigation → 302 to Access login", async () => {
    stubCerts([publicJwk]);
    const denied = await gateViewerAccess(
      configured(),
      new Request("https://flare-dispatch.example/", {
        headers: { "Sec-Fetch-Mode": "navigate" },
      }),
    );
    expect(denied?.status).toBe(302);
    const loc = denied!.headers.get("location")!;
    expect(loc).toContain(`${ISSUER}/cdn-cgi/access/login/flare-dispatch.example`);
    expect(loc).toContain(`kid=${AUD}`);
    expect(loc).toContain("redirect_url=%2F");
  });

  it("required + configured, no JWT, text/html Accept → 302 to Access login", async () => {
    stubCerts([publicJwk]);
    const denied = await gateViewerAccess(
      configured(),
      new Request("https://flare-dispatch.example/", {
        headers: { Accept: "text/html,application/xhtml+xml" },
      }),
    );
    expect(denied?.status).toBe(302);
  });

  it("required + valid JWT in the assertion header → proceeds", async () => {
    stubCerts([publicJwk]);
    const jwt = await makeJwt(validClaims());
    const denied = await gateViewerAccess(configured(), req({ "Cf-Access-Jwt-Assertion": jwt }));
    expect(denied).toBeNull();
  });

  it("required + valid JWT in the CF_Authorization cookie → proceeds", async () => {
    stubCerts([publicJwk]);
    const jwt = await makeJwt(validClaims());
    const denied = await gateViewerAccess(
      configured(),
      req({ Cookie: `foo=bar; CF_Authorization=${jwt}` }),
    );
    expect(denied).toBeNull();
  });

  it("required + invalid JWT → 403", async () => {
    stubCerts([publicJwk]);
    const jwt = await makeJwt({ ...validClaims(), aud: "wrong" });
    const denied = await gateViewerAccess(configured(), req({ "Cf-Access-Jwt-Assertion": jwt }));
    expect(denied?.status).toBe(403);
  });

  it("required + certs endpoint serves no keys → 403", async () => {
    stubCerts([]);
    const jwt = await makeJwt(validClaims());
    const denied = await gateViewerAccess(configured(), req({ "Cf-Access-Jwt-Assertion": jwt }));
    expect(denied?.status).toBe(403);
  });

  it("delegates JWKS caching to the CF edge via cf.cacheTtl", async () => {
    stubCerts([publicJwk]);
    const jwt = await makeJwt(validClaims());
    await gateViewerAccess(configured(), req({ "Cf-Access-Jwt-Assertion": jwt }));
    // Caching is the platform's job (a CF-native primitive), not a hand-rolled
    // module Map — the certs fetch carries the edge-cache hint.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${ISSUER}/cdn-cgi/access/certs`,
      expect.objectContaining({
        cf: expect.objectContaining({ cacheTtl: 3600, cacheEverything: true }),
      }),
    );
  });

  it("revalidates the JWKS on a kid miss (key rotation), then proceeds", async () => {
    // Access starts signing with a key minted after our last fetch: the token's
    // kid isn't in the cached JWKS. The gate must revalidate against origin and
    // pick up the rotated key — not 403 every viewer until the cache lapses.
    const rotatedJwk = { ...publicJwk, kid: "rotated-kid" };
    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === `${ISSUER}/cdn-cgi/access/certs`) {
        call += 1;
        return new Response(JSON.stringify({ keys: call === 1 ? [publicJwk] : [rotatedJwk] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const jwt = await makeJwt(validClaims(), {
      alg: "RS256",
      kid: "rotated-kid",
      typ: "JWT",
    });
    const denied = await gateViewerAccess(configured(), req({ "Cf-Access-Jwt-Assertion": jwt }));
    expect(denied).toBeNull(); // proceeded after revalidation
    expect(call).toBe(2); // one edge-cached read + one revalidate
  });

  it("does not revalidate on an ordinary bad signature (known kid)", async () => {
    // A tampered token whose kid IS known must not trigger an origin refetch —
    // that would let a flood of bad tokens amplify into a flood of fetches.
    stubCerts([publicJwk]);
    const jwt = await makeJwt(validClaims());
    const [h, , s] = jwt.split(".");
    const tampered = `${h}.${b64urlJson({ ...validClaims(), email: "x@evil.com" })}.${s}`;
    const denied = await gateViewerAccess(
      configured(),
      req({ "Cf-Access-Jwt-Assertion": tampered }),
    );
    expect(denied?.status).toBe(403);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // no revalidation
  });
});
