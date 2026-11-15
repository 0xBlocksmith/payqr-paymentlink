import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, encodeAbiParameters, parseAbi } from "viem";
import { makePlaceOrder, loadPendingOrder, savePendingOrder, clearPendingOrder } from "../lib/p2p";
import { toUserError } from "../lib/errors";

// lib/p2p guards storage access with `typeof window` (SSR); Node has no window.
beforeEach(() => { vi.stubGlobal("window", globalThis); });

const A = "0xabc0000000000000000000000000000000000001";
const B = "0xabc0000000000000000000000000000000000002";
const HASH = "0x" + "ab".repeat(32);

const ctx = { currency: { circleId: 2n, symbol: "BRL" } };
const getIdentity = async () => ({ publicKey: "11".repeat(64) });

function signerFor(address = A) {
  const sendTransaction = vi.fn(async () => ({ hash: HASH }));
  return { address, sendTransaction };
}

describe("makePlaceOrder — a submitted order is never reported as a plain failure", () => {
  it("receipt timeout → OrderUncertainError, and an uncertain record is saved for THIS wallet", async () => {
    const signer = signerFor();
    const timeout = Object.assign(new Error("Timed out"), { name: "WaitForTransactionReceiptTimeoutError" });
    const publicClient = { waitForTransactionReceipt: vi.fn(async () => { throw timeout; }) };
    const place = makePlaceOrder({ signer, publicClient, quantity: 5_000_000n, getIdentity });

    await expect(place(ctx)).rejects.toMatchObject({ name: "OrderUncertainError", txHash: HASH });
    expect(signer.sendTransaction).toHaveBeenCalledTimes(1); // never re-sent

    const rec = loadPendingOrder(A);
    expect(rec).toMatchObject({ uncertain: true, orderId: "", txHash: HASH, currency: "BRL", usdc: 5 });
    expect(loadPendingOrder(B)).toBeNull(); // another wallet on the same device sees nothing
  });

  it("mined but no OrderPlaced event → uncertain (the order EXISTS), not 'try again'", async () => {
    const signer = signerFor();
    const publicClient = { waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })) };
    const place = makePlaceOrder({ signer, publicClient, quantity: 1_000_000n, getIdentity });

    const err: any = await place(ctx).catch((e) => e);
    expect(err.name).toBe("OrderUncertainError");
    expect(loadPendingOrder(A)?.uncertain).toBe(true);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const ue = toUserError(err, { uncertainKey: "err.uncertainOrder", fallbackKey: "err.order" });
    expect(ue.uncertain).toBe(true);
    expect(ue.message).toMatch(/couldn't confirm whether this payment was placed/);
    expect(ue.message).not.toMatch(/try again\.?$/i);
  });

  it("a REVERTED order tx placed nothing → plain failure and NO pending record", async () => {
    const signer = signerFor();
    const publicClient = { waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted", logs: [] })) };
    const place = makePlaceOrder({ signer, publicClient, quantity: 1_000_000n, getIdentity });

    const err: any = await place(ctx).catch((e) => e);
    expect(err.name).not.toBe("OrderUncertainError");
    expect(loadPendingOrder(A)).toBeNull();
  });

  it("no circle for the currency → names that currency (not 'INR') and sends nothing", async () => {
    const signer = signerFor();
    const publicClient = { waitForTransactionReceipt: vi.fn() };
    const place = makePlaceOrder({ signer, publicClient, quantity: 1_000_000n, getIdentity });

    const err: any = await place({ currency: { symbol: "ARS" } }).catch((e) => e);
    expect(err.name).toBe("UnsupportedCurrencyError");
    expect(err.message).toContain("ARS");
    expect(err.message).not.toContain("INR");
    expect(signer.sendTransaction).not.toHaveBeenCalled();

    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(toUserError(err).message).toBe("ARS payments aren't available right now. Please choose another currency.");
  });

  it("a successful order decodes the id and leaves no uncertain record", async () => {
    const abi = parseAbi(["event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount)"]);
    const topics = encodeEventTopics({ abi, eventName: "OrderPlaced", args: { orderId: 77n, user: A as `0x${string}` } });
    const data = encodeAbiParameters([{ type: "uint256" }], [5_000_000n]);
    const signer = signerFor();
    const publicClient = { waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [{ topics, data }] })) };
    const place = makePlaceOrder({ signer, publicClient, quantity: 5_000_000n, getIdentity });

    await expect(place(ctx)).resolves.toEqual({ orderId: "77", txHash: HASH });
    expect(loadPendingOrder(A)).toBeNull();
  });
});

describe("pending order storage is per wallet", () => {
  const rec = { orderId: "9", fiat: 10, usdc: 1, countryId: "india", shopLabel: "s", savedAt: 1 };

  it("one merchant never sees another's order on a shared device", () => {
    savePendingOrder(rec, A);
    expect(loadPendingOrder(A)?.orderId).toBe("9");
    expect(loadPendingOrder(B)).toBeNull();
  });

  it("is a no-op without an address (never writes an unscoped record)", () => {
    savePendingOrder(rec, undefined);
    expect(loadPendingOrder(undefined)).toBeNull();
  });

  it("ignores and removes the legacy un-scoped key", () => {
    localStorage.setItem("payqr.pendingOrder", JSON.stringify(rec));
    expect(loadPendingOrder(A)).toBeNull();
    expect(localStorage.getItem("payqr.pendingOrder")).toBeNull();
  });

  it("clear only affects the given wallet", () => {
    savePendingOrder(rec, A); savePendingOrder(rec, B);
    clearPendingOrder(A);
    expect(loadPendingOrder(A)).toBeNull();
    expect(loadPendingOrder(B)?.orderId).toBe("9");
  });
});
