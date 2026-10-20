import { describe, expect, it } from "vitest";
import { classifyGhcrFailure, pushGhcrImage } from "./ghcr-push";

describe("pushGhcrImage", () => {
  it("publishes OCI blobs and a versioned manifest without sending credentials in image bytes", async () => {
    const requests: Array<{ url: string; method: string; auth: string | null; body: Uint8Array }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const bytes = request.body === null ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
      requests.push({ url: request.url, method: request.method, auth: request.headers.get("authorization"), body: bytes });
      if (url.pathname === "/token") return Response.json({ token: "registry-bearer" });
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      if (request.method === "POST") return new Response(null, { status: 202, headers: { Location: `/v2/${"fractalboxdev/contextful/contextful-edge"}/blobs/uploads/session` } });
      if (request.method === "PUT") return new Response(null, { status: 201 });
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    await pushGhcrImage({ username: "bot", token: "test-pat", name: "fractalboxdev/contextful/contextful-edge", tag: "0.5.0",
      layer: new Uint8Array([1, 2, 3]), layerSize: 3,
      layerDigest: "a".repeat(64), diffId: "b".repeat(64), fetchImpl });
    expect(requests[0]?.auth).toBe(`Basic ${btoa("bot:test-pat")}`);
    expect(requests.filter((r) => r.method === "PUT")).toHaveLength(3);
    expect(requests.at(-1)?.url).toContain("/manifests/0.5.0");
    expect(requests.at(-1)?.auth).toBe("Bearer registry-bearer");
    expect(new TextDecoder().decode(requests.at(-1)!.body)).not.toContain("test-pat");
  });

  it("uploads every blob as application/octet-stream, which GHCR requires, and types only the manifest", async () => {
    // GHCR answers 404 to a blob PUT carrying an OCI media type as its Content-Type.
    const puts: Array<{ path: string; type: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/token") return Response.json({ token: "registry-bearer" });
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      if (request.method === "POST") return new Response(null, { status: 202, headers: { Location: "/v2/o/r/p/blobs/upload/1.session" } });
      puts.push({ path: url.pathname, type: request.headers.get("content-type") });
      const blobUpload = url.pathname.includes("/blobs/");
      return blobUpload && request.headers.get("content-type") !== "application/octet-stream"
        ? new Response(null, { status: 404 }) : new Response(null, { status: 201 });
    };
    await pushGhcrImage({ username: "bot", token: "test-pat", name: "o/r/p", tag: "0.5.0",
      layer: new Uint8Array([1, 2, 3]), layerSize: 3,
      layerDigest: "a".repeat(64), diffId: "b".repeat(64), fetchImpl });
    expect(puts.filter((put) => put.path.includes("/blobs/")).map((put) => put.type))
      .toEqual(["application/octet-stream", "application/octet-stream"]);
    expect(puts.at(-1)).toEqual({ path: "/v2/o/r/p/manifests/0.5.0", type: "application/vnd.oci.image.manifest.v1+json" });
  });

  it("keeps an existing matching image tag and refuses a conflicting tag", async () => {
    let manifestDigest: string | undefined;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${request.url}`);
      if (new URL(request.url).pathname === "/token") return Response.json({ token: "registry-bearer" });
      if (request.method === "HEAD" && request.url.endsWith("/manifests/0.5.0")) {
        return manifestDigest === undefined ? new Response(null, { status: 404 }) :
          new Response(null, { status: 200, headers: { "Docker-Content-Digest": manifestDigest } });
      }
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      if (request.method === "POST") return new Response(null, { status: 202,
        headers: { Location: "/v2/fractalboxdev/contextful/contextful-edge/blobs/uploads/session" } });
      if (request.method === "PUT" && request.url.endsWith("/manifests/0.5.0")) {
        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await request.arrayBuffer()));
        manifestDigest = `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
        return new Response(null, { status: 201 });
      }
      if (request.method === "PUT") return new Response(null, { status: 201 });
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    const opts = { username: "bot", token: "test-pat", name: "fractalboxdev/contextful/contextful-edge",
      tag: "0.5.0", layer: new Uint8Array([1]), layerSize: 1,
      layerDigest: "a".repeat(64), diffId: "b".repeat(64), fetchImpl };
    await pushGhcrImage(opts);
    const afterPublish = requests.length;
    await pushGhcrImage(opts);
    expect(requests.slice(afterPublish)).toHaveLength(2);
    manifestDigest = "sha256:" + "c".repeat(64);
    await expect(pushGhcrImage(opts)).rejects.toThrow("already names a different manifest");
  });

  it("does not forward the registry bearer token to a cross-host upload URL", async () => {
    const uploads: Request[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/token") return Response.json({ token: "registry-bearer" });
      if (request.method === "HEAD") return new Response(null, { status: 404 });
      if (request.method === "POST") return new Response(null, { status: 202,
        headers: { Location: "https://upload.example.test/blob?signature=test" } });
      if (request.method === "PUT" && url.hostname === "upload.example.test") {
        uploads.push(request);
        return new Response(null, { status: 201 });
      }
      if (request.method === "PUT") return new Response(null, { status: 201 });
      throw new Error(`unexpected ${request.method} ${request.url}`);
    };
    await pushGhcrImage({ username: "bot", token: "test-pat", name: "fractalboxdev/contextful/contextful-edge",
      tag: "0.5.0", layer: new Uint8Array([1]), layerSize: 1,
      layerDigest: "a".repeat(64), diffId: "b".repeat(64), fetchImpl });
    expect(uploads).toHaveLength(2);
    expect(uploads.every((request) => request.headers.get("authorization") === null)).toBe(true);
  });
});

describe("classifyGhcrFailure", () => {
  it("names the registry's HTTP status and keeps the failing operation as detail", () => {
    expect(classifyGhcrFailure(new Error("GHCR blob upload failed with HTTP 404")))
      .toEqual({ status: 404, reason: "other", detail: "GHCR blob upload failed with HTTP 404" });
    expect(classifyGhcrFailure(new Error("GHCR token request failed with HTTP 401")).reason).toBe("unauthorized");
    expect(classifyGhcrFailure(new Error("GHCR blob upload start failed with HTTP 403")).reason).toBe("unauthorized");
    expect(classifyGhcrFailure(new Error("GHCR manifest publish failed with HTTP 429")).reason).toBe("rate-limited");
    expect(classifyGhcrFailure(new Error("GHCR blob upload failed with HTTP 503")).reason).toBe("transient");
  });

  it("treats a network failure as transient and a refused input or tag conflict as final", () => {
    expect(classifyGhcrFailure(new TypeError("fetch failed"))).toMatchObject({ status: 0, reason: "transient" });
    expect(classifyGhcrFailure(new TypeError("invalid OCI image name, tag, digest, or size")))
      .toMatchObject({ status: 0, reason: "other" });
    expect(classifyGhcrFailure(new Error("GHCR image tag already names a different manifest")))
      .toMatchObject({ status: 0, reason: "other" });
  });
});
