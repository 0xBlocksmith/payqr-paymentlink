import { describe, expect, it } from "vitest";
import { sha256 } from "viem";
import { solveHumanCheck } from "../components/HumanCheck";
import { json, stubFetch } from "./helpers";

describe("solveHumanCheck", () => {
  it("finds a nonce the relayer will accept", async () => {
    stubFetch(() => json({ enabled: true, challenge: "abc.123.sig", difficulty: 12 }));
    const solution = (await solveHumanCheck())!;
    expect(solution.challenge).toBe("abc.123.sig");
    // At least 12 leading zero bits: the first byte is 0, the second below 16.
    const digest = sha256(new TextEncoder().encode(`${solution.challenge}.${solution.nonce}`), "bytes");
    expect(digest[0]).toBe(0);
    expect(digest[1]).toBeLessThan(16);
  });

  it("sends nothing when the gate is off", async () => {
    stubFetch(() => json({ enabled: false }));
    expect(await solveHumanCheck()).toBeNull();
  });

  it("says the service is busy instead of grinding a phone for minutes", async () => {
    stubFetch(() => json({ enabled: true, challenge: "abc", difficulty: 21 }));
    await expect(solveHumanCheck()).rejects.toThrow("very busy");
  });

  it("fails loudly when the challenge can't be fetched", async () => {
    stubFetch(() => json({ error: "down" }, 503));
    await expect(solveHumanCheck()).rejects.toThrow("Could not start the payment");
  });
});
