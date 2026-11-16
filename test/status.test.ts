import { describe, expect, it } from "vitest";
import { resolveStatus } from "../lib/status";

const NOW = 1_000_000;
const LOCK_15D = 15 * 86400;

describe("resolveStatus — one vocabulary", () => {
  it("an order still matching is 'waiting', never 'locked'", () => {
    expect(resolveStatus({ status: "matching" }, LOCK_15D, NOW).key).toBe("waiting");
  });

  it("a settled sale inside the hold is received + has an unlock date", () => {
    const s = resolveStatus({ status: "settled", completedAt: NOW - 100 }, LOCK_15D, NOW);
    expect(s.key).toBe("received_locked");
    expect(s.unlockAt).toBe(NOW - 100 + LOCK_15D);
    expect(s.estimated).toBe(true);
    expect(s.labelKey).toBe("status.receivedOn");
  });

  it("a settled sale past its unlock is 'available'", () => {
    const s = resolveStatus({ status: "settled", completedAt: NOW - LOCK_15D - 5 }, LOCK_15D, NOW);
    expect(s.key).toBe("available");
  });

  it("prefers the real on-chain unlock time over the estimate", () => {
    const s = resolveStatus({ status: "settled", completedAt: 1, unlockAt: NOW + 50 }, LOCK_15D, NOW);
    expect(s.key).toBe("received_locked");
    expect(s.unlockAt).toBe(NOW + 50);
    expect(s.estimated).toBe(false);
  });

  it("never invents a date when the lock period is unknown", () => {
    const s = resolveStatus({ status: "settled", completedAt: NOW - 10 }, null, NOW);
    expect(s.key).toBe("received_unknown");
    expect(s.unlockAt).toBeNull();
  });

  it("never invents a date when completion time is unknown", () => {
    expect(resolveStatus({ status: "settled", completedAt: null }, LOCK_15D, NOW).key).toBe("received_unknown");
  });

  it("cancelled stays cancelled", () => {
    expect(resolveStatus({ status: "cancelled" }, LOCK_15D, NOW).key).toBe("cancelled");
  });

  it("maps every withdrawal state", () => {
    expect(resolveStatus({ status: "withdrawn", kind: "withdraw" }, null, NOW).key).toBe("withdrawn");
    expect(resolveStatus({ status: "processing", kind: "usdc_withdraw" }, null, NOW).key).toBe("wd_processing");
    expect(resolveStatus({ status: "partial", kind: "usdc_withdraw" }, null, NOW).key).toBe("wd_partial");
    expect(resolveStatus({ status: "failed", kind: "usdc_withdraw" }, null, NOW).key).toBe("wd_failed");
  });

  it("a short (36h) lock produces an unlock 36h out", () => {
    const s = resolveStatus({ status: "settled", completedAt: NOW }, 129_600, NOW);
    expect(s.unlockAt).toBe(NOW + 129_600);
  });
});
