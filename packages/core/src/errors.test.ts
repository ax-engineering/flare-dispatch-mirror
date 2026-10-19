// Tests for the tagged run errors — exhaustive `Match` over every `RunError`
// variant. The acceptance criterion (specs/pm/plan.md § PR2) is that this
// `Match.exhaustive` *compiles*: adding a `RunError` variant without a branch
// here is a type error.

import { Match } from "effect";
import { describe, expect, it } from "vitest";
import {
  AcceptanceFailed,
  AdmissionTimedOut,
  SerialQueueTimedOut,
  ApprovalTimedOut,
  ArtifactUploadFailed,
  BrowserUnavailable,
  CacheError,
  CheckoutFailed,
  CloudflareApiError,
  ContainerBusy,
  ContainerLaunchFailed,
  EventPayloadInvalid,
  ExecFailed,
  ExecTimeout,
  ExposePortFailed,
  ChildSpawnFailed,
  ChildWaitTimeout,
  GitHubApiError,
  OidcSigningFailed,
  PortNeverOpened,
  type RunError,
  RunDurationExceeded,
  RunSkipped,
  SandboxProcessLost,
  SecretsMissing,
  StepFailed,
  StsAssumeRoleFailed,
} from "./errors";

/**
 * Summarise any `RunError`. `Match.exhaustive` makes a missing branch a
 * compile error — this function is the live exhaustiveness check.
 */
const summarize = (e: RunError): string =>
  Match.value(e).pipe(
    // `Match.tags` (object form) collapses every branch into ONE pipe argument —
    // the many-`Match.tag` form pushed `pipe` past its 20-arg typed overload
    // once the union grew past ~18 members. Same exhaustiveness guarantee.
    Match.tags({
      CheckoutFailed: ({ repo, sha }) => `checkout ${repo}@${sha}`,
      ExecFailed: ({ exitCode }) => `exec exited ${exitCode}`,
      ExecTimeout: ({ timeoutSec }) => `exec timeout ${timeoutSec}s`,
      AcceptanceFailed: ({ exitCode }) => `acceptance exited ${exitCode}`,
      ContainerLaunchFailed: ({ image }) => `launch ${image}`,
      ContainerBusy: ({ containerId }) => `container busy ${containerId}`,
      AdmissionTimedOut: ({ position }) => `admission ${position} ahead`,
      SerialQueueTimedOut: ({ group }) => `serial ${group}`,
      PortNeverOpened: ({ port }) => `port ${port} never opened`,
      ExposePortFailed: ({ port }) => `expose port ${port} failed`,
      BrowserUnavailable: ({ reason }) => `browser ${reason}`,
      CacheError: ({ phase, key }) => `cache ${phase} ${key}`,
      ArtifactUploadFailed: ({ name }) => `artifact ${name}`,
      StepFailed: ({ step }) => `step ${step}`,
      RunSkipped: ({ reason }) => `skipped ${reason}`,
      ApprovalTimedOut: ({ eventName }) => `approval ${eventName}`,
      EventPayloadInvalid: ({ reason }) => `event payload ${reason}`,
      SecretsMissing: ({ keys }) => `secrets missing ${keys.join(",")}`,
      GitHubApiError: ({ status, reason }) => `github ${status} ${reason}`,
      CloudflareApiError: ({ status, reason }) => `cloudflare ${status} ${reason}`,
      OidcSigningFailed: ({ reason }) => `oidc ${reason}`,
      StsAssumeRoleFailed: ({ provider, reason }) => `sts ${provider} ${reason}`,
      ChildSpawnFailed: ({ run, instanceId }) => `child spawn ${run} ${instanceId}`,
      ChildWaitTimeout: ({ pending }) => `child wait ${pending.length} pending`,
      RunDurationExceeded: ({ maxDurationSec }) => `ceiling ${maxDurationSec}s`,
      SandboxProcessLost: ({ launches }) => `process lost ${launches}x`,
    }),
    Match.exhaustive,
  );

