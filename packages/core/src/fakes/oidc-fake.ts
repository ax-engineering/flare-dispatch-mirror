// @fractalboxdev/flare-dispatch-core — Oidc fake (deterministic OIDC issuance).
//
// Returns a canned JWT-shaped string for each `sign` call — the payload's
// header+claims are echoed back so a test can decode them and assert on
// `audience`, `subject`, `claims`, `ttlSec`. The "signature" is a fixed
// placeholder; tests should never verify it.
//
// The fake records every call so a test can assert "the run minted exactly
// one OIDC token for the AWS audience" without standing up SubtleCrypto.

import { Effect, Layer } from "effect";
import {
  OIDC_TOKEN_TTL_SEC_DEFAULT,
  OIDC_TOKEN_MAX_TTL_SEC,
  Oidc,
  type OidcService,
  type OidcToken,
} from "../services/oidc";

export type OidcFakeState = {
  /** Every `sign` call, in order. */
  readonly signCalls: Array<{
    audience: string;
    subject?: string;
    ttlSec?: number;
    claims?: Readonly<Record<string, string | number | boolean>>;
  }>;
  /** Every `issuer` call (rarely asserted, but recorded for completeness). */
  issuerCalls: number;
};

const FAKE_ISSUER = "https://fake-oidc.flare-dispatch.local";
const FAKE_SIGNATURE = "fake-signature";

/**
 * Build the Oidc fake. The JWT it returns is a real `header.payload.sig`
 * triple — the header + payload are valid base64url JSON so a test can
 * decode them. The signature is a constant placeholder.
 */
export const makeOidcFake = (
  opts: { issuer?: string; now?: number } = {},
): { layer: Layer.Layer<Oidc>; state: OidcFakeState } => {
  const state: OidcFakeState = { signCalls: [], issuerCalls: 0 };
  const issuer = opts.issuer ?? FAKE_ISSUER;
  const now = opts.now;

  const base64url = (str: string): string => {
    // btoa is in the Worker runtime + Node 18+; use it directly.
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  };

  const service: OidcService = {
    sign: ({ audience, subject, ttlSec, claims }) =>
      Effect.sync((): OidcToken => {
        state.signCalls.push({ audience, subject, ttlSec, claims });
        const effectiveTtl = Math.min(ttlSec ?? OIDC_TOKEN_TTL_SEC_DEFAULT, OIDC_TOKEN_MAX_TTL_SEC);
        const iat = Math.floor((now ?? Date.now()) / 1000);
        const exp = iat + effectiveTtl;
        const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "fake-kid" }));
        const payload = base64url(
          // Registered claims last, as the live signer writes them.
          JSON.stringify({
            ...claims,
            iss: issuer,
            sub: subject ?? "fake-subject",
            aud: audience,
            iat,
            exp,
            jti: `fake-jti-${state.signCalls.length}`,
          }),
        );
        return {
          jwt: `${header}.${payload}.${FAKE_SIGNATURE}`,
          expiresAt: exp * 1000,
        };
      }),

    issuer: () =>
      Effect.sync(() => {
        state.issuerCalls += 1;
        return issuer;
      }),
  };

  return { layer: Layer.succeed(Oidc, service), state };
};

/** Ready-to-use Oidc fake — default issuer, current-time `iat`. */
export const OidcFake: Layer.Layer<Oidc> = makeOidcFake().layer;
