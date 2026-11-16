import { describe, expect, it } from "vitest";
import { fetchHistory } from "../lib/history";
import { json, stubFetch } from "./helpers";

const ME = "0x1234567890123456789012345678901234567890";
const order = (id: string) => ({
  orderId: id, status: 3, usdcAmount: "1000000", placedAt: "1700000000", completedAt: "1700000300",
  transactionHash: "0xabc", userAddress: ME, disputeStatus: 0, currency: null,
});
const scopeOf = (ids: string[]) => ({ b2Borders: ids.map((orderId) => ({ orderId, integrator: { id: "0x1111" } })) });

/** Answers by which query was asked; records the order of requests. */
function subgraph(opts: { scope: string[] | "fail"; newest: string[]; byIds?: string[] }) {
  const asked: string[] = [];
  stubFetch(async (_url, init) => {
    const q = String(JSON.parse(String(init?.body || "{}")).query || "");
    if (q.includes("b2Borders")) {
      asked.push("scope");
      if (opts.scope === "fail") return json({ errors: [{ message: "down" }] }, 500);
      return json({ data: scopeOf(opts.scope) });
    }
    if (q.includes("orderId_in")) { asked.push("byIds"); return json({ data: { orders_collection: (opts.byIds ?? []).map(order) } }); }
    asked.push("newest");
    return json({ data: { orders_collection: opts.newest.map(order) } });
  });
  return asked;
}

describe("fetchHistory — one round trip, same result", () => {
  it("asks for the scope and the newest orders together, then keeps only PayQR orders", async () => {
    const asked = subgraph({ scope: ["3", "1"], newest: ["4", "3", "2", "1"] });
    const rows = await fetchHistory(ME);
    expect(rows.map((r) => r.orderId)).toEqual(["3", "1"]);   // "4" and "2" belong to another app
    expect(asked.sort()).toEqual(["newest", "scope"]);         // no third, sequential query
  });

  it("falls back to the explicit id query only when a full page crowded scoped orders out", async () => {
    const full = Array.from({ length: 200 }, (_, i) => String(1000 - i)); // 200 other-app orders
    const asked = subgraph({ scope: ["5"], newest: full, byIds: ["5"] });
    const rows = await fetchHistory(ME);
    expect(rows.map((r) => r.orderId)).toEqual(["5"]);
    expect(asked).toContain("byIds");
  });

  it("never returns unscoped orders when the scope query fails", async () => {
    subgraph({ scope: "fail", newest: ["9"] });
    await expect(fetchHistory(ME)).rejects.toThrow();
  });

  it("an empty scope is an empty history", async () => {
    subgraph({ scope: [], newest: ["9"] });
    expect(await fetchHistory(ME)).toEqual([]);
  });
});
