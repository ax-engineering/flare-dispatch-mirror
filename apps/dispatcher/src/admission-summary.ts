// FlareDispatch Dispatcher — admission-queue presentation (issue #109).
//
// While a run waits for a global admission slot, the check-run stays
// `in_progress` and its summary carries the queue position so a PR author
// sees back-pressure, not silence. This module holds ONLY the pure line
// formatting — kept out of workflow.ts (which imports `cloudflare:workers`
// and so cannot load under plain Node + Vitest), mirroring
// failure-summary.ts.

/**
 * A waiter's place in line, coarsened. Place 1 is next in line (no live
 * queued run ahead). The check-run shows the bucket, so a waiter writes only
 * when its bucket changes.
 */
export type PositionBucket = "1" | "2-5" | "6-20" | "over 20";

/** The bucket for a waiter with `ahead` live queued runs ahead of it. */
export const positionBucket = (ahead: number): PositionBucket => {
  const place = Math.max(0, ahead) + 1;
  return place === 1 ? "1" : place <= 5 ? "2-5" : place <= 20 ? "6-20" : "over 20";
};

/** The shortest gap between two queue-position writes of one waiter. */
export const POSITION_UPDATE_EVERY_MS = 60_000;

/** The last queue position a waiter wrote to its check-run. */
export type PositionReport = { readonly bucket: PositionBucket; readonly at: number };

/**
 * The position write a waiter makes at `now`, or `undefined` for none: a write
 * happens when the bucket differs from the last one written and at least
 * `POSITION_UPDATE_EVERY_MS` has passed since that write. A bucket crossed
 * inside the minute is written on the first poll after it.
 */
export const nextPositionReport = (
  last: PositionReport | undefined,
  ahead: number,
  now: number,
): PositionReport | undefined => {
  const bucket = positionBucket(ahead);
  if (last !== undefined && (last.bucket === bucket || now - last.at < POSITION_UPDATE_EVERY_MS)) {
    return undefined;
  }
  return { bucket, at: now };
};

/**
 * The "queued" line the admission gate posts to the in-progress check-run —
 * only when the position bucket changes, to bound GitHub API writes.
 *
 * @param bucket     the waiter's place in line, coarsened (`positionBucket`).
 * @param poolBusy   admission slots in use in the run's pool.
 * @param cap        the pool's slot cap (`ADMISSION_CAP`).
 * @param timesOutAt ms-epoch the dispatch-age ceiling lapses (enqueue + max age).
 */
export const queuedSummary = (
  bucket: PositionBucket,
  poolBusy: number,
  cap: number,
  timesOutAt: number,
): string => {
  const d = new Date(timesOutAt);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const place =
    bucket === "1" ? "next in line" : bucket === "over 20" ? "over 20th in line" : `${bucket.replace("-", "–")} in line`;
  return (
    `Queued — waiting for a sandbox slot, ${place} ` +
    `(${poolBusy}/${cap} in use); ` +
    `times out ${hh}:${mm} UTC`
  );
};

/**
 * The line a serialized run posts while it waits behind an in-flight peer of
 * its group — once per holder. Says the one thing a reader needs to not be
 * surprised later: a newer dispatch replaces this one while it waits.
 *
 * @param holderRevision revision the in-flight execution is running, when known.
 */
export const serialQueuedSummary = (holderRevision: string | undefined): string =>
  `Queued — waiting for the in-flight run ` +
  `${holderRevision !== undefined && holderRevision !== "" ? `of \`${holderRevision.slice(0, 12)}\` ` : ""}` +
  `to finish; runs of this group never overlap. A newer dispatch replaces this ` +
  `one while it waits.`;
