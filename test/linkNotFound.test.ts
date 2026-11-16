import { describe, expect, it } from "vitest";
import { isLinkNotFound } from "../lib/paymentLinks";

describe("isLinkNotFound", () => {
  it("recognises a decoded LinkNotFound revert (viem)", () => {
    expect(isLinkNotFound({ cause: { data: { errorName: "LinkNotFound" } } })).toBe(true);
  });
  it("recognises the raw selector and the error name in the message", () => {
    expect(isLinkNotFound(new Error("execution reverted: 0x3b82cbf1"))).toBe(true);
    expect(isLinkNotFound({ shortMessage: "The contract function reverted: LinkNotFound()" })).toBe(true);
  });
  it("is false for a network failure or an unrelated revert", () => {
    expect(isLinkNotFound(new Error("Failed to fetch"))).toBe(false);
    expect(isLinkNotFound({ cause: { data: { errorName: "LinkExpired" } } })).toBe(false);
    expect(isLinkNotFound(undefined)).toBe(false);
  });
  it("does not loop on a cyclic cause chain", () => {
    const a: any = { message: "x" }; a.cause = a;
    expect(isLinkNotFound(a)).toBe(false);
  });
});
