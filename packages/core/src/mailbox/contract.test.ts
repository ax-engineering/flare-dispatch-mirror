// Tests for the mailbox address build/parse — sub-addressing + catch-all forms.

import { describe, expect, it } from "vitest";
import { buildInboxAddress, isInboxLocalPart, parseInboxLocalPart } from "./contract";

const LP = "demo-0123456789abcdef0123456789abcd";

describe("buildInboxAddress", () => {
  it("sub-addressing form: base@domain → base+localPart@domain", () => {
    expect(buildInboxAddress(LP, "flare-dispatch-inbox@example.com")).toBe(
      `flare-dispatch-inbox+${LP}@example.com`,
    );
  });
  it("catch-all form: bare domain → localPart@domain", () => {
    expect(buildInboxAddress(LP, "inbox.example.com")).toBe(`${LP}@inbox.example.com`);
  });
  it("tolerates a leading @ on the target", () => {
    expect(buildInboxAddress(LP, "@inbox.test")).toBe(`${LP}@inbox.test`);
  });
});

describe("parseInboxLocalPart", () => {
  it("extracts the +tag under sub-addressing", () => {
    expect(parseInboxLocalPart(`flare-dispatch-inbox+${LP}@example.com`)).toBe(LP);
  });
  it("returns the bare local-part under catch-all", () => {
    expect(parseInboxLocalPart(`${LP}@inbox.test`)).toBe(LP);
  });
  it("is case-insensitive on the envelope address", () => {
    expect(parseInboxLocalPart(`Flare-Dispatch-Inbox+${LP.toUpperCase()}@Fractalbox.Dev`)).toBe(LP);
  });
  it("rejects a non-demo tag (→ setReject)", () => {
    expect(parseInboxLocalPart("flare-dispatch-inbox+random@example.com")).toBeNull();
    expect(parseInboxLocalPart("flare-dispatch-inbox@example.com")).toBeNull();
    expect(parseInboxLocalPart("postmaster@example.com")).toBeNull();
  });
  it("round-trips a built sub-address back to its local-part", () => {
    const addr = buildInboxAddress(LP, "flare-dispatch-inbox@example.com");
    expect(parseInboxLocalPart(addr)).toBe(LP);
    expect(isInboxLocalPart(parseInboxLocalPart(addr)!)).toBe(true);
  });
});
