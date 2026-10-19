// @fractalboxdev/flare-dispatch-github-app — create a GitHub Release.
//
// `createRelease` publishes a release:
//   POST /repos/{owner}/{repo}/releases  { tag_name, target_commitish, name, body, ... }
//
// When `tag_name` does not yet exist GitHub creates the tag at `target_commitish`
// (a branch name OR a commit sha) as part of publishing the release — so the
// caller needs no separate `POST /git/refs` tag-create. The `release-notes` run
// pins `target_commitish` to the exact HEAD sha the notes were drafted from, so
// the tag is reproducible regardless of later pushes to the branch.
//
// Authenticated with an installation access token (installation-token.ts) —
// never an App JWT, never a PAT. Provider-neutral plain `async`; the Effect
// Layer (`makeGithubLive` in @fractalboxdev/flare-dispatch-runtime-cf) wraps it.

import { assertOk, ghHeaders, resolveClient, splitRepo } from "./http";

export type CreateReleaseOptions = {
  /** The installation access token authenticating the call. */
  readonly token: string;
  /** `"owner/repo"`. */
  readonly repo: string;
  /** The git tag to create/point the release at (e.g. `v0.1.0`). */
  readonly tag: string;
  /**
   * The commit sha (or branch) the tag is created at when it does not already
   * exist. Omit to let GitHub use the repo's default branch tip.
   */
  readonly target?: string;
  /** The release title — defaults to `tag` when omitted. */
  readonly name?: string;
  /** The release body (markdown). */
  readonly body: string;
  /** Publish as a draft (unlisted, no tag created). Default `false`. */
  readonly draft?: boolean;
  /** Mark as a pre-release. Default `false`. */
  readonly prerelease?: boolean;
  /** API base override (tests / GHE). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

export type CreateReleaseResult = {
  /** The release's numeric id. */
  readonly id: number;
  /** The release's web URL. */
  readonly htmlUrl: string;
  /** The tag the release points at (echoed back by GitHub). */
  readonly tagName: string;
};

export type ReleaseRef = CreateReleaseResult & { readonly draft: boolean };

type ReleaseRequest = {
  readonly token: string;
  readonly repo: string;
  readonly apiBase?: string;
  readonly fetchImpl?: typeof fetch;
};

/** Resolve lightweight and annotated refs to the immutable commit they name. */
export const resolveTagTarget = async (
  opts: ReleaseRequest & { readonly tag: string },
): Promise<{ readonly refSha: string; readonly commitSha: string }> => {
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const ref = await doFetch(
    `${apiBase}/repos/${owner}/${name}/git/ref/tags/${encodeURIComponent(opts.tag)}`,
    { headers: ghHeaders(opts.token) },
  );
  await assertOk(ref, "tag lookup failed");
  let object = ((await ref.json()) as { object: { type: string; sha: string } }).object;
  const refSha = object.sha;
  for (let depth = 0; depth < 8 && object.type === "tag"; depth++) {
    const res = await doFetch(`${apiBase}/repos/${owner}/${name}/git/tags/${encodeURIComponent(object.sha)}`, {
      headers: ghHeaders(opts.token),
    });
    await assertOk(res, "annotated tag lookup failed");
    object = ((await res.json()) as { object: { type: string; sha: string } }).object;
  }
  if (object.type !== "commit" || !/^[a-f0-9]{40}$/.test(object.sha)) {
    throw new TypeError("tag does not resolve to a commit SHA");
  }
  return { refSha, commitSha: object.sha };
};

export const resolveTagCommit = async (opts: ReleaseRequest & { readonly tag: string }): Promise<string> =>
  (await resolveTagTarget(opts)).commitSha;

/** A release commit must be reachable from the repository's default branch. */
export const commitOnDefaultBranch = async (
  opts: ReleaseRequest & { readonly commitSha: string },
): Promise<boolean> => {
  if (!/^[a-f0-9]{40}$/.test(opts.commitSha)) throw new TypeError("commitSha must be a full SHA");
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const repo = await doFetch(`${apiBase}/repos/${owner}/${name}`, { headers: ghHeaders(opts.token) });
  await assertOk(repo, "repository lookup failed");
  const { default_branch: branch } = (await repo.json()) as { default_branch: string };
  const compare = await doFetch(
    `${apiBase}/repos/${owner}/${name}/compare/${opts.commitSha}...${encodeURIComponent(branch)}`,
    { headers: ghHeaders(opts.token) },
  );
  await assertOk(compare, "default-branch ancestry check failed");
  const { status } = (await compare.json()) as { status: string };
  return status === "ahead" || status === "identical";
};

