import { describe, expect, it } from "vitest";
import { withdrawFailurePolicy as p } from "../lib/withdrawRetry";

describe("withdrawFailurePolicy — a retry never repeats a money move", () => {
  it("a timeout is unknown and offers no retry, whatever stage it hit", () => {
    expect(p({ uncertain: true, step1Confirmed: false, external: false })).toEqual({ status: "unknown", retry: undefined });
    expect(p({ uncertain: true, step1Confirmed: true, external: true })).toEqual({ status: "unknown", retry: undefined });
  });
  it("after step 1 confirmed, a failed forward retries ONLY the forward", () => {
    expect(p({ uncertain: false, step1Confirmed: true, external: true })).toEqual({ status: "error", retry: "forward" });
  });
  it("after step 1 confirmed to the merchant's own wallet there is nothing to retry", () => {
    expect(p({ uncertain: false, step1Confirmed: true, external: false })).toEqual({ status: "error", retry: undefined });
  });
  it("nothing confirmed and a definite failure may start over", () => {
    expect(p({ uncertain: false, step1Confirmed: false, external: true })).toEqual({ status: "error", retry: "whole" });
  });
});
