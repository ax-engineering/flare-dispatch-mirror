// Primitive: workspace — acquire a container and clone a repo into it
//
// The opening move of nearly every recipe: get a container, clone the repo at
// the target SHA, and (optionally) run a cached dependency install. Returns
// the container handle and the checkout directory together, so the rest of
// the run threads one value instead of two.
//
// Rides on the `sandbox` capability and the `installCached` primitive.
// Layer: 03-dsl § Primitives.

import { Effect } from "effect";
import { io } from "../services/io";
import { sandbox, type Container } from "../services/sandbox";
import { installCached } from "./install-cached";

export type Workspace = {
  container: Container;
  dir: string;
};

export const workspace = (opts: {
  repo: string;
  sha: string;
  image?: string; // container image override
  install?: boolean; // run installCached after the clone
  /** Env for the install command (see `installCached`); ignored without `install`. */
  installEnv?: Record<string, string>;
  /** Values to scrub from the install exec's log (see `installCached`). */
  redactValues?: readonly string[];
  /**
   * Put this workspace in a container of its own, named by this key.
   *
   * Omitted, the checkout lands in the execution's single container, which is
   * what one workspace per run wants. Named, it lands in a second container —
   * the difference between two workspaces and two names for one, since
   * `git clone` clears its target directory and a shared container means the
   * second checkout deletes the first.
   *
   * The container is the caller's to `destroy`; see `sandbox.acquire`.
   */
  key?: string;
}) =>
  Effect.gen(function* () {
    const container = yield* sandbox.acquire({
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      ...(opts.key !== undefined ? { key: opts.key } : {}),
    });
    const dir = yield* sandbox.git.clone({
      repo: opts.repo,
      sha: opts.sha,
      container,
    });
    if (opts.install) {
      yield* installCached({
        container,
        dir,
        ...(opts.installEnv !== undefined ? { env: opts.installEnv } : {}),
        ...(opts.redactValues !== undefined ? { redactValues: opts.redactValues } : {}),
      });
    }
    return { container, dir };
  });

/**
 * The same workspace, after checking it is still there — rebuilt if it is not.
 *
 * A checkout does not survive across durable steps by right. Container disk is
 * ephemeral, and the runtime says so in its own words when it bites: an exec
 * whose working directory is missing raises `working directory '<dir>' was
 * missing at exec time — the checkout did not survive to this step (container
 * recycled)`.
 *
 * That arrives as `ExecFailed`, which is exactly the class a platform-retry
 * policy retries — so a run with `retryOn: ["ExecFailed"]` re-ran the same
 * command in the same missing directory, three times, and reported a failure
 * about a missing directory rather than anything about the code. A retry whose
 * precondition the failure destroyed is not a retry.
 *
 * Call this INSIDE the retryable step, not before it. That placement is the
 * whole point: the rebuild has to be part of what a retry re-runs. That step's
 * `retryOn` must list `CheckoutFailed` too, or a clone that flakes mid-rebuild
 * ends the step one call short of the repair.
 *
 * Costs one `test -d` on the happy path. On a recycled container it is a clone
 * and an install — which is what the step was about to need anyway.
 */
export const ensureWorkspace = (opts: {
  current: Workspace;
  repo: string;
  sha: string;
  image?: string;
  install?: boolean;
  installEnv?: Record<string, string>;
  redactValues?: readonly string[];
  key?: string;
}) =>
  Effect.gen(function* () {
    const probe = yield* sandbox.exec({
      container: opts.current.container,
      command: ["test", "-d", `${opts.current.dir}/.git`],
      timeoutSec: 30,
    });
    if (probe.exitCode === 0) return opts.current;
    yield* io.log(
      "warn",
      `ensureWorkspace: the checkout at ${opts.current.dir} is gone — the container was recycled between steps. Re-cloning before the command runs.`,
    );
    return yield* workspace({
      repo: opts.repo,
      sha: opts.sha,
      ...(opts.image !== undefined ? { image: opts.image } : {}),
      ...(opts.install !== undefined ? { install: opts.install } : {}),
      ...(opts.installEnv !== undefined ? { installEnv: opts.installEnv } : {}),
      ...(opts.redactValues !== undefined ? { redactValues: opts.redactValues } : {}),
      // A keyed workspace rebuilds in its own container, never the execution's.
      ...(opts.key !== undefined ? { key: opts.key } : {}),
    });
  });