export const getReleaseByTag = async (
  opts: ReleaseRequest & { readonly tag: string },
): Promise<ReleaseRef | undefined> => {
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const res = await doFetch(
    `${apiBase}/repos/${owner}/${name}/releases/tags/${encodeURIComponent(opts.tag)}`,
    { headers: ghHeaders(opts.token) },
  );
  if (res.status === 404) {
    // The by-tag endpoint returns published releases only. Authenticated list
    // pages also include drafts, which a retried release run must recover.
    for (let page = 1; page <= 10; page++) {
      const listed = await doFetch(`${apiBase}/repos/${owner}/${name}/releases?per_page=100&page=${page}`, {
        headers: ghHeaders(opts.token),
      });
      await assertOk(listed, "draft release lookup failed");
      const releases = (await listed.json()) as Array<{ id: number; html_url: string; tag_name: string; draft: boolean }>;
      const found = releases.find((release) => release.tag_name === opts.tag);
      if (found !== undefined) return { id: found.id, htmlUrl: found.html_url, tagName: found.tag_name, draft: found.draft };
      if (releases.length < 100) return undefined;
    }
    throw new Error("draft release lookup exceeded ten pages");
  }
  await assertOk(res, "release lookup failed");
  const json = (await res.json()) as { id: number; html_url: string; tag_name: string; draft: boolean };
  return { id: json.id, htmlUrl: json.html_url, tagName: json.tag_name, draft: json.draft };
};

/** Publish a draft; `body`, when given, replaces its release notes in the same write. */
export const publishRelease = async (
  opts: ReleaseRequest & { readonly releaseId: number; readonly body?: string },
): Promise<ReleaseRef> => {
  if (!Number.isSafeInteger(opts.releaseId) || opts.releaseId <= 0) {
    throw new TypeError("releaseId must be a positive integer");
  }
  const { owner, name } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);
  const res = await doFetch(`${apiBase}/repos/${owner}/${name}/releases/${opts.releaseId}`, {
    method: "PATCH",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify(opts.body === undefined ? { draft: false } : { draft: false, body: opts.body }),
  });
  await assertOk(res, "release publish failed");
  const json = (await res.json()) as { id: number; html_url: string; tag_name: string; draft: boolean };
  return { id: json.id, htmlUrl: json.html_url, tagName: json.tag_name, draft: json.draft };
};

export type UploadReleaseAssetOptions = {
  readonly token: string;
  readonly repo: string;
  readonly releaseId: number;
  readonly name: string;
  readonly contentType: string;
  readonly content: ReadableStream<Uint8Array> | Uint8Array;
  readonly size: number;
  /** Expected SHA-256 of the immutable local artifact, for retry matching. */
  readonly sha256?: string;
  /** API host override for GitHub Enterprise and tests. */
  readonly uploadBase?: string;
  readonly fetchImpl?: typeof fetch;
};

export type UploadReleaseAssetResult = {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly downloadUrl: string;
};

