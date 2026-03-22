import { describe, expect, it } from "vitest";
import { FastTestHarness } from "./fast-harness.js";

describe("FastTestHarness", () => {
  it("returns exact-token responses deterministically", async () => {
    const harness = new FastTestHarness();
    await expect(harness.prompt("u1", "Reply with exactly this token and nothing else: TOKEN_123")).resolves.toBe("TOKEN_123");
  });

  it("preserves remembered secrets per user", async () => {
    const harness = new FastTestHarness();

    await expect(
      harness.prompt("user-a", "For this session, remember this exact secret token: SECRET_42. Reply with: stored."),
    ).resolves.toBe("stored.");

    await expect(
      harness.prompt("user-b", "What secret token did I ask you to remember earlier in this session? Reply with the token."),
    ).resolves.toBe("NO_SECRET");

    await expect(
      harness.prompt("user-a", "What secret token did I ask you to remember earlier in this session? Reply with the token."),
    ).resolves.toBe("SECRET_42");
  });

  it("streams deltas and done text", async () => {
    const harness = new FastTestHarness();
    const deltas: string[] = [];
    let done = "";

    await harness.promptStream(
      "u1",
      "Reply with exactly this token and nothing else: TOKEN_ABC",
      {
        onDelta: (delta) => deltas.push(delta),
        onDone: (text) => {
          done = text;
        },
      },
    );

    expect(deltas.join("")).toBe("TOKEN_ABC");
    expect(done).toBe("TOKEN_ABC");
  });
});
