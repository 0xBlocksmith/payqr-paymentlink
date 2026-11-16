import { describe, expect, it } from "vitest";
import { FLOW_T, FLOW_STILL, flowFrame } from "../lib/flowDemo";
import { fmtCountdown } from "../lib/format";

describe("flowFrame — the illustrative journey", () => {
  it("starts with nothing in motion and the full period remaining", () => {
    const f = flowFrame(0);
    expect(f.payP).toBe(0);
    expect(f.remaining).toBe(1);
    expect(f.unlocked).toBe(false);
    expect(f.coinOpacity).toBe(0);
  });

  it("the local payment reaches the contract before the countdown starts", () => {
    expect(flowFrame(2.4).payP).toBeCloseTo(1, 5);
    expect(flowFrame(2.0).remaining).toBe(1);
    expect(flowFrame(3.0).remaining).toBeLessThan(1);
  });

  it("the countdown runs down to zero, then unlocks, then USDC moves out", () => {
    expect(flowFrame(4.8).remaining).toBeCloseTo(0.5, 5);
    expect(flowFrame(6.7).unlocked).toBe(false);
    expect(flowFrame(6.9).unlocked).toBe(true);
    expect(flowFrame(6.9).remaining).toBe(0);
    expect(flowFrame(6.9).coinOpacity).toBe(0);      // not released before the unlock finishes
    expect(flowFrame(8.1).coinOpacity).toBe(1);
    expect(flowFrame(9.0).coinP).toBeCloseTo(1, 5);
  });

  it("USDC is never visible while the countdown is still running", () => {
    for (let t = 0; t < 6.8; t += 0.1) expect(flowFrame(t).coinOpacity).toBe(0);
  });

  it("loops seamlessly and tolerates any time value", () => {
    expect(flowFrame(FLOW_T + 3.3)).toEqual(flowFrame(3.3));
    expect(flowFrame(-1)).toEqual(flowFrame(FLOW_T - 1));
  });

  it("every value stays in range across the whole loop", () => {
    for (let t = 0; t <= FLOW_T; t += 0.05) {
      const f = flowFrame(t);
      for (const v of [f.payP, f.payOpacity, f.remaining, f.coinP, f.coinOpacity, f.arrive, f.glow]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("the reduced-motion frame is a still, full-period state", () => {
    expect(FLOW_STILL.remaining).toBe(1);
    expect(FLOW_STILL.payOpacity).toBe(0);
    expect(FLOW_STILL.coinOpacity).toBe(0);
  });
});

describe("fmtCountdown", () => {
  it("formats days + hh:mm:ss", () => {
    expect(fmtCountdown(15 * 86400, true)).toBe("15d 00:00:00");
    expect(fmtCountdown(15 * 86400 - 1, true)).toBe("14d 23:59:59");
  });
  it("formats total hours for short periods", () => {
    expect(fmtCountdown(36 * 3600, false)).toBe("36:00:00");
    expect(fmtCountdown(36 * 3600 - 61, false)).toBe("35:58:59");
  });
  it("never goes negative or NaN", () => {
    expect(fmtCountdown(-5, true)).toBe("0d 00:00:00");
    expect(fmtCountdown(NaN, false)).toBe("00:00:00");
  });
});
