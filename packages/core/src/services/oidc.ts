// @fractalboxdev/flare-dispatch-core — the `oidc` capability (Worker self-issued OIDC).
//
// The Dispatcher is a first-class OIDC issuer: it mints short-lived JWTs
// against a stable signing key whose public half is served at the deploy's
// `/.well-known/jwks.json` (+ `/.well-known/openid-configuration` for
// discovery). IdPs that trust the issuer URL — AWS STS / GCP STS / Vault —
// federate against those tokens to issue scoped, short-lived credentials.
//
// No long-lived cloud-provider keys land in Worker Secrets.
//
// Spec: specs/03-dsl.md § oidc, specs/05-byoc.md § AWS federation trust policy.

import { Context, Effect } from "effect";
import type { OidcSigningFailed } from "../errors";

/** A signed OIDC token plus its expiry. */
export type OidcToken = {
  /** Compact-serialised JWS — `header.payload.signature`. */
  readonly jwt: string;
  /** Epoch ms when the token stops being valid. */
  readonly expiresAt: number;
};

/** Caps how long a token lives — AWS STS / GCP STS refuse longer than 1h. */
export const OIDC_TOKEN_MAX_TTL_SEC = 3600;

/** Registered claims the signer sets itself; `claims` may not name them. */
export const OIDC_RESERVED_CLAIMS: readonly string[] = ["iss", "sub", "aud", "iat", "nbf", "exp", "jti"];

/** Default token TTL when the caller omits one (specs/03-dsl § oidc). */
export const OIDC_TOKEN_TTL_SEC_DEFAULT = 900;

/** The service contract a runtime Layer implements. */
export interface OidcService {
  /**
   * Sign a fresh OIDC token. `audience` is the IdP-specific value the
   * trust policy pins (e.g. "sts.amazonaws.com" for AWS). The subject is
   * `<run-name>:<execution-id>` so an IAM trust policy can scope a role to a
   * *specific run*: where the runtime pins it, a `subject` naming anything else
   * fails with `reason: "subject-pinned"`, so no run can mint another run's
   * identity. `claims` adds context and never overrides a registered claim — one
   * named `iss`, `sub`, `aud`, `iat`, `nbf`, `exp` or `jti` fails with
   * `reason: "reserved-claim"`. `ttlSec` defaults to
   * {@link OIDC_TOKEN_TTL_SEC_DEFAULT} and caps at {@link OIDC_TOKEN_MAX_TTL_SEC}.
   */
  readonly sign: (opts: {
    audience: string;
    subject?: string;
    ttlSec?: number;
    claims?: Readonly<Record<string, string | number | boolean>>;
  }) => Effect.Effect<OidcToken, OidcSigningFailed>;

  /**
   * The stable issuer URL the IdP's trust policy pins — derived from the
   * Worker's deployed origin (e.g. https://flare-dispatch.example.workers.dev).
   * Surfaced so a run can log it / surface it on the check-run.
   */
  readonly issuer: () => Effect.Effect<string>;
}

/** Context.Tag — the dependency a run carries until a Layer provides it. */
export class Oidc extends Context.Tag("@fractalboxdev/flare-dispatch-core/Oidc")<
  Oidc,
  OidcService
>() {}

/** The `oidc` accessor namespace — what runs import from `@fractalboxdev/flare-dispatch-core`. */
export const oidc = {
  sign: (opts: {
    audience: string;
    subject?: string;
    ttlSec?: number;
    claims?: Readonly<Record<string, string | number | boolean>>;
  }) => Effect.flatMap(Oidc, (o) => o.sign(opts)),
  issuer: () => Effect.flatMap(Oidc, (o) => o.issuer()),
} as const;
