import { describe, expect, it } from "vitest";
import { stringToHex } from "viem";
import { fetchLinkOrders, fetchOrder } from "../lib/history";
import { json, stubFetch } from "./helpers";

const BRL = stringToHex("BRL", { size: 32 });
const PROXY = "0x5555555555555555555555555555555555555555";

function order(fields: Record<string, unknown>) {
  return {
    orderId: "42",
    type: 0,
    status: 3,
    currency: BRL,
    usdcAmount: "1000000",
    fiatAmount: "5500000",
    actualUsdcAmount: "0",
    actualFiatAmount: "0",
    userAddress: PROXY,
    placedAt: "1700000000",
    completedAt: "1700000300",
    transactionHash: "0xabc",
    ...fields,
  };
}

describe("fetchOrder (the receipt's source — review H1)", () => {
  it("takes the currency and kind from the chain", async () => {
    stubFetch(() => json({ data: { orders_collection: [order({})] } }));
    expect(await fetchOrder("42")).toMatchObject({ currency: "BRL", kind: "buy", fiatAmount: "5500000", status: "settled" });

    stubFetch(() => json({ data: { orders_collection: [order({ type: 1 })] } }));
    expect(await fetchOrder("42")).toMatchObject({ kind: "withdraw" });
  });

  it("prefers the settled amounts over the placed ones", async () => {
    stubFetch(() => json({ data: { orders_collection: [order({ actualFiatAmount: "5000000", actualUsdcAmount: "900000" })] } }));
    expect(await fetchOrder("42")).toMatchObject({ fiatAmount: "5000000", amount: "900000" });
  });

  it("never queries for an id that isn't a number", async () => {
    const fetch = stubFetch(() => json({}));
    expect(await fetchOrder("42 or 1=1")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null when the index is unreachable", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fetchOrder("42")).toBeNull();
  });
});

describe("fetchLinkOrders", () => {
  it("carries each link sale's currency and dispute status", async () => {
    stubFetch((_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes("b2Borders")) {
        return json({
          data: {
            b2Borders: [
              { orderId: "42", integrator: { id: "0x1111111111111111111111111111111111111111" } },
              { orderId: "43", integrator: { id: "0x1111111111111111111111111111111111111111" } },
              { orderId: "44", integrator: { id: "0x1111111111111111111111111111111111111111" } },
            ],
          },
        });
      }
      return json({
        data: {
          orders_collection: [
            order({ orderId: "44", disputeStatus: 2 }),
            order({ orderId: "43", disputeStatus: 1, status: 4 }),
            order({ orderId: "42", disputeStatus: 0 }),
          ],
        },
      });
    });
    const rows = await fetchLinkOrders(PROXY);
    expect(rows.map((r) => [r.orderId, r.currency, r.status, r.dispute])).toEqual([
      ["44", "BRL", "settled", "resolved"],
      ["43", "BRL", "cancelled", "open"],
      ["42", "BRL", "settled", "none"],
    ]);
  });
});
