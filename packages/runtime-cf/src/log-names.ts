// FlareDispatch — the one grammar of log file names under `logs/<executionId>/`.
//
// Writers build names here (sandbox exec logs, durable check-command chunks and
// their consolidated log); the dispatcher's log routes parse and order them
// here. A name outside this grammar is not a log: the read side refuses it, so
// no request can reach an arbitrary R2 key or escape the execution's prefix.
//
//   exec.ndjson, exec-<n>.ndjson                  one sandbox exec (n ≥ 2)
//   check-<handle>.ndjson                         a finalized check process
//   check-<handle>/<stream>-<start>-<end>.ndjson  one durable chunk, byte range
//                                                 [start, end) of stdout|stderr
//
// where <handle> is `check-` plus 48 lowercase hex digits.

export type LogStream = "stdout" | "stderr";

export type LogFile =
  | { readonly kind: "exec"; readonly seq: number }
  | { readonly kind: "check"; readonly process: string }
  | {
      readonly kind: "chunk";
      readonly process: string;
      readonly stream: LogStream;
      readonly start: number;
      readonly end: number;
    };

const EXEC_RE = /^exec(?:-([1-9][0-9]*))?\.ndjson$/;
const PROCESS = "check-check-[0-9a-f]{48}";
const CHECK_RE = new RegExp(`^(${PROCESS})\\.ndjson$`);
const CHUNK_RE = new RegExp(
  `^(${PROCESS})/(stdout|stderr)-(0|[1-9][0-9]*)-([1-9][0-9]*)\\.ndjson$`,
);

/** The `n`th exec log of a run: `exec.ndjson`, then `exec-2.ndjson`, … */
export const execLogFile = (seq: number): string =>
  seq === 1 ? "exec.ndjson" : `exec-${seq}.ndjson`;

/** A check command's handle id, from the hex digest naming its operation. */
export const checkHandleId = (operationDigest: string): string =>
  `check-${operationDigest.slice(0, 48)}`;

const checkProcess = (handleId: string): string => `check-${handleId}`;

/** The consolidated log a finalized check command publishes. */
export const checkLogFile = (handleId: string): string => `${checkProcess(handleId)}.ndjson`;

/** One durable chunk: bytes `[start, end)` of a check command's stream. */
export const checkChunkLogFile = (
  handleId: string,
  stream: LogStream,
  start: number,
  end: number,
): string => `${checkProcess(handleId)}/${stream}-${start}-${end}.ndjson`;

/** Parse a log file name, or `null` for any name no writer produces. */
export const parseLogFile = (name: string): LogFile | null => {
  const exec = EXEC_RE.exec(name);
  if (exec !== null) {
    const seq = exec[1] === undefined ? 1 : Number(exec[1]);
    return seq === 1 && exec[1] !== undefined ? null : { kind: "exec", seq };
  }
  const check = CHECK_RE.exec(name);
  if (check !== null) return { kind: "check", process: check[1]! };
  const chunk = CHUNK_RE.exec(name);
  if (chunk === null) return null;
  const start = Number(chunk[3]);
  const end = Number(chunk[4]);
  if (!Number.isSafeInteger(end) || end <= start) return null;
  return { kind: "chunk", process: chunk[1]!, stream: chunk[2] as LogStream, start, end };
};

/** A listed log object: its name and, when the store reports it, its upload instant. */
export type ListedLog = { readonly file: string; readonly uploaded?: number };

/** One reader-facing section: an exec, or one check process read file by file. */
export type LogSection = { readonly id: string; readonly files: readonly string[] };

/**
 * Order listed logs into sections in reading order. Exec logs come first by
 * sequence, then check processes by first upload. A finalized process reads from its
 * consolidated log alone; a running one reads its chunks in write order —
 * upload instant, then stdout before stderr, then byte offset, which is the
 * order the supervisor drains each observation. Names outside the grammar drop.
 */
export const logSections = (listed: readonly ListedLog[]): LogSection[] => {
  const execs: { seq: number; file: string }[] = [];
  const processes = new Map<
    string,
    {
      first: number;
      consolidated?: string;
      chunks: { file: string; at: number; stream: LogStream; start: number }[];
    }
  >();
  const processFor = (id: string, at: number) => {
    let p = processes.get(id);
    if (p === undefined) processes.set(id, (p = { first: at, chunks: [] }));
    p.first = Math.min(p.first, at);
    return p;
  };
  for (const { file, uploaded } of listed) {
    const parsed = parseLogFile(file);
    if (parsed === null) continue;
    const at = uploaded ?? 0;
    if (parsed.kind === "exec") execs.push({ seq: parsed.seq, file });
    else if (parsed.kind === "check") processFor(parsed.process, at).consolidated = file;
    else
      processFor(parsed.process, at).chunks.push({
        file,
        at,
        stream: parsed.stream,
        start: parsed.start,
      });
  }
  const sections: LogSection[] = execs
    .sort((a, b) => a.seq - b.seq)
    .map(({ file }) => ({ id: file, files: [file] }));
  const started = [...processes].sort(
    ([a, p], [b, q]) => p.first - q.first || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const [id, p] of started) {
    const files =
      p.consolidated !== undefined
        ? [p.consolidated]
        : p.chunks
            .sort(
              (a, b) =>
                a.at - b.at ||
                (a.stream === b.stream ? 0 : a.stream === "stdout" ? -1 : 1) ||
                a.start - b.start,
            )
            .map((c) => c.file);
    sections.push({ id, files });
  }
  return sections;
};
