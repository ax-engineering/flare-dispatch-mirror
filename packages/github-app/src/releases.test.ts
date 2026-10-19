// Unit tests for GitHub Release create.
//
// Mocks `api.github.com` with MSW and asserts: `createRelease` POSTs to
// `/releases` with the tag, the target sha as `target_commitish`, the body, and
// the installation token as a Bearer credential; it never asks GitHub to
// auto-generate notes; the result maps `id` / `html_url` / `tag_name`; a non-2xx
// surfaces a GithubApiError.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commitOnDefaultBranch, createRelease, getReleaseByTag, publishRelease, resolveTagCommit, resolveTagTarget, uploadReleaseAsset, GithubApiError } from "./index";

type Captured = {
  authorization: string | null;
  owner: string;
  repo: string;
  body: Record<string, unknown>;
};

let posts: Captured[] = [];
let status = 201;
let assetStatus = 201;
let releasePatches: Array<{ id: string; body: Record<string, unknown> }> = [];
let tagRefSha = "annotated-tag-sha";
let assets: Array<{
  url: string;
  authorization: string | null;
  contentType: string | null;
  contentLength: string | null;
  bytes: Uint8Array;
}> = [];
let existingAssets: Array<{ id: number; name: string; size: number; state: string; digest: string; browser_download_url: string }> = [];
let deletedAssets: number[] = [];