const samples: ReadonlyArray<{ name: string; err: RunError; expect: string }> = [
  {
    name: "CheckoutFailed",
    err: new CheckoutFailed({ repo: "o/n", sha: "abc", cause: "x" }),
    expect: "checkout o/n@abc",
  },
  {
    name: "ExecFailed",
    err: new ExecFailed({ exitCode: 7, stderrTail: "" }),
    expect: "exec exited 7",
  },
  {
    name: "ExecTimeout",
    err: new ExecTimeout({ timeoutSec: 60, command: "pnpm test" }),
    expect: "exec timeout 60s",
  },
  {
    name: "AcceptanceFailed",
    err: new AcceptanceFailed({ exitCode: 1 }),
    expect: "acceptance exited 1",
  },
  {
    name: "ContainerLaunchFailed",
    err: new ContainerLaunchFailed({ image: "node:lts", cause: "x" }),
    expect: "launch node:lts",
  },
  {
    name: "ContainerBusy",
    err: new ContainerBusy({
      containerId: "demo-acme-repo-abc123",
      holder: "product-demo:acme_repo:abc123",
      waitedMs: 600_000,
    }),
    expect: "container busy demo-acme-repo-abc123",
  },
  {
    name: "AdmissionTimedOut",
    err: new AdmissionTimedOut({
      queuedForMs: 1_200_000,
      position: 3,
      poolBusy: 16,
    }),
    expect: "admission 3 ahead",
  },
  {
    name: "SerialQueueTimedOut",
    err: new SerialQueueTimedOut({
      group: "worker-deploy:o/n@main",
      holderRevision: "abc",
      waitedMs: 3_600_000,
    }),
    expect: "serial worker-deploy:o/n@main",
  },
  {
    name: "PortNeverOpened",
    err: new PortNeverOpened({ port: 3000, timeoutSec: 120 }),
    expect: "port 3000 never opened",
  },
  {
    name: "ExposePortFailed",
    err: new ExposePortFailed({ port: 4173, cause: "x" }),
    expect: "expose port 4173 failed",
  },
  {
    name: "BrowserUnavailable",
    err: new BrowserUnavailable({ reason: "transient" }),
    expect: "browser transient",
  },
  {
    name: "CacheError",
    err: new CacheError({ phase: "restore", key: "k", cause: "x" }),
    expect: "cache restore k",
  },
  {
    name: "ArtifactUploadFailed",
    err: new ArtifactUploadFailed({ name: "log", cause: "x" }),
    expect: "artifact log",
  },
  {
    name: "StepFailed",
    err: new StepFailed({ step: "exec", cause: "x" }),
    expect: "step exec",
  },
  {
    name: "RunSkipped",
    err: new RunSkipped({ reason: "diff exceeds the model context window" }),
    expect: "skipped diff exceeds the model context window",
  },
  {
    name: "ApprovalTimedOut",
    err: new ApprovalTimedOut({ eventName: "release", timeoutMs: 1000 }),
    expect: "approval release",
  },
  {
    name: "EventPayloadInvalid",
    err: new EventPayloadInvalid({ eventName: "release", reason: "bad" }),
    expect: "event payload bad",
  },
  {
    name: "SecretsMissing",
    err: new SecretsMissing({ keys: ["CLERK_SECRET_KEY"] }),
    expect: "secrets missing CLERK_SECRET_KEY",
  },
  {
    name: "GitHubApiError",
    err: new GitHubApiError({ status: 429, reason: "rate-limited" }),
    expect: "github 429 rate-limited",
  },
  {
    name: "CloudflareApiError",
    err: new CloudflareApiError({ status: 401, reason: "unauthorized" }),
    expect: "cloudflare 401 unauthorized",
  },
  {
    name: "OidcSigningFailed",
    err: new OidcSigningFailed({ reason: "key-load", cause: "missing JWK" }),
    expect: "oidc key-load",
  },
  {
    name: "StsAssumeRoleFailed",
    err: new StsAssumeRoleFailed({
      provider: "aws",
      status: 403,
      reason: "role-mismatch",
    }),
    expect: "sts aws role-mismatch",
  },
  {
    name: "ChildSpawnFailed",
    err: new ChildSpawnFailed({
      run: "pr-review",
      instanceId: "pr-review:o_n:42",
      cause: "rate limited",
    }),
    expect: "child spawn pr-review pr-review:o_n:42",
  },
  {
    name: "ChildWaitTimeout",
    err: new ChildWaitTimeout({
      pending: ["shard-1", "shard-3"],
      waitedMs: 1_800_000,
    }),
    expect: "child wait 2 pending",
  },
  {
    name: "RunDurationExceeded",
    err: new RunDurationExceeded({ maxDurationSec: 1800, elapsedSec: 1800 }),
    expect: "ceiling 1800s",
  },
  {
    name: "SandboxProcessLost",
    err: new SandboxProcessLost({ launches: 3 }),
    expect: "process lost 3x",
  },
];

