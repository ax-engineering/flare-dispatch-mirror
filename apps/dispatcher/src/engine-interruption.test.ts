import { Exit } from "effect";
import { ExecFailed, StepFailed } from "@fractalboxdev/flare-dispatch-core";
import { describe, expect, it } from "vitest";
import { isEngineInterruption } from "./engine-interruption";

const inactive =
  "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.";

describe("isEngineInterruption", () => {
  it("names a step rejection the engine raised when its instance connection closed", () => {
    expect(
      isEngineInterruption(
        Exit.fail(new StepFailed({ step: "exec-start", cause: new Error(inactive) })),
      ),
    ).toBe(true);
  });

  it("names the same rejection when a raw durable step dies with it", () => {
    expect(isEngineInterruption(Exit.die(new Error(inactive)))).toBe(true);
    expect(
      isEngineInterruption(
        Exit.die(new Error("Durable Object reset because its code was updated.")),
      ),
    ).toBe(true);
  });

  it("leaves every other step failure a verdict", () => {
    expect(
      isEngineInterruption(
        Exit.fail(new StepFailed({ step: "exec", cause: new Error("Execution timed out") })),
      ),
    ).toBe(false);
    expect(isEngineInterruption(Exit.die(new Error("boom")))).toBe(false);
  });

  it("leaves a run-body failure that quotes the message a verdict", () => {
    expect(
      isEngineInterruption(Exit.fail(new ExecFailed({ exitCode: -1, stderrTail: inactive }))),
    ).toBe(false);
    expect(isEngineInterruption(Exit.succeed({ ok: true }))).toBe(false);
  });
});
