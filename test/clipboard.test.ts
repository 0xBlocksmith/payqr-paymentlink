import { describe, expect, it, vi } from "vitest";
import { copyText } from "../lib/clipboard";

describe("copyText", () => {
  it("uses the async clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText("a@upi", { clipboard: { writeText }, isSecureContext: true })).toEqual({ ok: true, method: "clipboard-api" });
    expect(writeText).toHaveBeenCalledWith("a@upi");
  });
  it("falls back to the legacy path when the API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowed"));
    const legacyCopy = vi.fn().mockReturnValue(true);
    expect(await copyText("12.50", { clipboard: { writeText }, isSecureContext: true, legacyCopy })).toEqual({ ok: true, method: "exec-command" });
  });
  it("reports failure instead of throwing", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowed"));
    expect(await copyText("x", { clipboard: { writeText }, isSecureContext: true })).toEqual({ ok: false, reason: "denied" });
    expect(await copyText("x", {})).toEqual({ ok: false, reason: "unsupported" });
    expect(await copyText("", {})).toEqual({ ok: false, reason: "empty" });
  });
});
