import { describe, expect, it } from "vitest";
import { clearPendingLink, loadPendingLink, PENDING_LINK_TTL_MS, savePendingLink } from "../lib/pendingLink";
import { toUserError, ValidationError } from "../lib/errors";
import { vi } from "vitest";

const A = "0xAbC0000000000000000000000000000000000001";
const B = "0xAbC0000000000000000000000000000000000002";

describe("pending link record", () => {
  it("survives between save and load, scoped per wallet", () => {
    savePendingLink(A, { linkId: "0x01", url: "https://x/1", at: Date.now() });
    expect(loadPendingLink(A)?.linkId).toBe("0x01");
    expect(loadPendingLink(B)).toBeNull();
  });
  it("is cleared explicitly", () => {
    savePendingLink(A, { linkId: "0x01", url: "u", at: Date.now() });
    clearPendingLink(A);
    expect(loadPendingLink(A)).toBeNull();
  });
  it("expires after a day instead of blocking the merchant forever", () => {
    const t0 = 1_000_000;
    savePendingLink(A, { linkId: "0x01", url: "u", at: t0 });
    expect(loadPendingLink(A, t0 + PENDING_LINK_TTL_MS - 1)).not.toBeNull();
    expect(loadPendingLink(A, t0 + PENDING_LINK_TTL_MS + 1)).toBeNull();
  });
  it("ignores a missing address", () => {
    savePendingLink(undefined, { linkId: "0x01", url: "u", at: Date.now() });
    expect(loadPendingLink(undefined)).toBeNull();
  });
});

describe("ValidationError", () => {
  it("passes our own authored validation text through (never replaced by a generic fallback)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const e = toUserError(new ValidationError("That amount is too small."), { fallbackKey: "err.createLink" });
    expect(e.message).toBe("That amount is too small.");
    expect(e.uncertain).toBe(false);
  });
});