const server = setupServer(
  http.post("https://api.github.com/repos/:owner/:repo/releases", async ({ request, params }) => {
    posts.push({
      authorization: request.headers.get("authorization"),
      owner: String(params.owner),
      repo: String(params.repo),
      body: (await request.json()) as Record<string, unknown>,
    });
    if (status >= 400) {
      return HttpResponse.json({ message: "nope" }, { status });
    }
    return HttpResponse.json(
      {
        id: 555_001,
        html_url: "https://github.com/owner/name/releases/tag/v0.1.0",
        tag_name: "v0.1.0",
      },
      { status },
    );
  }),
  http.post(
    "https://uploads.github.com/repos/:owner/:repo/releases/:id/assets",
    async ({ request }) => {
      assets.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        contentLength: request.headers.get("content-length"),
        bytes: new Uint8Array(await request.arrayBuffer()),
      });
      if (assetStatus >= 400)
        return HttpResponse.json({ message: "upload failed" }, { status: assetStatus });
      return HttpResponse.json(
        {
          id: 42,
          name: "archive.tar.gz",
          size: 3,
          digest: `sha256:${"a".repeat(64)}`,
          browser_download_url: "https://github.com/o/r/releases/download/v1/archive.tar.gz",
        },
        { status: assetStatus },
      );
    },
  ),
  http.get("https://api.github.com/repos/:owner/:repo/git/ref/tags/:tag", () =>
    HttpResponse.json({ object: { type: "tag", sha: tagRefSha } }),
  ),
  http.get("https://api.github.com/repos/:owner/:repo/git/tags/:sha", () =>
    HttpResponse.json({ object: { type: "commit", sha: "a".repeat(40) } }),
  ),
  http.get("https://api.github.com/repos/:owner/:repo/releases/tags/:tag", () =>
    new HttpResponse(null, { status: 404 }),
  ),
  http.get("https://api.github.com/repos/:owner/:repo/releases", () =>
    HttpResponse.json([{ id: 555_001, html_url: "https://github.com/o/r/releases/tag/v1", tag_name: "v1", draft: true }]),
  ),
  http.patch("https://api.github.com/repos/:owner/:repo/releases/:id", async ({ params, request }) => {
    releasePatches.push({ id: String(params.id), body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({ id: Number(params.id), html_url: "https://github.com/o/r/releases/tag/v1", tag_name: "v1", draft: false });
  }),
  http.get("https://api.github.com/repos/:owner/:repo", () =>
    HttpResponse.json({ default_branch: "main" }),
  ),
  http.get("https://api.github.com/repos/:owner/:repo/releases/:id/assets", () =>
    HttpResponse.json(existingAssets),
  ),
  http.delete("https://api.github.com/repos/:owner/:repo/releases/assets/:id", ({ params }) => {
    deletedAssets.push(Number(params.id));
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("https://api.github.com/repos/:owner/:repo/compare/:basehead", () =>
    HttpResponse.json({ status: "ahead" }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  posts = [];
  status = 201;
  assets = [];
  assetStatus = 201;
  releasePatches = [];
  tagRefSha = "annotated-tag-sha";
  existingAssets = [];
  deletedAssets = [];
  vi.unstubAllGlobals();
});

describe("uploadReleaseAsset", () => {
  it("uses a fixed-length stream in Workers", async () => {
    let fixedSize = -1;
    class FakeFixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
      constructor(size: number) {
        super();
        fixedSize = size;
      }
    }
    vi.stubGlobal("FixedLengthStream", FakeFixedLengthStream);
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    await uploadReleaseAsset({
      token: "t",
      repo: "o/r",
      releaseId: 7,
      name: "archive.tar.gz",
      contentType: "application/gzip",
      size: 3,
      content,
    });
    expect(fixedSize).toBe(3);
    expect(assets[0]!.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("streams bytes to the uploads API with a safe asset name", async () => {
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const result = await uploadReleaseAsset({
      token: "install-token",
      repo: "o/r",
      releaseId: 7,
      name: "archive.tar.gz",
      contentType: "application/gzip",
      size: 3,
      content,
    });
    expect(assets).toHaveLength(1);
    expect(new URL(assets[0]!.url).searchParams.get("name")).toBe("archive.tar.gz");
    expect(assets[0]!.authorization).toBe("Bearer install-token");
    expect(assets[0]!.contentType).toBe("application/gzip");
    expect(assets[0]!.contentLength).toBe("3");
    expect(assets[0]!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(result).toEqual({
      id: 42,
      name: "archive.tar.gz",
      size: 3,
      downloadUrl: "https://github.com/o/r/releases/download/v1/archive.tar.gz",
    });
  });

  it("surfaces API errors and refuses invalid release IDs", async () => {
    assetStatus = 422;
    const args = {
      token: "t",
      repo: "o/r",
      releaseId: 7,
      name: "archive.tar.gz",
      contentType: "application/gzip",
      size: 3,
      content: new Uint8Array([1, 2, 3]),
    };
    await expect(uploadReleaseAsset(args)).rejects.toBeInstanceOf(GithubApiError);
    await expect(uploadReleaseAsset({ ...args, releaseId: 0 })).rejects.toThrow(TypeError);
    await expect(uploadReleaseAsset({ ...args, name: "../archive.tar.gz" })).rejects.toThrow(
      TypeError,
    );
  });

  it("reuses a matching uploaded asset and replaces a starter asset", async () => {
    existingAssets = [{ id: 12, name: "archive.tar.gz", size: 3, state: "uploaded", digest: `sha256:${"a".repeat(64)}`, browser_download_url: "https://example.test/archive" }];
    const options = { token: "t", repo: "o/r", releaseId: 7, name: "archive.tar.gz", contentType: "application/gzip", size: 3,
      sha256: "a".repeat(64), content: new Uint8Array([1, 2, 3]) };
    const reused = await uploadReleaseAsset(options);
    expect(reused.id).toBe(12);
    expect(assets).toHaveLength(0);
    existingAssets[0] = { ...existingAssets[0]!, state: "starter" };
    await uploadReleaseAsset(options);
    expect(deletedAssets).toEqual([12]);
    expect(assets).toHaveLength(1);
  });

  it("rejects an upload response whose digest differs from the source artifact", async () => {
    await expect(uploadReleaseAsset({ token: "t", repo: "o/r", releaseId: 7,
      name: "archive.tar.gz", contentType: "application/gzip", size: 3,
      sha256: "b".repeat(64), content: new Uint8Array([1, 2, 3]) }))
      .rejects.toThrow("metadata does not match");
  });
});
afterAll(() => server.close());

describe("createRelease", () => {
  it("POSTs the release with the tag, target sha, and a Bearer token", async () => {
    const result = await createRelease({
      token: "inst-token-abc",
      repo: "owner/name",
      tag: "v0.1.0",
      target: "deadbeefcafe",
      name: "v0.1.0",
      body: "## v0.1.0\n\n### 🚀 Features\n- thing",
    });

    expect(posts).toHaveLength(1);
    const p = posts[0]!;
    expect(p.owner).toBe("owner");
    expect(p.repo).toBe("name");
    expect(p.authorization).toBe("Bearer inst-token-abc");
    expect(p.body.tag_name).toBe("v0.1.0");
    expect(p.body.target_commitish).toBe("deadbeefcafe");
    expect(p.body.name).toBe("v0.1.0");
    expect(p.body.body).toContain("### 🚀 Features");
    // We render our own notes — never let GitHub overwrite the body.
    expect(p.body.generate_release_notes).toBe(false);
    expect(p.body.draft).toBe(false);

    expect(result).toEqual({
      id: 555_001,
      htmlUrl: "https://github.com/owner/name/releases/tag/v0.1.0",
      tagName: "v0.1.0",
    });
  });

  it("omits target_commitish when no target is given", async () => {
    await createRelease({ token: "t", repo: "o/r", tag: "v1.0.0", body: "b" });
    expect(posts[0]!.body).not.toHaveProperty("target_commitish");
    expect(posts[0]!.body.name).toBe("v1.0.0"); // defaults to the tag
  });

  it("surfaces a GithubApiError on a non-2xx (e.g. 422 release exists)", async () => {
    status = 422;
    await expect(
      createRelease({ token: "t", repo: "o/r", tag: "v1.0.0", body: "b" }),
    ).rejects.toBeInstanceOf(GithubApiError);
  });
});

describe("release lifecycle", () => {
  it("resolves an annotated tag to its commit", async () => {
    expect(await resolveTagCommit({ token: "t", repo: "o/r", tag: "v1" })).toBe("a".repeat(40));
    expect(await resolveTagTarget({ token: "t", repo: "o/r", tag: "v1" })).toEqual({
      refSha: "annotated-tag-sha", commitSha: "a".repeat(40),
    });
  });

  it("accepts a release commit in the default branch history", async () => {
    expect(await commitOnDefaultBranch({ token: "t", repo: "o/r", commitSha: "a".repeat(40) })).toBe(true);
  });

  it("reads a draft by tag and publishes its numeric id", async () => {
    const release = await getReleaseByTag({ token: "t", repo: "o/r", tag: "v1" });
    expect(release).toMatchObject({ id: 555_001, draft: true });
    await publishRelease({ token: "t", repo: "o/r", releaseId: release!.id });
    expect(releasePatches).toEqual([{ id: "555001", body: { draft: false } }]);
  });

  it("publishes a draft with the release notes it is given as its body", async () => {
    await publishRelease({ token: "t", repo: "o/r", releaseId: 555_001, body: "## Consumer compatibility" });
    expect(releasePatches).toEqual([{ id: "555001", body: { draft: false, body: "## Consumer compatibility" } }]);
  });
});
