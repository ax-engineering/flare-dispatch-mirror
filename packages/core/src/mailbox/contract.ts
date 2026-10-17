// @fractalboxdev/flare-dispatch-core — the mailbox contract (the keystone every piece shares).
//
// A self-hosted, disposable inbox so a test/demo run can drive an OTP /
// magic-link auth flow (Auth0 / Clerk / Stytch / Supabase / our own app) end to
// end: the run provisions a fresh address, hands it to the provider as the
// user's email, and the verification message lands in our Cloudflare Email
// Routing `email()` handler (apps/dispatcher). The handler signals the paused
// run with the message; `waitForOtp` extracts the code or link.
//
// This module is the ONE shared shape: the address scheme, the event type the
// handler signals, and the message schema the run decodes. The `email()`
// handler (apps/dispatcher), the `Mailbox` capability (services/mailbox.ts), the
// `waitForOtp` primitive (primitives/wait-for-otp.ts), and the read route all
// import from here so the wire format can never drift.
//
// --- Why a random local-part + an allocations table, not an encoded id -------
//
// An execution id can be the semantic `{run}:{owner_repo}:{sha12}` form — `:`
// and length that no email local-part can carry (RFC 5321 caps the local-part
// at 64 octets). So `allocate` mints a SHORT RANDOM local-part (`demo-<rand>`),
// records `localPart → executionId` durably (the `inbox_allocations` table),
// and the `email()` handler resolves the executionId by lookup before it
// `sendEvent`s the paused Workflow instance. The address stays short and
// unguessable; READ access is gated by a separate capability token, never by
// the address.
//
// Spec: specs/03-dsl.md § mailbox, .tmp/email-otp-design.md.

import { Schema } from "effect";

/**
 * The `step.waitForEvent` type the `email()` handler signals when a message
 * arrives for a provisioned address. `waitForOtp` waits on exactly this type;
 * the payload is an `InboxMessage`.
 */
export const INBOX_EVENT_TYPE = "mailbox-message" as const;

/** Minted local-parts are namespaced under this prefix — the `email()` handler
 * `setReject`s any RCPT that does not match it, BEFORE buffering the raw MIME,
 * so a catch-all on a shared zone never stores non-test mail. */
export const INBOX_LOCAL_PREFIX = "demo" as const;

/**
 * The valid shape of a minted local-part: `demo-` + a lowercase hex/base36
 * random (the dash-stripped `io.uuid`). Deliberately tight — it is matched
 * against the *envelope* RCPT (`message.to`) as the storage guard, so it must
 * refuse anything that could smuggle other mail in. 16–40 chars of random keeps
 * it unguessable while the whole address stays far under the 64-octet cap.
 */
export const INBOX_LOCAL_PART_RE = /^demo-[a-z0-9]{16,40}$/;

/** Default lifetime of a provisioned inbox + its read token (seconds). Kept
 * tight: a received OTP / magic link is a live credential, so the row and the
 * token both expire fast and the row is burned on first read. */
export const INBOX_TTL_SEC_DEFAULT = 600; // 10 minutes

/** Default wait for the verification email before `waitForOtp` times out. OTP
 * mail tail-latency runs to ~2 min under provider queues + the CF receive hop,
 * so the floor is generous; callers override per provider. */
export const INBOX_WAIT_DEFAULT = "120 seconds" as const;

/**
 * One received message — BOTH the `waitForEvent` payload the `email()` handler
 * signals AND the row shape the read route serves. Text-only by design: the
 * HTML alternative doubles the at-rest account-takeover surface for a magic
 * link, and the plain-text part carries the code/link for every provider we
 * target. Decoded against this schema on the run side, so a malformed signal
 * surfaces as `EventPayloadInvalid` rather than a silent bad read.
 */
export const InboxMessage = Schema.Struct({
  /** ULID of the stored message row. */
  id: Schema.String,
  /** The minted local-part the message was addressed to (`demo-<rand>`). */
  localPart: Schema.String,
  /** Full recipient address (`demo-<rand>@<inbox-domain>`). */
  recipient: Schema.String,
  /** Envelope MAIL FROM — trustworthy (not the spoofable `From:` header). */
  sender: Schema.String,
  /** Subject line (OTP codes very often live here — searched first). */
  subject: Schema.String,
  /** Plain-text body, transfer-decoded. The code/link is extracted from this. */
  text: Schema.String,
  /** Receipt time, epoch ms. */
  receivedAt: Schema.Number,
});
export type InboxMessage = Schema.Schema.Type<typeof InboxMessage>;

