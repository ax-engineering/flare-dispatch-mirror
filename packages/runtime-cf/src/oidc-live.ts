// @fractalboxdev/flare-dispatch-runtime-cf — OidcLive: ES256 OIDC token signing.
//
// Signs short-lived JWTs against a stable ES256 (ECDSA on P-256 with SHA-256)
// signing key whose public half is served at the deploy's `/.well-known/
// jwks.json`. AWS STS (and any other IdP) verifies the signature against that
// JWKS, so the role's trust policy can name this Dispatcher as a federated
// identity provider.
//
// --- Key material -----------------------------------------------------------
//
// The private JWK lives in the `OIDC_SIGNING_JWK` Worker secret as a JSON
// string. WebCrypto's `crypto.subtle.importKey("jwk", ...)` parses it; the
// returned `CryptoKey` is held in module memory for the Worker isolate's
// lifetime (re-imported on a fresh isolate; the operation is cheap).
//
// Rotating the key is `pnpm cli oidc keygen | wrangler secret put
// OIDC_SIGNING_JWK` + redeploy; AWS picks up the new `kid` on its next token
// exchange (the public JWKS we serve includes the new public key).
//
// --- JWS compact serialisation ----------------------------------------------
//
// `header.payload.signature`, where:
//   * `header`   = base64url(JSON.stringify({alg: "ES256", typ: "JWT", kid}))
//   * `payload`  = base64url(JSON.stringify(claims))
//   * `signature` = base64url of the raw 64-byte (r || s) ES256 signature
//                   over the ASCII bytes of "header.payload".
//
// WebCrypto's `crypto.subtle.sign` returns the raw concatenated signature on
// ECDSA — no DER unwrapping needed for the JWS form.
//
// Spec: specs/03-dsl.md § oidc, specs/05-byoc.md § AWS federation trust policy.

import { Effect, Layer } from "effect";
import {
  OIDC_RESERVED_CLAIMS,
  OIDC_TOKEN_TTL_SEC_DEFAULT,
  OIDC_TOKEN_MAX_TTL_SEC,
  Oidc,
  OidcSigningFailed,
  type OidcService,
} from "@fractalboxdev/flare-dispatch-core";

/** Live Oidc Layer config — operator-supplied at deploy time. */
export type OidcLiveConfig = {
  /**
   * The Dispatcher's ES256 private JWK as a JSON string (`OIDC_SIGNING_JWK`
   * Worker secret). MUST be a P-256 EC key with the private `d` component;
   * the public coordinates flow to JWKS.
   */
  readonly signingJwkJson: string;
  /**
   * The stable issuer URL — the Worker's origin, e.g.
   * `https://flare-dispatch.example.workers.dev`. Pinned by AWS / GCP trust
   * policies, so it must match exactly what's registered as the OIDC provider.
   */
  readonly issuerUrl: string;
  /**
   * The execution's subject. The Dispatcher sets it to `<run-name>:<execution-id>`
   * at Layer construction; once set it is the only subject this Layer signs, so a
   * run cannot present another run's identity to a trust policy scoped by `sub`.
   */
  readonly subjectDefault?: string;
};

/** A JWK with at least the fields we need to sign. */
type SigningJwk = JsonWebKey & {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly d: string;
  readonly x: string;
  readonly y: string;
  readonly kid?: string;
  readonly alg?: string;
};

const base64url = (input: ArrayBuffer | Uint8Array | string): string => {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

/** Parse + sanity-check the JWK; throws (catch as OidcSigningFailed). */
const parseJwk = (json: string): SigningJwk => {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("OIDC_SIGNING_JWK is not a JSON object");
  }
  const j = parsed as JsonWebKey;
  if (j.kty !== "EC" || j.crv !== "P-256") {
    throw new Error("OIDC_SIGNING_JWK must be a P-256 EC key (kty=EC, crv=P-256)");
  }
  if (typeof (j as { d?: unknown }).d !== "string") {
    throw new Error("OIDC_SIGNING_JWK is missing the private `d` component");
  }
  return j as SigningJwk;
};

/** Import the JWK as a sign-capable WebCrypto key. */
const importSigningKey = (jwk: SigningJwk): Promise<CryptoKey> =>
  crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

