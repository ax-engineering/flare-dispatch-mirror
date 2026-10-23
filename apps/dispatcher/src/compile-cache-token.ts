// FlareDispatch Dispatcher — compile-cache tokens.
//
// The compile-cache route (routes/compile-cache.ts) admits a request carrying
// a token minted for one repository and one execution, valid until that
// execution's ceiling:
//
//   token = "cc1." <expiresAt> "." base64url(executionId) "." mac
//   mac   = base64url( HMAC-SHA256( k_cc, "cc1\n" repo "\n" executionId "\n" expiresAt ) )
//   k_cc  = HKDF-SHA256( HMAC_SECRET, salt="", info="flare-dispatch/compile-cache/v1" )
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
} from "@fractalboxdev/flare-dispatch-core/primitives";
import { deriveSecret } from "./capability-token";
import type { Env } from "./env";

const HKDF_INFO = "flare-dispatch/compile-cache/v1";
const VERSION = "cc1";

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

/** The token's scope: one repository, one execution, until `expiresAt` (epoch seconds). */
export type CompileCacheScope = {
  readonly repo: string;
  readonly executionId: string;
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
  encoder.encode(`${VERSION}\n${scope.repo.toLowerCase()}\n${scope.executionId}\n${scope.expiresAt}`);

/** The key material: the Worker's `HMAC_SECRET`; `undefined` when unset (the route then refuses). */
export const resolveCompileCacheSecret = (env: Pick<Env, "HMAC_SECRET">): string | undefined =>
  typeof env.HMAC_SECRET === "string" && env.HMAC_SECRET.length > 0 ? env.HMAC_SECRET : undefined;

/** Mint the token for `scope`. */
export const signCompileCacheToken = async (ikm: string, scope: CompileCacheScope): Promise<string> => {
  if (!EXECUTION_ID.test(scope.executionId)) throw new Error("compile-cache token: invalid execution id");
  if (!Number.isSafeInteger(scope.expiresAt) || scope.expiresAt <= 0)
    throw new Error("compile-cache token: invalid expiry");
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await macKey(ikm), message(scope)));
  return `${VERSION}.${scope.expiresAt}.${base64url(encoder.encode(scope.executionId))}.${base64url(mac)}`;
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
  if (parts.length !== 4 || parts[0] !== VERSION || !/^[1-9][0-9]{0,15}$/.test(parts[1]!))
    return { ok: false, reason: "malformed" };
  const expiresAt = Number(parts[1]);
  const executionId = fromBase64url(parts[2]!);
  if (executionId === undefined || !EXECUTION_ID.test(executionId) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3]!))
    return { ok: false, reason: "malformed" };
  const mac = Uint8Array.from(atob(parts[3]!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const scope = { repo, executionId, expiresAt };
  const valid = await crypto.subtle.verify("HMAC", await macKey(ikm), mac, message(scope));
  if (!valid) return { ok: false, reason: "invalid" };
  if (nowSec >= expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, scope };
};

/** What the workflow knows when it decides whether to mint. */
export type CompileCacheMint = {
  /** The run's own answer (`RunSpec.compileCache`). */
  readonly wanted: boolean;
  readonly repo: string;
  readonly executionId: string;
  /** The Workflow instance's creation time, epoch ms: stable across invocations. */
  readonly createdAtMs: number;
  /** The run's admission queue age plus its `maxDurationSec`. */
  readonly ceilingSec: number;
  readonly publicOrigin: string | undefined;
  readonly secret: string | undefined;
};

/**
 * The config overrides that hand a run its compile-cache endpoint and token,
 * or `undefined` when the run does not want the cache or the deploy has no
 * public origin or signing secret.
 */
export const compileCacheOverrides = async (
  mint: CompileCacheMint,
): Promise<Record<string, string> | undefined> => {
  if (!mint.wanted || mint.publicOrigin === undefined || mint.publicOrigin === "" || mint.secret === undefined)
    return undefined;
  const token = await signCompileCacheToken(mint.secret, {
    repo: mint.repo,
    executionId: mint.executionId,
    expiresAt: Math.floor(mint.createdAtMs / 1000) + Math.ceil(mint.ceilingSec),
  });
  return {
    [COMPILE_CACHE_ENDPOINT_KEY]: `${mint.publicOrigin.replace(/\/$/, "")}/v1/compile-cache`,
    [COMPILE_CACHE_TOKEN_KEY]: token,
  };
};
