type BlobBody = Uint8Array | ReadableStream<Uint8Array>;

export type GhcrImage = {
  readonly username: string;
  readonly token: string;
  /** Registry path without ghcr.io, e.g. owner/repo/profile. */
  readonly name: string;
  readonly tag: string;
  readonly layer: BlobBody;
  readonly layerSize: number;
  readonly layerDigest: string;
  /** SHA-256 of the uncompressed tar stream. */
  readonly diffId: string;
  readonly fetchImpl?: typeof fetch;
};

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const digest = async (bytes: Uint8Array): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

const requireOk = async (response: Response, operation: string): Promise<void> => {
  if (!response.ok) throw new Error(`${operation} failed with HTTP ${response.status}`);
};

const fixedBody = (body: BlobBody, size: number): { body: BlobBody; pump?: Promise<void> } => {
  const FixedLength = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (size: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  }).FixedLengthStream;
  if (!(body instanceof ReadableStream) || FixedLength === undefined) return { body };
  const fixed = new FixedLength(size);
  return { body: fixed.readable, pump: body.pipeTo(fixed.writable) };
};

/** Push a single-platform static image through the OCI Distribution API. */
export const pushGhcrImage = async (opts: GhcrImage): Promise<void> => {
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(opts.name) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(opts.tag) ||
    !/^[a-f0-9]{64}$/.test(opts.layerDigest) || !/^[a-f0-9]{64}$/.test(opts.diffId) ||
    !Number.isSafeInteger(opts.layerSize) || opts.layerSize < 0) {
    throw new TypeError("invalid OCI image name, tag, digest, or size");
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const scope = `repository:${opts.name}:pull,push`;
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set("service", "ghcr.io");
  tokenUrl.searchParams.set("scope", scope);
  const tokenResponse = await doFetch(tokenUrl, {
    headers: { Authorization: `Basic ${btoa(`${opts.username}:${opts.token}`)}` },
  });
  await requireOk(tokenResponse, "GHCR token request");
  const { token } = (await tokenResponse.json()) as { token: string };
  if (!token) throw new Error("GHCR returned no scoped registry token");
  const auth = { Authorization: `Bearer ${token}` };
  const base = `https://ghcr.io/v2/${opts.name}`;
  const config = new TextEncoder().encode(JSON.stringify({
    architecture: "amd64", os: "linux",
    config: { User: "65532:65532", WorkingDir: "/data",
      Entrypoint: ["/usr/local/bin/contextful"], Cmd: ["--version"], Volumes: { "/data": {} } },
    rootfs: { type: "layers", diff_ids: [`sha256:${opts.diffId}`] },
    history: [{ created_by: "contextful release" }],
  }));
  const configDigest = await digest(config);
  const manifest = new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${configDigest}`, size: config.byteLength },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", digest: `sha256:${opts.layerDigest}`, size: opts.layerSize }],
  }));
  const manifestDigest = `sha256:${await digest(manifest)}`;
  const manifestUrl = `${base}/manifests/${encodeURIComponent(opts.tag)}`;
  const existing = await doFetch(manifestUrl, {
    method: "HEAD", headers: { ...auth, Accept: "application/vnd.oci.image.manifest.v1+json" },
  });
  if (existing.ok) {
    if (existing.headers.get("docker-content-digest") === manifestDigest) return;
    throw new Error("GHCR image tag already names a different manifest");
  }
  if (existing.status !== 404) throw new Error(`GHCR manifest lookup failed with HTTP ${existing.status}`);
  // A blob upload is `application/octet-stream` (OCI Distribution); GHCR answers 404 to
  // a blob PUT typed with an image media type. Media types belong to the manifest.
  const uploadBlob = async (sha256: string, body: BlobBody, size: number): Promise<void> => {
    const exists = await doFetch(`${base}/blobs/sha256:${sha256}`, { method: "HEAD", headers: auth });
    if (exists.ok) return;
    if (exists.status !== 404) throw new Error(`GHCR blob lookup failed with HTTP ${exists.status}`);
    const started = await doFetch(`${base}/blobs/uploads/`, { method: "POST", headers: auth });
    await requireOk(started, "GHCR blob upload start");
    const location = started.headers.get("location");
    if (location === null) throw new Error("GHCR omitted upload location");
    const uploadUrl = new URL(location, "https://ghcr.io");
    if (uploadUrl.protocol !== "https:" || uploadUrl.username || uploadUrl.password) {
      throw new Error("GHCR upload location is not HTTPS");
    }
    uploadUrl.searchParams.set("digest", `sha256:${sha256}`);
    const fixed = fixedBody(body, size);
    const request = doFetch(uploadUrl, {
      method: "PUT",
      headers: { ...(uploadUrl.hostname === "ghcr.io" ? auth : {}),
        "Content-Type": "application/octet-stream", "Content-Length": String(size) },
      body: fixed.body,
      ...(fixed.body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
    const [finished] = await Promise.all([request, fixed.pump ?? Promise.resolve()]);
    await requireOk(finished, "GHCR blob upload");
  };

  await uploadBlob(configDigest, config, config.byteLength);
  await uploadBlob(opts.layerDigest, opts.layer, opts.layerSize);
  const published = await doFetch(manifestUrl, {
    method: "PUT", headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" }, body: manifest,
  });
  await requireOk(published, "GHCR manifest publish");
};

/**
 * A `pushGhcrImage` failure as a GitHub API outcome: the registry's HTTP status
 * from the failing operation's message, its retry class, and the message itself.
 * A network failure (no status) is transient; a refused input or a conflicting
 * tag is final.
 */
export const classifyGhcrFailure = (cause: unknown): {
  status: number; reason: "rate-limited" | "unauthorized" | "transient" | "other"; detail: string;
} => {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const status = Number(/\bHTTP (\d{3})\b/.exec(detail)?.[1] ?? 0);
  const final = /^invalid OCI image|already names a different manifest/.test(detail);
  const reason = status === 401 || status === 403 ? "unauthorized"
    : status === 429 ? "rate-limited"
      : (status === 0 && !final) || status >= 500 ? "transient"
        : "other";
  return { status, reason, detail };
};
