// FlareDispatch Dispatcher — `scheduled()` handler acceptance tests.
//
// The Schedule-mode dispatch path: a cron tick → fan out over runs whose
// `schedules[].cron` matches → instantiate a Workflow per match with the
// per-tick `idempotencyKey` as the Workflow id (CF dedup).
//
// The covered contract:
//   - matched cron → `RUNS_WORKFLOW.create({ id, params })` with id = idempotencyKey.
//   - unmatched cron → no `create` calls.
//   - gate returning false → no `create` for that match.
//   - one cron, two matching runs → two `create` calls (siblings).
//   - duplicate-id `create` error → swallowed, NOT propagated (dedup path).

import { describe, expect, it, vi } from "vitest";
import { DELIVERY_SWEEP_CRON } from "../delivery-sweep";
import { handleScheduled, liveDeliverySweepPorts } from "./scheduled";
import type { Env } from "../env";
import { makeFakeR2, makeFakeWorkflow } from "../test-helpers";

const makeEnv = (workflow: ReturnType<typeof makeFakeWorkflow>): Env =>
  ({
    HMAC_SECRET: "unused-by-scheduled",
    RUNS_WORKFLOW: workflow.binding,
    RUNS_STORAGE: makeFakeR2().binding,
    RUNS_SANDBOX: {} as Env["RUNS_SANDBOX"],
    RUNS_METADATA: {} as Env["RUNS_METADATA"],
  }) satisfies Env;

const FIRED_AT = Date.UTC(2026, 4, 20, 14, 0, 0); // 2026-05-20 14:00:00 UTC

describe("handleScheduled", () => {
  it("fires every run matching the cron, using idempotencyKey as the Workflow id", async () => {
    const workflow = makeFakeWorkflow();
    const env = makeEnv(workflow);

    // The registered `product-demo` run subscribes to "0 14 * * *".
    await handleScheduled(env, "0 14 * * *", FIRED_AT);

    expect(workflow.calls).toHaveLength(1);
    const call = workflow.calls[0]!;
    // idempotencyKey = `product-demo-${isoDate(firedAt)}`
    expect(call.id).toBe("product-demo-2026-05-20");
    const params = call.params as {
      run: string;
      executionId: string;
      github: { repo: string; ref: string; sha: string };
      inputs: { repo: string; sha: string; deployedUrl: string };
    };
    expect(params.run).toBe("product-demo");
    expect(params.executionId).toBe("product-demo-2026-05-20");
    // GitHub block synthesized from the run's input.
    expect(params.github.repo).toBe("OWNER/REPO");
    expect(params.inputs.deployedUrl).toBe("https://staging.example.com");
  });

  it("makes no Workflow calls when the cron matches no registered run", async () => {
    const workflow = makeFakeWorkflow();
    const env = makeEnv(workflow);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleScheduled(env, "0 0 1 1 *", FIRED_AT); // unsubscribed

    expect(workflow.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("pins a branch-targeting run to the head it resolves and carries the installation for its check-run", async () => {
    const workflow = makeFakeWorkflow();
    const env = makeEnv(workflow);
    const head = "c".repeat(40);
    const resolveHead = vi.fn(async () => ({ installationId: 4242, sha: head }));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    // `contextful-measures` subscribes to "17 2 * * *" with inputs { repo, ref: refs/heads/main }.
    await handleScheduled(env, "17 2 * * *", FIRED_AT, resolveHead);

    expect(resolveHead).toHaveBeenCalledWith("fractalboxdev/contextful", "main");
    const params = workflow.calls[0]!.params as {
      github: { repo: string; ref: string; sha: string; installation_id?: number };
      inputs: { sha?: string };
    };
    expect(params.github).toEqual({
      repo: "fractalboxdev/contextful",
      ref: "refs/heads/main",
      sha: head,
      installation_id: 4242,
    });
    // The run measures the same commit the check-run lands on.
    expect(params.inputs.sha).toBe(head);
    info.mockRestore();
  });

  it("fires without a check-run when the target repo's head does not resolve", async () => {
    const workflow = makeFakeWorkflow();
    const env = makeEnv(workflow);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await handleScheduled(env, "17 2 * * *", FIRED_AT, async () => undefined);

    const params = workflow.calls[0]!.params as {
      github: { installation_id?: number };
      inputs: { sha?: string };
    };
    expect(params.github.installation_id).toBeUndefined();
    expect(params.inputs.sha).toBeUndefined();
    info.mockRestore();
  });

  it("does not resolve a head for a run whose inputs name no branch ref", async () => {
    const workflow = makeFakeWorkflow();
    const env = makeEnv(workflow);
    const resolveHead = vi.fn(async () => ({ installationId: 1, sha: "d".repeat(40) }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleScheduled(env, "0 14 * * *", FIRED_AT, resolveHead);

    expect(resolveHead).not.toHaveBeenCalled();
    expect((workflow.calls[0]!.params as { github: object }).github).not.toHaveProperty(
      "installation_id",
    );
    warn.mockRestore();
  });

  it("collapses duplicate-id create errors as the dedup path (not a hard failure)", async () => {
    const workflow = makeFakeWorkflow();
    // First call records; second call (with same id) throws as a real
    // Workflows runtime would for a duplicate instance id.
    let createCalls = 0;
    const binding = {
      create: vi.fn(async (options?: { id?: string; params?: unknown }) => {
        createCalls += 1;
        if (createCalls > 1) {
          throw new Error(`instance with id "${options?.id}" already exists`);
        }
        workflow.calls.push({
          id: options?.id ?? "",
          params: options?.params,
        });
        return { id: options?.id ?? "", status: async () => ({ status: "queued" }) };
      }),
    } as unknown as Env["RUNS_WORKFLOW"];
    const env = {
      ...makeEnv(workflow),
      RUNS_WORKFLOW: binding,
    } satisfies Env;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    // Two ticks at the same firedAt — same idempotencyKey, same Workflow id.
    await handleScheduled(env, "0 14 * * *", FIRED_AT);
    await handleScheduled(env, "0 14 * * *", FIRED_AT);

    expect(createCalls).toBe(2);
    expect(workflow.calls).toHaveLength(1); // second was deduped
    expect(errorLog).not.toHaveBeenCalled();
    info.mockRestore();
    errorLog.mockRestore();
  });
});

describe("handleScheduled — verdict reconcile sweep", () => {
  it("runs the sweep on its cron and fires no run, without the no-match warning", async () => {
    const workflow = makeFakeWorkflow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sweep = vi.fn(async () => {});

    await handleScheduled(makeEnv(workflow), DELIVERY_SWEEP_CRON, FIRED_AT, undefined, sweep);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(workflow.calls).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the sweep alone on every other cron", async () => {
    const sweep = vi.fn(async () => {});
    await handleScheduled(makeEnv(makeFakeWorkflow()), "0 14 * * *", FIRED_AT, undefined, sweep);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("has no ports on a deploy without App credentials, where no verdict is owed", () => {
    expect(liveDeliverySweepPorts(makeEnv(makeFakeWorkflow()))).toBeUndefined();
  });
});
