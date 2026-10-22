import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOptIn } from "./opt-in";
import { makeFakeKv } from "./test-helpers";

const KEYS = ["check.command:acme/widgets:docs", "check.command:acme/widgets"] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveOptIn", () => {
  it("answers not-configured when no key is present", async () => {
    const kv = makeFakeKv();
    expect(await resolveOptIn({ configKv: kv.binding, runName: "check", keys: () => KEYS })).toBe(
      "not-configured",
    );
  });

  it("dispatches when any one key is present, the least specific included", async () => {
    const kv = makeFakeKv();
    kv.store.set("check.command:acme/widgets", "pnpm lint");
    expect(await resolveOptIn({ configKv: kv.binding, runName: "check", keys: () => KEYS })).toBe(
      "dispatch",
    );
  });

  it("treats a present key as opted in whatever its value — the run body judges the value", async () => {
    const kv = makeFakeKv();
    kv.store.set("check.command:acme/widgets", "");
    expect(await resolveOptIn({ configKv: kv.binding, runName: "check", keys: () => KEYS })).toBe(
      "dispatch",
    );
  });

  it("dispatches without a read when the inputs carry the command", async () => {
    const get = vi.fn();
    const configKv = { get } as unknown as KVNamespace;
    expect(await resolveOptIn({ configKv, runName: "check", keys: () => [] })).toBe("dispatch");
    expect(get).not.toHaveBeenCalled();
  });

  it("dispatches without computing keys on a deploy with no CONFIG_KV", async () => {
    const keys = vi.fn(() => KEYS);
    expect(await resolveOptIn({ configKv: undefined, runName: "check", keys })).toBe("dispatch");
    expect(keys).not.toHaveBeenCalled();
  });

  it("fails open on a rejected read and logs the run and keys", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const configKv = {
      get: async () => {
        throw new Error("kv unavailable");
      },
    } as unknown as KVNamespace;
    expect(await resolveOptIn({ configKv, runName: "check", keys: () => KEYS })).toBe("dispatch");
    expect(String(error.mock.calls[0]?.[0])).toContain('run="check"');
    expect(String(error.mock.calls[0]?.[0])).toContain("kv unavailable");
  });

  it("fails open when the run's optIn throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const kv = makeFakeKv();
    const verdict = await resolveOptIn({
      configKv: kv.binding,
      runName: "check",
      keys: () => {
        throw new Error("input has no repo");
      },
    });
    expect(verdict).toBe("dispatch");
    expect(String(error.mock.calls[0]?.[0])).toContain("input has no repo");
  });
});