describe("AcceptanceFailed — optional failure presentation (summaryMd)", () => {
  it("carries the run-authored markdown when provided", () => {
    const err = new AcceptanceFailed({
      exitCode: 1,
      summaryMd: "# product-demo — 0/3 chapters passed",
    });
    expect(err.summaryMd).toBe("# product-demo — 0/3 chapters passed");
  });

  it("is constructible without summaryMd (backward compatible)", () => {
    const err = new AcceptanceFailed({ exitCode: 1 });
    expect(err.summaryMd).toBeUndefined();
  });
});

describe("RunError — exhaustive Match", () => {
  for (const { name, err, expect: want } of samples) {
    it(`matches ${name}`, () => {
      expect(summarize(err)).toBe(want);
    });
  }

  it("every tagged error carries its `_tag`", () => {
    for (const { name, err } of samples) {
      expect(err._tag).toBe(name);
    }
  });

  it("tagged errors are instances of Error", () => {
    for (const { err } of samples) {
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("cause-carrying messages (#88)", () => {
  // The Workflows attempt record persists only error.name + error.message —
  // these getters are the ONLY diagnostic surface a failed upload gets.
  it("ArtifactUploadFailed.message carries the artifact name AND the cause", () => {
    const err = new ArtifactUploadFailed({
      name: "demo-bundle",
      cause: new Error("encoding 'none' requires the rpc transport"),
    });
    expect(err.message).toBe(
      `artifact "demo-bundle" upload failed: Error: encoding 'none' requires the rpc transport`,
    );
  });

  it("ArtifactUploadFailed.message stringifies non-Error causes", () => {
    const err = new ArtifactUploadFailed({ name: "log", cause: "boom" });
    expect(err.message).toBe(`artifact "log" upload failed: boom`);
  });

  it("AdmissionTimedOut.message reads as an infra-wait timeout, not a test failure", () => {
    const err = new AdmissionTimedOut({
      queuedForMs: 1_200_000,
      position: 3,
      poolBusy: 16,
    });
    expect(err.message).toBe(
      "timed out waiting for a sandbox slot after 20 min (3 run(s) ahead, 16 slot(s) busy) — the run never started",
    );
  });

  it("SerialQueueTimedOut.message names the holder and says the run never started", () => {
    const err = new SerialQueueTimedOut({
      group: "worker-deploy:o/n@main",
      holderRevision: "0123456789abcdef0123",
      waitedMs: 3_600_000,
    });
    expect(err.message).toBe(
      "timed out after 60 min queued behind 0123456789ab in worker-deploy:o/n@main — the run never started",
    );
  });

  it("CacheError.message carries phase, key, and cause", () => {
    const err = new CacheError({
      phase: "save",
      key: "pnpm-abc123",
      cause: new Error("tar czf exited 2"),
    });
    expect(err.message).toBe(`cache save "pnpm-abc123" failed: Error: tar czf exited 2`);
  });

  it("ExecFailed.message carries exit code and stderrTail for Workflows", () => {
    const err = new ExecFailed({
      exitCode: -1,
      stderrTail: "container vanished",
    });
    expect(err.message).toBe("exec failed (exit -1): container vanished");
  });

  it("ExecTimeout.message carries timeout and command for Workflows", () => {
    const err = new ExecTimeout({
      timeoutSec: 900,
      command: "pnpm build && wrangler deploy",
    });
    expect(err.message).toBe("exec timed out after 900s: pnpm build && wrangler deploy");
  });
});
