import { describe, expect, it, vi } from "vitest";

/**
 * Only "nobody can take this payment" may refuse a payment.
 *
 * placeOrder.prepare wraps EVERY circle-selection failure in the single code
 * CIRCLE_SELECTION_FAILED, so reading that code alone made a subgraph hiccup
 * indistinguishable from an empty partner list — and the pay page answered
 * both with "Payments are busy right now" (review item 1). The code that says
 * which is which is on the wrapped cause.
 */

const PROXY = "0x4444444444444444444444444444444444444444" as const;

/** An SDK-shaped failure: the outer OrdersError with its wrapped cause. */
function err(cause: { code: string }) {
  return {
    isErr: () => true,
    error: { code: "CIRCLE_SELECTION_FAILED", message: "Circle selection failed", cause },
  };
}

function ok(circleId: bigint) {
  return { isErr: () => false, value: { meta: { circleId } } };
}

async function routeWith(prepared: unknown) {
  vi.resetModules();
  const prepare = vi.fn(async () => prepared);
  vi.doMock("@p2pdotme/sdk/orders", () => ({
    createOrders: () => ({ placeOrder: { prepare } }),
  }));
  vi.doMock("../lib/customerRelayIdentity", () => ({
    customerRelayStore: async () => ({}),
    getCustomerSigner: async () => ({}),
    getCustomerIdentity: async () => ({}),
  }));
  const { routeLinkCircle } = await import("../lib/customerOrder");
  const result = await routeLinkCircle({
    currency: "INR",
    usdcAmount: 1_000000n,
    fiatAmount: 10_000000n,
    user: PROXY,
  });
  return { result, prepare };
}

describe("routeLinkCircle", () => {
  it("returns the circle the SDK picked", async () => {
    const { result, prepare } = await routeWith(ok(7n));
    expect(result).toBe(7n);
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("refuses only when there is genuinely no eligible circle", async () => {
    const { result } = await routeWith(err({ code: "NO_ELIGIBLE_CIRCLES" }));
    expect(result).toBe("none");
  });

  it.each([
    "SUBGRAPH_REQUEST_FAILED",
    "SUBGRAPH_VALIDATION_FAILED",
    "CONTRACT_READ_FAILED",
    "VALIDATION_ERROR",
    "TRANSPORT_ERROR",
  ])("falls back instead of refusing when routing itself failed (%s)", async (code) => {
    const { result } = await routeWith(err({ code }));
    expect(result).toBeNull();
  });

  it("falls back when the failure carries no cause at all", async () => {
    const { result } = await routeWith({
      isErr: () => true,
      error: { code: "CIRCLE_SELECTION_FAILED", message: "Circle selection failed" },
    });
    expect(result).toBeNull();
  });

  it("falls back when prepare throws", async () => {
    vi.resetModules();
    vi.doMock("@p2pdotme/sdk/orders", () => ({
      createOrders: () => ({
        placeOrder: {
          prepare: async () => {
            throw new Error("network");
          },
        },
      }),
    }));
    vi.doMock("../lib/customerRelayIdentity", () => ({
      customerRelayStore: async () => ({}),
      getCustomerSigner: async () => ({}),
      getCustomerIdentity: async () => ({}),
    }));
    const { routeLinkCircle } = await import("../lib/customerOrder");
    expect(
      await routeLinkCircle({ currency: "INR", usdcAmount: 1n, fiatAmount: 1n, user: PROXY })
    ).toBeNull();
  });
});