/** Upload one R2-backed artifact without materializing it in Worker memory. */
export const uploadReleaseAsset = async (
  opts: UploadReleaseAssetOptions,
): Promise<UploadReleaseAssetResult> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  if (!Number.isSafeInteger(opts.releaseId) || opts.releaseId <= 0) {
    throw new TypeError("releaseId must be a positive integer");
  }
  if (!Number.isSafeInteger(opts.size) || opts.size < 0) {
    throw new TypeError("asset size must be a nonnegative integer");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(opts.name)) {
    throw new TypeError("asset name must be one path-free filename of at most 255 characters");
  }
  if (opts.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(opts.sha256)) {
    throw new TypeError("sha256 must be a lowercase hex digest");
  }
  const uploadBase = opts.uploadBase ?? "https://uploads.github.com";
  const doFetch = opts.fetchImpl ?? fetch;
  if (opts.sha256 !== undefined) {
    const { apiBase } = resolveClient(opts);
    const listed = await doFetch(
      `${apiBase}/repos/${owner}/${repoName}/releases/${opts.releaseId}/assets?per_page=100`,
      { headers: ghHeaders(opts.token) },
    );
    await assertOk(listed, "release assets lookup failed");
    const matches = ((await listed.json()) as Array<{
      id: number; name: string; size: number; state: string; digest?: string; browser_download_url: string;
    }>).filter((asset) => asset.name === opts.name);
    for (const asset of matches) {
      if (asset.state === "uploaded" && asset.size === opts.size && asset.digest === `sha256:${opts.sha256}`) {
        return { id: asset.id, name: asset.name, size: asset.size, downloadUrl: asset.browser_download_url };
      }
      const deleted = await doFetch(`${apiBase}/repos/${owner}/${repoName}/releases/assets/${asset.id}`, {
        method: "DELETE", headers: ghHeaders(opts.token),
      });
      await assertOk(deleted, "stale release asset delete failed");
    }
  }
  const url = new URL(`${uploadBase}/repos/${owner}/${repoName}/releases/${opts.releaseId}/assets`);
  url.searchParams.set("name", opts.name);
  // Workers derives Content-Length only from a fixed-length body. The R2
  // ReadableStream stays streaming; the pump never buffers the whole asset.
  const FixedLength = (
    globalThis as typeof globalThis & {
      FixedLengthStream?: new (size: number) => {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
    }
  ).FixedLengthStream;
  const fixed =
    opts.content instanceof ReadableStream && FixedLength !== undefined
      ? new FixedLength(opts.size)
      : undefined;
  const pump =
    fixed !== undefined && opts.content instanceof ReadableStream
      ? opts.content.pipeTo(fixed.writable)
      : undefined;
  const body = fixed?.readable ?? opts.content;
  const request = doFetch(url, {
    method: "POST",
    headers: {
      ...ghHeaders(opts.token),
      "Content-Type": opts.contentType,
      "Content-Length": String(opts.size),
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
  const [res] = await Promise.all([request, pump ?? Promise.resolve()]);
  await assertOk(res, "release asset upload failed");
  const json = (await res.json()) as {
    id: number;
    name: string;
    size: number;
    digest?: string;
    browser_download_url: string;
  };
  if (json.name !== opts.name || json.size !== opts.size ||
    (opts.sha256 !== undefined && json.digest !== `sha256:${opts.sha256}`)) {
    throw new Error("uploaded release asset metadata does not match the requested artifact");
  }
  return {
    id: json.id,
    name: json.name,
    size: json.size,
    downloadUrl: json.browser_download_url,
  };
};

/**
 * Create (publish) a GitHub Release, creating the tag at `target` if needed.
 *
 * @throws {GithubApiError} when the API returns non-2xx — including a 422 when a
 * release already exists for `tag` (the caller's idempotency key should prevent
 * re-firing the same release, so a 422 here is a genuine conflict to surface).
 */
export const createRelease = async (opts: CreateReleaseOptions): Promise<CreateReleaseResult> => {
  const { owner, name: repoName } = splitRepo(opts.repo);
  const { apiBase, doFetch } = resolveClient(opts);

  const res = await doFetch(`${apiBase}/repos/${owner}/${repoName}/releases`, {
    method: "POST",
    headers: ghHeaders(opts.token, { json: true }),
    body: JSON.stringify({
      tag_name: opts.tag,
      ...(opts.target !== undefined ? { target_commitish: opts.target } : {}),
      name: opts.name ?? opts.tag,
      body: opts.body,
      draft: opts.draft ?? false,
      prerelease: opts.prerelease ?? false,
      // We render our own categorized notes; never ask GitHub to overwrite
      // `body` with its auto-generated list.
      generate_release_notes: false,
    }),
  });

  await assertOk(res, "release create failed");

  const json = (await res.json().catch(() => ({}))) as {
    id?: number;
    html_url?: string;
    tag_name?: string;
  };
  return {
    id: json.id ?? 0,
    htmlUrl: json.html_url ?? "",
    tagName: json.tag_name ?? opts.tag,
  };
};