/**
 * Build the live `Oidc` Layer from the deploy's signing config.
 * Imports the signing key lazily on first `sign` call and caches in-isolate.
 */
export const makeOidcLive = (config: OidcLiveConfig): Layer.Layer<Oidc> => {
  // Lazy cache so we don't fail Layer construction when the key is malformed
  // — the typed `OidcSigningFailed` surfaces on the first `sign` call,
  // matching the spec's "config error is a deploy-time misconfiguration".
  let cached: { jwk: SigningJwk; key: CryptoKey } | undefined;
  const resolveKey = async (): Promise<{ jwk: SigningJwk; key: CryptoKey }> => {
    if (cached !== undefined) return cached;
    const jwk = parseJwk(config.signingJwkJson);
    const key = await importSigningKey(jwk);
    cached = { jwk, key };
    return cached;
  };

  const signToken = ({ audience, subject, ttlSec, claims }: { readonly audience: string; readonly subject: string;
    readonly ttlSec: number | undefined; readonly claims: Readonly<Record<string, string | number | boolean>> | undefined }) =>
    Effect.tryPromise({
      try: async () => {
        const { jwk, key } = await resolveKey();
        const ttl = Math.min(ttlSec ?? OIDC_TOKEN_TTL_SEC_DEFAULT, OIDC_TOKEN_MAX_TTL_SEC);
        const iat = Math.floor(Date.now() / 1000);
        const exp = iat + ttl;
        const headerSegment = base64url(
          JSON.stringify({
            alg: "ES256",
            typ: "JWT",
            ...(jwk.kid !== undefined ? { kid: jwk.kid } : {}),
          }),
        );
        const payloadSegment = base64url(
          // Registered claims come last, so no custom claim can stand in for one.
          JSON.stringify({
            ...claims,
            iss: config.issuerUrl,
            sub: subject,
            aud: audience,
            iat,
            exp,
            jti: crypto.randomUUID(),
          }),
        );
        const signingInput = `${headerSegment}.${payloadSegment}`;
        const sigBytes = await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          new TextEncoder().encode(signingInput),
        );
        const signatureSegment = base64url(sigBytes);
        return {
          jwt: `${signingInput}.${signatureSegment}`,
          expiresAt: exp * 1000,
        };
      },
      catch: (cause): OidcSigningFailed => {
        const message = cause instanceof Error ? cause.message : String(cause);
        // Heuristic: key-import / JSON-parse failures are key-load; anything
        // else (almost certainly a SubtleCrypto sign reject) is subtle-sign.
        const reason = /JWK|JSON|import|component/i.test(message)
          ? ("key-load" as const)
          : ("subtle-sign" as const);
        return new OidcSigningFailed({ reason, cause });
      },
    });

  const service: OidcService = {
    sign: ({ audience, subject, ttlSec, claims }) =>
      Effect.gen(function* () {
        if (config.subjectDefault !== undefined && subject !== undefined && subject !== config.subjectDefault) {
          return yield* Effect.fail(new OidcSigningFailed({ reason: "subject-pinned",
            cause: new Error(`this execution signs as ${config.subjectDefault} only`) }));
        }
        const reserved = Object.keys(claims ?? {}).filter((key) => OIDC_RESERVED_CLAIMS.includes(key));
        if (reserved.length > 0) {
          return yield* Effect.fail(new OidcSigningFailed({ reason: "reserved-claim",
            cause: new Error(`claims may not set ${reserved.join(", ")}`) }));
        }
        return yield* signToken({ audience, subject: subject ?? config.subjectDefault ?? "unspecified", ttlSec, claims });
      }),

    issuer: () => Effect.succeed(config.issuerUrl),
  };

  return Layer.succeed(Oidc, service);
};

/**
 * Public-only JWK that JWKS serves. Strips the private `d` component from
 * the signing JWK and pins `use: "sig"`, `alg: "ES256"`.
 */
export const publicJwkFromSigning = (jwkJson: string): JsonWebKey => {
  const j = parseJwk(jwkJson);
  return {
    kty: "EC",
    crv: "P-256",
    x: j.x,
    y: j.y,
    use: "sig",
    alg: "ES256",
    ...(j.kid !== undefined ? { kid: j.kid } : {}),
  };
};
