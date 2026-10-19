import { describe, expect, it } from "vitest";
import {
  checkChunkLogFile,
  checkHandleId,
  checkLogFile,
  execLogFile,
  logSections,
  parseLogFile,
} from "./log-names";

const DIGEST = "0123456789abcdef".repeat(3);
const HANDLE = `check-${DIGEST}`;
const PROCESS = `check-check-${DIGEST}`;

describe("log file name grammar", () => {
  it("builds the names every producer writes", () => {
    expect(execLogFile(1)).toBe("exec.ndjson");
    expect(execLogFile(2)).toBe("exec-2.ndjson");
    expect(checkHandleId(`${DIGEST}ffff`)).toBe(HANDLE);
    expect(checkLogFile(HANDLE)).toBe(`${PROCESS}.ndjson`);
    expect(checkChunkLogFile(HANDLE, "stderr", 0, 10139)).toBe(`${PROCESS}/stderr-0-10139.ndjson`);
  });

  it("parses the exact names producers write", () => {
    expect(parseLogFile("exec.ndjson")).toEqual({ kind: "exec", seq: 1 });
    expect(parseLogFile("exec-12.ndjson")).toEqual({ kind: "exec", seq: 12 });
    expect(parseLogFile(`${PROCESS}.ndjson`)).toEqual({ kind: "check", process: PROCESS });
    expect(parseLogFile(`${PROCESS}/stderr-0-10139.ndjson`)).toEqual({
      kind: "chunk",
      process: PROCESS,
      stream: "stderr",
      start: 0,
      end: 10139,
    });
  });

  it.each([
    "",
    "secrets.env",
    "exec-1.ndjson",
    "exec-02.ndjson",
    "exec-step_a.ndjson",
    "../exec.ndjson",
    `${PROCESS}/../exec.ndjson`,
    `${PROCESS}/./stdout-0-1.ndjson`,
    `${PROCESS}//stdout-0-1.ndjson`,
    `/${PROCESS}.ndjson`,
    `${PROCESS}\\stdout-0-1.ndjson`,
    `${PROCESS}/stdout-0-1.ndjson/`,
    `${PROCESS}/exec.ndjson`,
    `${PROCESS}/stdin-0-1.ndjson`,
    `${PROCESS}/stdout-5-5.ndjson`,
    `${PROCESS}/stdout-01-5.ndjson`,
    `check-check-${DIGEST.slice(1)}.ndjson`,
    `check-check-${DIGEST.toUpperCase()}.ndjson`,
    `check-${DIGEST}.ndjson`,
    `../../artifacts/x/${PROCESS}.ndjson`,
  ])("refuses %j", (name) => {
    expect(parseLogFile(name)).toBeNull();
  });
});

describe("logSections — stream-order reading plan", () => {
  it("orders exec logs numerically and drops names outside the grammar", () => {
    expect(
      logSections([
        { file: "exec-10.ndjson" },
        { file: "secrets.env" },
        { file: "exec-2.ndjson" },
        { file: "exec.ndjson" },
      ]),
    ).toEqual([
      { id: "exec.ndjson", files: ["exec.ndjson"] },
      { id: "exec-2.ndjson", files: ["exec-2.ndjson"] },
      { id: "exec-10.ndjson", files: ["exec-10.ndjson"] },
    ]);
  });

  it("reads a running process's chunks in write order, numerically within a stream", () => {
    const chunk = (stream: "stdout" | "stderr", a: number, b: number) =>
      `${PROCESS}/${stream}-${a}-${b}.ndjson`;
    // R2 lists keys lexically: every stderr chunk before every stdout chunk,
    // and `stdout-65536-…` before `stdout-9000-…`.
    const listed = [
      { file: chunk("stderr", 0, 10139), uploaded: 2 },
      { file: chunk("stderr", 10139, 20000), uploaded: 5 },
      { file: chunk("stdout", 65536, 70000), uploaded: 4 },
      { file: chunk("stdout", 0, 9000), uploaded: 1 },
      { file: chunk("stdout", 9000, 65536), uploaded: 3 },
      { file: "exec.ndjson", uploaded: 0 },
    ];
    expect(logSections(listed)).toEqual([
      { id: "exec.ndjson", files: ["exec.ndjson"] },
      {
        id: PROCESS,
        files: [
          chunk("stdout", 0, 9000),
          chunk("stderr", 0, 10139),
          chunk("stdout", 9000, 65536),
          chunk("stdout", 65536, 70000),
          chunk("stderr", 10139, 20000),
        ],
      },
    ]);
  });

  it("falls back to stream offsets when upload instants tie", () => {
    const listed = [
      { file: `${PROCESS}/stdout-9000-65536.ndjson`, uploaded: 7 },
      { file: `${PROCESS}/stdout-0-9000.ndjson`, uploaded: 7 },
    ];
    expect(logSections(listed)[0]?.files).toEqual([
      `${PROCESS}/stdout-0-9000.ndjson`,
      `${PROCESS}/stdout-9000-65536.ndjson`,
    ]);
  });

  it("reads a finalized process from its consolidated log alone", () => {
    expect(
      logSections([
        { file: `${PROCESS}/stderr-0-10139.ndjson` },
        { file: `${PROCESS}.ndjson` },
        { file: `${PROCESS}/stdout-0-9000.ndjson` },
      ]),
    ).toEqual([{ id: PROCESS, files: [`${PROCESS}.ndjson`] }]);
  });
});
