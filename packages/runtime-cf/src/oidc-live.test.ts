// Tests for OidcLive — ES256 JWT signing via WebCrypto SubtleCrypto.
//
// Generates a fresh P-256 keypair per test (`crypto.subtle.generateKey` is
// always available on the Node 22+ + Workers runtime this repo pins), wraps
// it as a JWK, hands it to `makeOidcLive`, and asserts on the JWT shape +
// signature verifiability. The signature is checked with the public JWK we
// derive at the same time — exactly what AWS STS does at the JWKS endpoint.

import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { Oidc } from "@fractalboxdev/flare-dispatch-core";
import { makeOidcLive, publicJwkFromSigning } from "./oidc-live";

const decodeSegment = (seg: string): unknown => {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return JSON.parse(atob(b64 + pad));
};

const base64urlToBytes = (seg: string): Uint8Array => {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const ISSUER = "https://flare-dispatch.example.com";

/** Generate a fresh ES256 JWK pair for the test. */
const freshSigningJwk = async (): Promise<{
  privateJwk: string;
  publicKey: CryptoKey;
}> => {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  // Attach a stable `kid` so the spec's `kid` rotation story works.
  (privateJwk as JsonWebKey & { kid?: string }).kid = "test-key-2026";
  return {
    privateJwk: JSON.stringify(privateJwk),
    publicKey: pair.publicKey,
  };
};

describe("makeOidcLive — sign()", () => {
  it("emits a valid JWT whose ES256 signature verifies under the public key", async () => {
    const { privateJwk, publicKey } = await freshSigningJwk();
    const layer = makeOidcLive({
      signingJwkJson: privateJwk,
      issuerUrl: ISSUER,
      subjectDefault: "ai-code-review:01ABC",
    });

    const token = await Effect.runPromise(
      Effect.flatMap(Oidc, (o) =>
        o.sign({
          audience: "sts.amazonaws.com",
          ttlSec: 300,
          claims: { role: "bedrock-reader" },
        }),
      ).pipe(Effect.provide(layer)),
    );

    const [headerSeg, payloadSeg, signatureSeg] = token.jwt.split(".");
    expect(headerSeg).toBeDefined();
    expect(payloadSeg).toBeDefined();
    expect(signatureSeg).toBeDefined();

    const header = decodeSegment(headerSeg!) as Record<string, unknown>;
    const payload = decodeSegment(payloadSeg!) as Record<string, unknown>;

    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe("test-key-2026");

    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe("sts.amazonaws.com");
    expect(payload.sub).toBe("ai-code-review:01ABC");
    expect(payload.role).toBe("bedrock-reader");
    expect(typeof payload.jti).toBe("string");
    expect((payload.exp as number) - (payload.iat as number)).toBe(300);

    // Verify the signature with the same public key. This is what AWS STS
    // does against /.well-known/jwks.json.
    const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
    const sigBytes = base64urlToBytes(signatureSeg!);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sigBytes,
      signingInput,
    );
    expect(ok).toBe(true);
  });

  it("malformed signing JWK → OidcSigningFailed with reason=key-load", async () => {
    const layer = makeOidcLive({
      signingJwkJson: "this is not json",
      issuerUrl: ISSUER,
    });
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Oidc, (o) => o.sign({ audience: "sts.amazonaws.com" })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("non-EC JWK → OidcSigningFailed", async () => {
    const layer = makeOidcLive({
      signingJwkJson: JSON.stringify({ kty: "RSA", n: "x", e: "AQAB" }),
      issuerUrl: ISSUER,
    });
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Oidc, (o) => o.sign({ audience: "sts.amazonaws.com" })).pipe(
        Effect.provide(layer),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("signs only the execution's own subject once the runtime pins it", async () => {
    const { privateJwk } = await freshSigningJwk();
    const layer = makeOidcLive({ signingJwkJson: privateJwk, issuerUrl: ISSUER, subjectDefault: "pr-review:01ABC" });
    const sign = (subject?: string) =>
      Effect.runPromiseExit(
        Effect.flatMap(Oidc, (o) => o.sign({ audience: "sts.amazonaws.com", ...(subject ? { subject } : {}) })).pipe(
          Effect.provide(layer),
        ),
      );

    // Another run's identity is refused, so a role scoped to `pr-review:*` cannot be assumed from elsewhere.
    const forged = await sign("deploy:01XYZ");
    expect(Exit.isFailure(forged)).toBe(true);
    if (Exit.isFailure(forged)) expect(Cause.squash(forged.cause)).toMatchObject({ _tag: "OidcSigningFailed", reason: "subject-pinned" });

    // Naming the pinned subject, or none, signs as the execution.
    for (const exit of [await sign("pr-review:01ABC"), await sign()]) {
      expect(Exit.isSuccess(exit)).toBe(true);
      if (Exit.isSuccess(exit)) expect((decodeSegment(exit.value.jwt.split(".")[1]!) as Record<string, unknown>).sub).toBe("pr-review:01ABC");
    }
  });

  it("refuses claims that name a registered claim, whatever the subject", async () => {
    const { privateJwk } = await freshSigningJwk();
    const layer = makeOidcLive({ signingJwkJson: privateJwk, issuerUrl: ISSUER, subjectDefault: "pr-review:01ABC" });
    const forged: ReadonlyArray<Readonly<Record<string, string | number>>> = [{ sub: "deploy:01XYZ" }, { aud: "other" }, { iss: "https://elsewhere.example" }, { exp: 9999999999 }];
    for (const claims of forged) {
      const exit = await Effect.runPromiseExit(
        Effect.flatMap(Oidc, (o) => o.sign({ audience: "sts.amazonaws.com", claims })).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "OidcSigningFailed", reason: "reserved-claim" });
    }
  });

  it("issuer() returns the configured issuer", async () => {
    const { privateJwk } = await freshSigningJwk();
    const layer = makeOidcLive({
      signingJwkJson: privateJwk,
      issuerUrl: ISSUER,
    });
    const iss = await Effect.runPromise(
      Effect.flatMap(Oidc, (o) => o.issuer()).pipe(Effect.provide(layer)),
    );
    expect(iss).toBe(ISSUER);
  });
});

describe("publicJwkFromSigning", () => {
  it("strips the private `d` component, pins use=sig + alg=ES256", async () => {
    const { privateJwk } = await freshSigningJwk();
    const pub = publicJwkFromSigning(privateJwk) as JsonWebKey & {
      kid?: string;
      d?: string;
    };
    expect(pub.kty).toBe("EC");
    expect(pub.crv).toBe("P-256");
    expect(pub.d).toBeUndefined();
    expect(pub.use).toBe("sig");
    expect(pub.alg).toBe("ES256");
    expect(pub.kid).toBe("test-key-2026");
  });

  it("throws on a JWK missing the d component (not a private key)", () => {
    expect(() =>
      publicJwkFromSigning(JSON.stringify({ kty: "EC", crv: "P-256", x: "x", y: "y" })),
    ).toThrow();
  });
});
