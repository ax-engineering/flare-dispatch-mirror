// FlareDispatch Dispatcher — compile-cache tokens.
//
// The compile-cache route (routes/compile-cache.ts) admits a request carrying
// a token minted for one repository, one execution and one lane, valid until
// that execution's ceiling:
//
//   token = "cc2." <expiresAt> "." base64url(executionId) "." lane "." mac
//   mac   = base64url( HMAC-SHA256( k_cc, "cc2\n" repo "\n" executionId "\n" lane "\n" expiresAt ) )
//   k_cc  = HKDF-SHA256( HMAC_SECRET, salt="", info="flare-dispatch/compile-cache/v1" )
//
// `lane` (primitives/compile-cache.ts `CompileCacheLane`) decides where the
// token's writes land and which entries it reads: `base`, `pr-<n>` or
// `read-only`. The run definition names it from the execution's trigger; a
// dispatch caller able to name `base` holds `HMAC_SECRET`, the key this MAC
// derives from, so the lane adds no authority the caller lacks.
//
// `repo` is lowercase `owner/name` and is not in the token: the route takes it
// from the request path, so a token presented under another repository's
// prefix fails the MAC. `expiresAt` is epoch seconds. The HKDF label keeps
// `k_cc` independent of the dispatch HMAC and of every other capability token
// derived from `HMAC_SECRET`.
//
// The workflow mints the token on every invocation of the execution and
// derives `expiresAt` from the instance's creation time, so each invocation
// mints the identical token: a check command's fingerprint covers its env,
// and a token that changed across a replay would refuse the command's launch.

import {
  COMPILE_CACHE_ENDPOINT_KEY,
  COMPILE_CACHE_TOKEN_KEY,
  type CompileCacheLane,
  isCompileCacheLane,
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { deriveSecret } from "./capability-token";
import type { Env } from "./env";

const HKDF_INFO = "flare-dispatch/compile-cache/v1";
const VERSION = "cc2";

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromBase64url = (text: string): string | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
};

/** The execution id charset (log-token.ts `EXECUTION_ID_RE`). */
const EXECUTION_ID = /^[A-Za-z0-9:_-]{3,128}$/;

/** The token's scope: one repository, one execution, one lane, until `expiresAt` (epoch seconds). */
export type CompileCacheScope = {
  readonly repo: string;
  readonly executionId: string;
  readonly lane: CompileCacheLane;
  readonly expiresAt: number;
};

const macKey = async (ikm: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    encoder.encode(await deriveSecret(ikm, HKDF_INFO)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

const message = (scope: CompileCacheScope): Uint8Array =>
  encoder.encode(
    `${VERSION}\n${scope.repo.toLowerCase()}\n${scope.executionId}\n${scope.lane}\n${scope.expiresAt}`,
  );

/** The key material: the Worker's `HMAC_SECRET`; `undefined` when unset (the route then refuses). */
export const resolveCompileCacheSecret = (env: Pick<Env, "HMAC_SECRET">): string | undefined =>
  typeof env.HMAC_SECRET === "string" && env.HMAC_SECRET.length > 0 ? env.HMAC_SECRET : undefined;

/** Mint the token for `scope`. */
export const signCompileCacheToken = async (ikm: string, scope: CompileCacheScope): Promise<string> => {
  if (!EXECUTION_ID.test(scope.executionId)) throw new Error("compile-cache token: invalid execution id");
  if (!isCompileCacheLane(scope.lane)) throw new Error("compile-cache token: invalid lane");
  if (!Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= 0)
    throw new Error("compile-cache token: invalid expiry");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(ikm), message(scope)));
  return `${VERSION}.${scope.expiresAt}.${base64url(encoder.encode(scope.executionId))}.${scope.lane}.${base64url(mac)}`;
};

/** Why a presented token was refused. */
export type CompileCacheTokenRefusal = "malformed" | "expired" | "invalid";

/**
 * Verify `presented` for `repo` at `nowSec`. The MAC is checked with
 * `crypto.subtle.verify`, which compares in constant time.
 */
export const verifyCompileCacheToken = async (
  ikm: string,
  repo: string,
  presented: string,
  nowSec: number,
): Promise<{ readonly ok: true; readonly scope: CompileCacheScope } | { readonly ok: false; readonly reason: CompileCacheTokenRefusal }> => {
  const parts = presented.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION || !/^[1-9][0-9]{0,15}$/.test(parts[1]!))
    return { ok: false, reason: "malformed" };
  const expiresAt = Number(parts[1]);
  const executionId = fromBase64url(parts[2]!);
  const lane = parts[3]!;
  if (
    executionId === undefined ||
    !EXECUTION_ID.test(executionId) ||
    !isCompileCacheLane(lane) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[4]!)
  )
    return { ok: false, reason: "malformed" };
  const mac = Uint8Array.from(atob(parts[4]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const scope = { repo, executionId, lane, expiresAt };
  const valid = await crypto.subtle.verify("HMAC", await macKey(ikm), mac, message(scope));
  if (!valid) return { ok: false, reason: "invalid" };
  if (nowSec >= expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, scope };
};

/** What the workflow knows when it decides whether to mint. */
export type CompileCacheMint = {
  /** The run's own answer (`RunSpec.compileCache`): its lane, or `undefined` for no cache. */
  readonly lane: CompileCacheLane | undefined;
  readonly repo: string;
  readonly executionId: string;
  /** The Workflow instance's creation time, epoch ms: stable across invocations. */
  readonly createdAtMs: number;
  /** The run's admission queue age plus its `maxDurationSec`. */
  readonly ceilingSec: number;
  readonly publicOrigin: string | undefined;
  readonly secret: string | undefined;
};

/** A minted grant: the config overrides that carry it, its lane, and its token's expiry (epoch seconds). */
export type CompileCacheGrant = {
  readonly overrides: Record<string, string>;
  readonly lane: CompileCacheLane;
  readonly expiresAt: number;
};

/**
 * The grant that hands a run its compile-cache endpoint and token, or
 * `undefined` when the run does not want the cache or the deploy has no
 * public origin or signing secret.
 */
export const compileCacheOverrides = async (mint: CompileCacheMint): Promise<CompileCacheGrant | undefined> => {
  if (mint.lane === undefined || mint.publicOrigin === undefined || mint.publicOrigin === "" || mint.secret === undefined)
    return undefined;
  const expiresAt = Math.floor(mint.createdAtMs / 1000) + Math.ceil(mint.ceilingSec);
  const token = await signCompileCacheToken(mint.secret, {
    repo: mint.repo,
    executionId: mint.executionId,
    lane: mint.lane,
    expiresAt,
  });
  return {
    overrides: {
      [COMPILE_CACHE_ENDPOINT_KEY]: `${mint.publicOrigin.replace(/\/$/, "")}/v1/compile-cache`,
      [COMPILE_CACHE_TOKEN_KEY]: token,
    },
    lane: mint.lane,
    expiresAt,
  };
};
