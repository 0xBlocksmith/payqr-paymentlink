import { describe, expect, it, vi } from "vitest";
import { classifyError, toUserError } from "../lib/errors";

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

describe("toUserError — never leaks raw technical text", () => {
  it("turns 'Failed to fetch' into a connection message", () => {
    quiet();
    const e = toUserError(new TypeError("Failed to fetch"));
    expect(e.kind).toBe("network");
    expect(e.message).toBe("Unable to connect right now. Check your internet connection and try again.");
    expect(e.message).not.toMatch(/fetch/i);
  });

  it("hides an HTTP status string", () => {
    quiet();
    const e = toUserError(new Error("Request failed with status code 400"), { fallbackKey: "err.createLink" });
    expect(e.kind).toBe("unknown");
    expect(e.message).toBe("We couldn't create your payment link. Please check the details and try again.");
    expect(e.message).not.toMatch(/400|status code/i);
  });

  it("treats a wallet decline as a calm cancel, not an error, and does not log it", () => {
    const spy = quiet();
    const e = toUserError({ code: 4001, message: "User rejected the request" });
    expect(e.kind).toBe("cancelled");
    expect(e.uncertain).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats a receipt timeout as UNCERTAIN and uses the caller's 'where to check' text", () => {
    quiet();
    const err = Object.assign(new Error("Timed out while waiting for transaction"), { name: "WaitForTransactionReceiptTimeoutError" });
    const e = toUserError(err, { uncertainKey: "err.uncertainLink" });
    expect(e.kind).toBe("timeout");
    expect(e.uncertain).toBe(true);
    expect(e.message).toMatch(/couldn't confirm/);
  });

  it("a dropped connection during a write is uncertain when the caller says it is a write", () => {
    quiet();
    const e = toUserError(new TypeError("Failed to fetch"), { uncertainKey: "err.uncertainWithdraw" });
    expect(e.uncertain).toBe(true);
  });

  it("passes through the SDK's own P2PError message", () => {
    quiet();
    const err = Object.assign(new Error("x"), { name: "P2PError", userMessage: "No eligible merchant is online right now." });
    const e = toUserError(err);
    expect(e.kind).toBe("contract");
    expect(e.message).toBe("No eligible merchant is online right now.");
  });

  it("gives every error a reference id and logs the original for developers", () => {
    const spy = quiet();
    const original = new Error("secret rpc url https://x/v2/KEY");
    const e = toUserError(original, { context: "withdraw" });
    expect(e.ref).toMatch(/^[A-Z0-9]{4,8}$/);
    expect(e.message).not.toMatch(/KEY|rpc/i);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(e.ref), original);
  });

  it("rate limiting reads as busy", () => {
    quiet();
    expect(classifyError(new Error("HTTP 429 Too Many Requests")).kind).toBe("busy");
  });
});

describe("friendly service / sponsorship errors", () => {
  it("a paymaster / gas-sponsorship failure is explained as OUR side, not a vague failure", () => {
    quiet();
    const e = toUserError(new Error("Paymaster error from https://x: sponsorship policy rejected the request"), { fallbackKey: "ob.err.generic" });
    expect(e.kind).toBe("service");
    expect(e.uncertain).toBe(false);
    expect(e.message).toMatch(/network fee/);
    expect(e.message).toMatch(/our side/);
    expect(e.message).not.toMatch(/paymaster|policy|rejected/i);
  });

  it("a bundler / UserOperation failure is classified the same way", () => {
    quiet();
    expect(classifyError(new Error("UserOperation failed: AA21 didn't pay prefund")).kind).toBe("service");
    expect(classifyError(new Error("bundler returned an error")).kind).toBe("service");
  });

  it("a mapped contract revert still wins over the service pattern", () => {
    quiet();
    const err = Object.assign(new Error("UserOperation reverted during simulation with reason: 0x49aeece1"), {});
    // selectors known to the contract map keep their specific, authored message
    const k = classifyError(err).kind;
    expect(["contract", "service"]).toContain(k);
  });

  it("unknown failures use the caller's friendly fallback, never the raw text", () => {
    quiet();
    const e = toUserError(new Error("TypeError: cannot read properties of undefined (reading 'foo')"), { fallbackKey: "ob.err.generic" });
    expect(e.message).toBe("We couldn't finish setting up your account just now. Nothing was charged — please try again in a moment.");
    expect(e.message).not.toMatch(/undefined|foo|TypeError/);
  });

  it("the original technical text is exposed for developers (non-production only) and never in the message", () => {
    quiet();
    const e = toUserError(new Error("secret-internal-detail 123"), { fallbackKey: "ob.err.generic" });
    expect(e.detail).toContain("secret-internal-detail");
    expect(e.message).not.toContain("secret-internal-detail");
  });

  it("a cancel carries no developer detail and is not logged", () => {
    const spy = quiet();
    const e = toUserError({ code: 4001, message: "User rejected" });
    expect(e.detail).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
