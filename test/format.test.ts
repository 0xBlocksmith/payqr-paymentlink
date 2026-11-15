import { describe, expect, it } from "vitest";
import { estimateUnlock, fill, fmtLockWindow, fmtRemaining } from "../lib/format";

describe("fmtLockWindow — honest about the real size of the lock", () => {
  it("shows whole days as days (India: 15 days)", () => {
    expect(fmtLockWindow(1_296_000, "en")).toBe("15 days");
  });
  it("shows 36h as hours, NOT '2 days' (BRL/ARS/VEN)", () => {
    expect(fmtLockWindow(129_600, "en")).toBe("36 hours");
  });
  it("one day is singular", () => {
    expect(fmtLockWindow(86_400, "en")).toBe("1 day");
  });
  it("returns '' for unknown/zero so callers show 'unavailable' instead of a number", () => {
    expect(fmtLockWindow(null)).toBe("");
    expect(fmtLockWindow(undefined)).toBe("");
    expect(fmtLockWindow(0)).toBe("");
    expect(fmtLockWindow(0n)).toBe("");
  });
  it("accepts bigint from the contract", () => {
    expect(fmtLockWindow(1_296_000n, "en")).toBe("15 days");
  });
});

describe("fmtRemaining", () => {
  it("is empty (not the word 'ready') when nothing remains", () => {
    expect(fmtRemaining(0)).toBe("");
    expect(fmtRemaining(-5)).toBe("");
  });
  it("never reads '1 day' for a few minutes", () => {
    expect(fmtRemaining(300, "en")).toBe("5 minutes");
  });
  it("uses hours under two days", () => {
    expect(fmtRemaining(5 * 3600, "en")).toBe("5 hours");
    expect(fmtRemaining(36 * 3600, "en")).toBe("36 hours");
  });
  it("uses days from two days up", () => {
    expect(fmtRemaining(3 * 86400, "en")).toBe("3 days");
  });
});

describe("estimateUnlock", () => {
  it("adds the lock to completion time", () => {
    expect(estimateUnlock(1000, 500)).toBe(1500);
  });
  it("is null when either input is unknown — never invents a date", () => {
    expect(estimateUnlock(null, 500)).toBeNull();
    expect(estimateUnlock(1000, null)).toBeNull();
    expect(estimateUnlock(1000, 0)).toBeNull();
  });
});

describe("fill", () => {
  it("replaces placeholders and leaves unknown ones", () => {
    expect(fill("a {x} b {y}", { x: 1 })).toBe("a 1 b {y}");
  });
});
