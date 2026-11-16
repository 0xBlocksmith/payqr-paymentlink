import { describe, expect, it } from "vitest";
import { computeSetup, payoutIsSet, setupDismissed, dismissSetup } from "../lib/setup";

const base = { tourSeen: false, registered: false as boolean | undefined, payoutBlob: "0x", hasFirstSaleOrLink: false, receivedCount: 0 };

describe("computeSetup", () => {
  it("a brand-new merchant has nothing done and 'learn' is next", () => {
    const r = computeSetup(base);
    expect(r.doneCount).toBe(0);
    expect(r.next).toBe("learn");
    expect(r.complete).toBe(false);
  });

  it("unknown registration (still loading) is not 'registered'", () => {
    expect(computeSetup({ ...base, registered: undefined }).steps.find((s) => s.id === "register")!.done).toBe(false);
  });

  it("walks to the next outstanding step", () => {
    const r = computeSetup({ ...base, tourSeen: true, registered: true });
    expect(r.next).toBe("first");
    expect(r.doneCount).toBe(2);
  });

  it("is complete only when every step is done", () => {
    const r = computeSetup({ tourSeen: true, registered: true, payoutBlob: "0x1234", hasFirstSaleOrLink: true, receivedCount: 2 });
    expect(r.complete).toBe(true);
    expect(r.next).toBeNull();
  });

  it("an empty payout blob is unset", () => {
    expect(payoutIsSet("0x")).toBe(false);
    expect(payoutIsSet("")).toBe(false);
    expect(payoutIsSet(undefined)).toBe(false);
    expect(payoutIsSet("0xdead")).toBe(true);
  });
});

describe("dismissal", () => {
  it("is remembered per wallet", () => {
    expect(setupDismissed("0xa")).toBe(false);
    dismissSetup("0xa");
    expect(setupDismissed("0xa")).toBe(true);
    expect(setupDismissed("0xb")).toBe(false);
  });
});
