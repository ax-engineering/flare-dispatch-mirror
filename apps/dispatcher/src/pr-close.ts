// Closing a pull request ends every run superseding within it.
//
// A run that declares `supersede` keeps one live member per group, and only a
// newer member cancels an older one. A pull request that closes — merged or
// not — has no newer revision coming, so its live members would otherwise run
// to their ceiling. A `pull_request` `closed` delivery therefore resolves, for
// every run whose `pull_request` trigger admits the payload and that declares
// `supersede`, the group that trigger's inputs would join, and starts one
// RunWorkflow instance per group carrying a `closeGroup` payload.
//
// That instance registers a close marker in the group, ranked one millisecond
// after the close (`SupersedeSpec.order` of the closed payload's inputs — the
// PR's `updated_at`, which GitHub reports to the second). A landing's push and
// its merge can share that second; the extra millisecond ranks the marker above
// the push's gate whichever registers first. Registration supersedes every
// lower-ranked member, and each
// superseded tree is cancelled in its own checkpoint (supersede.ts): instances
// terminated, admission rows released, check-runs concluded `cancelled`. The
// marker stays live in the group, so a gate for the closed head that registers
// after the close ranks below it and stands itself down; a reopen in a later
// second ranks above it and supersedes the marker.

import { Effect, Schema } from "effect";
import type { RunSupersedeStore } from "@fractalboxdev/flare-dispatch-runtime-cf";
import { toInstanceId } from "./instance-id";
import type { TriggerMatch } from "./registry";

/** A close marker ranks this far above the close's `updated_at`. */
export const CLOSE_RANK_OFFSET_MS = 1;

/** Every close marker's execution id starts with this. */
export const CLOSE_MARKER_PREFIX = "pr-closed:";

/** The close marker's id — one per close, so a reopen and a second close each rank on their own. */
export const closeMarkerId = (group: string, rank: number): string =>
  `${CLOSE_MARKER_PREFIX}${rank}:${group}`;

export const isCloseMarker = (executionId: string): boolean =>
  executionId.startsWith(CLOSE_MARKER_PREFIX);

/** The RunWorkflow payload that cancels one group on a pull request's close. */
export const CloseGroupPayload = Schema.Struct({
  closeGroup: Schema.Struct({
    group: Schema.String,
    rank: Schema.Number,
    repo: Schema.String,
    installation_id: Schema.optional(Schema.Number),
  }),
});
export type CloseGroupPayload = Schema.Schema.Type<typeof CloseGroupPayload>;

export const isCloseGroupPayload = Schema.is(CloseGroupPayload);

/** The instance id of the close for `group` at `rank` — a redelivery collapses onto it. */
export const closeInstanceId = (group: string, rank: number): string =>
  toInstanceId(`close:${group}:${rank}`);

/**
 * The supersession groups a `pull_request` `closed` delivery ends, deduplicated.
 * A trigger's `actions` filter does not apply: it names the actions that start
 * a run, and a close starts none.
 */
export const closedGroups = (
  event: string,
  payload: Record<string, unknown>,
  matches: readonly TriggerMatch[],
  now: number,
): readonly { readonly group: string; readonly rank: number }[] => {
  if (event !== "pull_request" || (payload as { action?: unknown }).action !== "closed") return [];
  const ctx = { payload };
  const groups = new Map<string, number>();
  for (const { run, trigger } of matches) {
    if (run.supersede === undefined) continue;
    if (trigger.gate !== undefined && !trigger.gate(ctx)) continue;
    const spec = run.supersede(trigger.inputs(ctx));
    if (spec === undefined) continue;
    groups.set(spec.group, (spec.order ?? now) + CLOSE_RANK_OFFSET_MS);
  }
  return [...groups].map(([group, rank]) => ({ group, rank }));
};

export type CloseGroupPorts = {
  /** A durable checkpoint (RunWorkflow's `step.do`). */
  readonly stepDo: <T>(name: string, body: () => Promise<T>) => Effect.Effect<T>;
  readonly store: Pick<RunSupersedeStore, "register">;
  /** Cancel one superseded tree on the close marker's behalf (`cancelSupersededTree`). */
  readonly cancelTree: (rootId: string, markerId: string) => Effect.Effect<unknown, Error>;
};

/**
 * Register the close marker and cancel every member it supersedes, one
 * checkpoint per tree. Resolves to the ids it cancelled; a marker that a
 * higher-ranked member (a reopen) already outranks cancels nothing.
 */
export const closeGroup = (
  args: { readonly group: string; readonly rank: number },
  ports: CloseGroupPorts,
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const markerId = closeMarkerId(args.group, args.rank);
    const registration = yield* ports.stepDo("close-register", () =>
      Effect.runPromise(
        ports.store.register(markerId, args.group, { supersedeOlder: true, rank: args.rank }),
      ).then((r) => ({ superseded: [...r.superseded], supersededBy: r.supersededBy ?? null })),
    );
    if (registration.supersededBy !== null) return [];
    for (const [index, id] of registration.superseded.entries()) {
      yield* ports.stepDo(`close-cancel-${index}`, () =>
        Effect.runPromise(ports.cancelTree(id, markerId)).then(() => true),
      );
    }
    return registration.superseded;
  });
