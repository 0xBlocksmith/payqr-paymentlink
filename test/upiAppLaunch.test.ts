import { describe, expect, it, vi } from "vitest";
import { UPI_OPEN_URL, openUpiChooser } from "../lib/upiAppLaunch";

describe("openUpiChooser", () => {
  it("only ever navigates to the bare upi:// scheme", async () => {
    expect(UPI_OPEN_URL).toBe("upi://");
    const navigate = vi.fn();
    await openUpiChooser({ navigate, waitForLeave: async () => true });
    expect(navigate).toHaveBeenCalledWith("upi://");
  });
  it("reports likely-opened when the page is left", async () => {
    expect(await openUpiChooser({ navigate: vi.fn(), waitForLeave: async () => true })).toBe("likely-opened");
  });
  it("reports no-effect when the page stays in the foreground", async () => {
    expect(await openUpiChooser({ navigate: vi.fn(), waitForLeave: async () => false })).toBe("no-effect");
  });
  it("reports no-effect if navigation throws", async () => {
    const navigate = () => { throw new Error("blocked"); };
    expect(await openUpiChooser({ navigate, waitForLeave: async () => false })).toBe("no-effect");
  });
});
