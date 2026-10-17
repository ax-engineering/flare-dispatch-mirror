import { Effect, Schema } from "effect";
import {
  AcceptanceFailed,
  artifact,
  defineRun,
  github,
  sandbox,
  StepFailed,
  step,
} from "@fractalboxdev/flare-dispatch-core";
import { workspace } from "@fractalboxdev/flare-dispatch-core/primitives";

const REPO = "fractalboxdev/contextful";
const REF = "refs/heads/main";
const TOOLCHAIN_COMMAND =
  "cargo run --locked -q -p contextful-ci -- gate --predecessors --stage toolchain";
const PINNED_ENVIRONMENT =
  'export PATH="${ELAN_HOME:-$HOME/.elan}/bin:$PATH"; export ELAN_TOOLCHAIN="$(cat formal/lean-toolchain)"; export CONTEXTFUL_REQUIRE_LEAN=1; ';
const FORMAL_COMMAND = `${PINNED_ENVIRONMENT}cargo run --locked -q -p contextful-cli --no-default-features --bin contextful -- formal check`;
const SEED_COMMAND = `node -e 'console.log(require("node:crypto").randomBytes(8).readBigUInt64LE().toString())'`;
const REGRESSIONS = "formal/protocol/regressions.jsonl";
const COMMAND_TIMEOUT_SEC = 1800;
const Input = Schema.Struct({
  repo: Schema.String,
  ref: Schema.String,
  firedAt: Schema.Number,
  /** The head the scheduled tick pinned; its check-run lands on this commit. */
  sha: Schema.optional(Schema.String),
});
const Output = Schema.Struct({ commit: Schema.String, seed: Schema.String, logUrl: Schema.String });

/** The gate installs elan; the separate command restores its pinned executable environment. */
export const protocolCommand = (seed: string): string =>
  `${PINNED_ENVIRONMENT}cargo run --locked -q -p contextful-cli --no-default-features --bin contextful -- formal protocol-differential --seed ${seed} --cases 256`;

export const contextfulProtocol = defineRun({
  name: "contextful-protocol",
  version: "1.0.0",
  schedules: [
    {
      cron: "17 3 * * SUN",
      idempotencyKey: ({ firedAt }) => `contextful-protocol:${firedAt}`,
      inputs: ({ firedAt }): typeof Input.Type => ({ repo: REPO, ref: REF, firedAt }),
    },
  ],
  inputs: Input,
  outputs: Output,
  limits: { maxDurationSec: 7200, admissionMaxQueueAgeSec: 21600 },
  run: (input) =>
    Effect.gen(function* () {
      if (input.repo !== REPO || input.ref !== REF) {
        return yield* Effect.fail(
          new StepFailed({
            step: "scope",
            cause: "protocol exploration targets the Contextful default branch",
          }),
        );
      }
      const commit =
        input.sha ??
        (yield* step("resolve-head", () => github.branchHead({ repo: REPO, branch: "main" })));
      const ws = yield* step("checkout", () => workspace({ repo: REPO, sha: commit }));
      const provisioned = yield* step(
        "toolchain",
        () =>
          sandbox.exec({
            container: ws.container,
            cwd: ws.dir,
            command: TOOLCHAIN_COMMAND,
            timeoutSec: COMMAND_TIMEOUT_SEC,
          }),
        { timeoutSec: COMMAND_TIMEOUT_SEC + 120, retries: 0 },
      );
      const toolchainLog = yield* step("toolchain-log", () =>
        artifact.upload({
          name: "protocol-toolchain.log",
          path: provisioned.logPath,
          signedUrlTTL: "30 days",
        }),
      );
      if (provisioned.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: provisioned.exitCode,
            summaryMd: `The pinned toolchain fails on ${commit}. [Log](${toolchainLog})`,
          }),
        );
      }
      const formal = yield* step(
        "formal-gate",
        () =>
          sandbox.exec({
            container: ws.container,
            cwd: ws.dir,
            command: FORMAL_COMMAND,
            timeoutSec: COMMAND_TIMEOUT_SEC,
          }),
        { timeoutSec: COMMAND_TIMEOUT_SEC + 120, retries: 0 },
      );
      const formalLog = yield* step("formal-log", () =>
        artifact.upload({
          name: "protocol-formal.log",
          path: formal.logPath,
          signedUrlTTL: "30 days",
        }),
      );
      if (formal.exitCode !== 0) {
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: formal.exitCode,
            summaryMd: `The pinned formal gate fails on ${commit}. [Log](${formalLog})`,
          }),
        );
      }
      const generated = yield* step("fresh-seed", () =>
        sandbox.exec({
          container: ws.container,
          cwd: ws.dir,
          command: SEED_COMMAND,
          timeoutSec: 60,
        }),
      );
      const seed = generated.stdout.trim();
      if (
        generated.exitCode !== 0 ||
        !/^(0|[1-9][0-9]{0,19})$/.test(seed) ||
        BigInt(seed) > 18446744073709551615n
      ) {
        return yield* Effect.fail(
          new StepFailed({
            step: "fresh-seed",
            cause: "seed generation returns no unsigned 64-bit integer",
          }),
        );
      }
      const compared = yield* step(
        "protocol-exploration",
        () =>
          sandbox.exec({
            container: ws.container,
            cwd: ws.dir,
            command: protocolCommand(seed),
            timeoutSec: COMMAND_TIMEOUT_SEC,
          }),
        { timeoutSec: COMMAND_TIMEOUT_SEC + 120, retries: 0 },
      );
      const logUrl = yield* step("protocol-log", () =>
        artifact.upload({
          name: "protocol-exploration.log",
          path: compared.logPath,
          signedUrlTTL: "30 days",
        }),
      );
      if (compared.exitCode !== 0) {
        const saved = yield* step("saved-regressions", () =>
          sandbox
            .readFile({ container: ws.container, path: `${ws.dir}/${REGRESSIONS}` })
            .pipe(Effect.catchTag("ReadFileFailed", () => Effect.succeed(undefined))),
        );
        const regressionsUrl =
          saved === undefined
            ? undefined
            : yield* step("regressions-artifact", () =>
                artifact.upload({
                  name: "protocol-regressions.jsonl",
                  path: `${ws.dir}/${REGRESSIONS}`,
                  container: ws.container,
                  contentType: "application/x-ndjson",
                  signedUrlTTL: "30 days",
                }),
              );
        return yield* Effect.fail(
          new AcceptanceFailed({
            exitCode: compared.exitCode,
            summaryMd: `Protocol exploration fails on ${commit} with seed ${seed}. [Log](${logUrl})${regressionsUrl === undefined ? "" : ` [Regressions](${regressionsUrl})`}`,
          }),
        );
      }
      return { commit, seed, logUrl };
    }),
});
