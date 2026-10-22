// Unit coverage for `resolveSandboxTransport` — the per-repo pin, else the
// Worker-wide var, else `rpc` (see sandbox-transport.ts header).

import { describe, expect, it } from "vitest";
import { parseSandboxTransport, resolveSandboxTransport } from "./sandbox-transport";

describe("resolveSandboxTransport", () => {
  it("defaults to rpc when neither the pin nor the var is set", () => {
    expect(resolveSandboxTransport({})).toBe("rpc");
    expect(resolveSandboxTransport({ repoPin: null, workerDefault: undefined })).toBe("rpc");
  });

  it("takes the Worker-wide var when no repo pin is set", () => {
    expect(resolveSandboxTransport({ workerDefault: "http" })).toBe("http");
    expect(resolveSandboxTransport({ repoPin: null, workerDefault: "websocket" })).toBe(
      "websocket",
    );
  });

  it("lets the repo pin move a repo back to http over an rpc default", () => {
    expect(resolveSandboxTransport({ repoPin: "http" })).toBe("http");
    expect(resolveSandboxTransport({ repoPin: "http", workerDefault: "rpc" })).toBe("http");
  });

  it("lets the repo pin select rpc over an http var", () => {
    expect(resolveSandboxTransport({ repoPin: "rpc", workerDefault: "http" })).toBe("rpc");
  });

  it("skips an unrecognised pin and falls through to the var", () => {
    expect(resolveSandboxTransport({ repoPin: "RPC", workerDefault: "http" })).toBe("http");
    expect(resolveSandboxTransport({ repoPin: "", workerDefault: "websocket" })).toBe("websocket");
  });

  it("skips an unrecognised var and falls through to rpc", () => {
    expect(resolveSandboxTransport({ workerDefault: "grpc" })).toBe("rpc");
    expect(resolveSandboxTransport({ repoPin: "typo", workerDefault: "typo" })).toBe("rpc");
  });
});

describe("parseSandboxTransport", () => {
  it("accepts exactly the three transport names", () => {
    expect(parseSandboxTransport("rpc")).toBe("rpc");
    expect(parseSandboxTransport("websocket")).toBe("websocket");
    expect(parseSandboxTransport("http")).toBe("http");
    expect(parseSandboxTransport(" rpc")).toBeUndefined();
    expect(parseSandboxTransport(null)).toBeUndefined();
    expect(parseSandboxTransport(undefined)).toBeUndefined();
  });
});