/**
 * What `mailbox.allocate` returns: the address to hand the auth provider, plus
 * the read token + expiry the container-side path needs (`GET /v1/mailbox/...`).
 * The in-Workflow path (`waitForOtp`) ignores `token` — it gets the message by
 * `waitForEvent` signal, not by HTTP.
 */
export const InboxAddress = Schema.Struct({
  /** Full address — what you type into the signup/login form. */
  address: Schema.String,
  /** The `demo-<rand>` local-part (the allocations-table key). */
  localPart: Schema.String,
  /** Capability token scoped to `localPart`+`expiresAtS` for the read route. */
  token: Schema.String,
  /** Row + token expiry, epoch SECONDS. */
  expiresAtS: Schema.Number,
});
export type InboxAddress = Schema.Schema.Type<typeof InboxAddress>;

/** The code / link a verification message yielded. Both optional: a numeric
 * OTP, a magic link, or (rarely) both. */
export type OtpExtraction = {
  readonly code?: string;
  readonly link?: string;
};

/**
 * Build a full disposable address from a minted local-part and the configured
 * inbox target. Two forms, decided by whether the target carries an `@`:
 *
 *   - **Sub-addressing** (`base@domain`, e.g. `flare-dispatch-inbox@example.com`):
 *     returns `base+<localPart>@domain`. ONE Email Routing custom rule for
 *     `base@domain` → the Worker then matches every `base+…@domain` (Cloudflare
 *     supports RFC 5233 sub-addressing), so the zone's existing catch-all stays
 *     untouched — no disruption to other mail. This is the form used on a shared
 *     zone like `example.com`.
 *   - **Catch-all** (bare `domain`): returns `<localPart>@domain`, for a
 *     dedicated zone/subdomain whose whole catch-all routes to the Worker.
 */
export const buildInboxAddress = (localPart: string, inboxDomain: string): string => {
  const target = inboxDomain.replace(/^@/, "");
  const at = target.indexOf("@");
  if (at !== -1) {
    const base = target.slice(0, at);
    const domain = target.slice(at + 1);
    return `${base}+${localPart}@${domain}`;
  }
  return `${localPart}@${target}`;
};

/** Mint a local-part from a random token (e.g. a dash-stripped `io.uuid`).
 * Lowercases and strips non-alphanumerics so the result always satisfies
 * `INBOX_LOCAL_PART_RE`. */
export const mintLocalPart = (random: string): string => {
  const cleaned = random.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Pad/clamp into the [16,40] window the regex requires.
  const body = (cleaned + cleaned).slice(0, 32);
  return `${INBOX_LOCAL_PREFIX}-${body}`;
};

/** True iff `localPart` is a syntactically-valid minted inbox local-part. */
export const isInboxLocalPart = (localPart: string): boolean => INBOX_LOCAL_PART_RE.test(localPart);

/**
 * Extract + validate the minted local-part from an *envelope* recipient
 * address (`message.to`). Takes the part before the first `@`; under
 * sub-addressing the minted local-part is the `+tag` AFTER the base address
 * (`flare-dispatch-inbox+demo-xxx@… → demo-xxx`), so the segment after the last
 * `+` is taken — a bare `demo-xxx@…` (catch-all form) has no `+`, so it is
 * returned unchanged. Returns the local-part only if it matches
 * `INBOX_LOCAL_PART_RE`; otherwise `null` — the `email()` handler `setReject`s
 * on `null` before reading the body. Never parse the `To:` header for this (it
 * is forgeable / multi-valued) — only the envelope RCPT.
 */
export const parseInboxLocalPart = (recipient: string): string | null => {
  const at = recipient.indexOf("@");
  let local = (at === -1 ? recipient : recipient.slice(0, at)).trim().toLowerCase();
  const plus = local.lastIndexOf("+");
  if (plus !== -1) local = local.slice(plus + 1);
  return isInboxLocalPart(local) ? local : null;
};
