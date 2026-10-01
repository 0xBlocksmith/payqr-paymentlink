import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, stringToHex, type Hex } from "viem";
import { json, stubFetch } from "./helpers";

// relayerFeatures() remembers its answer for the page's life, so each test
// loads a fresh copy of the module.
async function load() {
  vi.resetModules();
  return import("../lib/paymentLinks");
}

const LINK = ("0x" + "ab".repeat(32)) as Hex;
const INR = stringToHex("INR", { size: 32 });

describe("fixedAmountTypedData", () => {
  it("hashes exactly as the relayer verifies it", async () => {
    const { fixedAmountTypedData } = await load();
    // Computed from payer-relayer's fixedPriceTypedData (src/fixedPrice.ts)
    // for the same chain, integrator, link, amount and currency. If this
    // changes, every fixed-price link created after it is refused.
    expect(hashTypedData(fixedAmountTypedData(84532, LINK, 10_000_000n, INR))).toBe(
      "0x2a022c466b1a4150c3bdd06d3e54476c0de6cde053f4af1a46c93c5e9b031696"
    );
  });
});

describe("fetchLinkPrice", () => {
  it("reads the price the relayer holds", async () => {
    const { fetchLinkPrice } = await load();
    const fetch = stubFetch(() => json({ amount6: "10000000", currency: INR.toUpperCase().replace("0X", "0x") }));
    expect(await fetchLinkPrice(LINK)).toEqual({ amount6: 10_000_000n, currency: INR });
    // The configured URL's trailing slash is dropped.
    expect(fetch).toHaveBeenCalledWith(`https://relayer.test/api/links/${LINK}/price`);
  });

  it("returns null for a link with no fixed price", async () => {
    const { fetchLinkPrice } = await load();
    stubFetch(() => json({ error: "Not found" }, 404));
    expect(await fetchLinkPrice(LINK)).toBeNull();
  });

  it("throws, never falls back to open amount, when the price can't be read", async () => {
    const { fetchLinkPrice } = await load();
    stubFetch(() => json({ error: "Too many requests" }, 429));
    await expect(fetchLinkPrice(LINK)).rejects.toThrow("Too many requests");

    stubFetch(() => new Response("bad gateway", { status: 502 }));
    await expect(fetchLinkPrice(LINK)).rejects.toThrow("Could not load this link's price");

    stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchLinkPrice(LINK)).rejects.toThrow();
  });

  it.each([
    { amount6: "0", currency: INR },
    { amount6: "-5", currency: INR },
    { amount6: 10000000, currency: INR },
    { amount6: "10000000", currency: "INR" },
    {},
  ])("rejects a malformed answer %#", async (body) => {
    const { fetchLinkPrice } = await load();
    stubFetch(() => json(body));
    await expect(fetchLinkPrice(LINK)).rejects.toThrow("Could not load this link's price");
  });
});

describe("relayerFeatures", () => {
  it("lists what /health reports, asking once", async () => {
    const { relayerFeatures } = await load();
    const fetch = stubFetch(() => json({ ok: true, features: ["fixed-price", "fiat-amount", "idempotency"] }));
    expect([...(await relayerFeatures())]).toEqual(["fixed-price", "fiat-amount", "idempotency"]);
    await relayerFeatures();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is empty for a relayer that predates features", async () => {
    const { relayerFeatures } = await load();
    stubFetch(() => json({ ok: true }));
    expect((await relayerFeatures()).size).toBe(0);
  });

  it("asks again after a failed read", async () => {
    const { relayerFeatures } = await load();
    const fetch = stubFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    expect((await relayerFeatures()).size).toBe(0);
    fetch.mockImplementation(async () => json({ features: ["fixed-price"] }));
    expect((await relayerFeatures()).has("fixed-price")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("attemptKeyFor", () => {
  it("gives the same key for the same link and amount, across a reload", async () => {
    const { attemptKeyFor } = await load();
    const key = attemptKeyFor(LINK, 10_000_000n);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(attemptKeyFor(LINK.toUpperCase().replace("0X", "0x"), 10_000_000n)).toBe(key);
  });

  it("gives a new key for a different amount", async () => {
    const { attemptKeyFor } = await load();
    const key = attemptKeyFor(LINK, 10_000_000n);
    expect(attemptKeyFor(LINK, 20_000_000n)).not.toBe(key);
  });

  it("gives a new key once the attempt is settled", async () => {
    const { attemptKeyFor, clearAttempt } = await load();
    const key = attemptKeyFor(LINK, 10_000_000n);
    clearAttempt(LINK);
    expect(attemptKeyFor(LINK, 10_000_000n)).not.toBe(key);
  });

  it("gives a new key after ten minutes", async () => {
    const { attemptKeyFor } = await load();
    vi.useFakeTimers();
    const key = attemptKeyFor(LINK, 10_000_000n);
    vi.advanceTimersByTime(9 * 60 * 1000);
    expect(attemptKeyFor(LINK, 10_000_000n)).toBe(key);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(attemptKeyFor(LINK, 10_000_000n)).not.toBe(key);
  });

  it("survives unreadable or missing storage", async () => {
    const { attemptKeyFor } = await load();
    localStorage.setItem(`payqr.linkAttempt:${LINK}`, "{not json");
    expect(attemptKeyFor(LINK, 1n)).toMatch(/^[0-9a-f]{32}$/);
    vi.stubGlobal("localStorage", undefined);
    expect(attemptKeyFor(LINK, 1n)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("provisionLinkWallet", () => {
  const ACCOUNT = "0x3333333333333333333333333333333333333333";
  const PRICE = { amount6: 10_000_000n, currency: INR, signature: "0x5678" as Hex };

  async function provision(answer: Record<string, unknown>, fixedPrice?: typeof PRICE) {
    const { provisionLinkWallet } = await load();
    const fetch = stubFetch(() => json(answer));
    const result = provisionLinkWallet({
      linkId: LINK,
      chainId: 84532,
      signTypedData: async () => "0x1234",
      signerAddress: "0x4444444444444444444444444444444444444444",
      fixedPrice,
    });
    return { result, fetch };
  }

  it("sends the signed price", async () => {
    const { result, fetch } = await provision({ linkId: LINK, account: ACCOUNT, existing: false, fixedPrice: true }, PRICE);
    await expect(result).resolves.toEqual({ linkId: LINK, account: ACCOUNT, existing: false });
    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.fixedPrice).toEqual({ amount6: "10000000", currency: INR, signature: "0x5678" });
  });

  it("stops before the link goes live when the relayer didn't keep the price", async () => {
    const { result } = await provision({ linkId: LINK, account: ACCOUNT, existing: false }, PRICE);
    await expect(result).rejects.toThrow("couldn't save this link's price");
  });

  it("sends no price for an open-amount link", async () => {
    const { result, fetch } = await provision({ linkId: LINK, account: ACCOUNT, existing: true });
    await expect(result).resolves.toMatchObject({ existing: true });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty("fixedPrice");
  });

  it("shows the relayer's error", async () => {
    const { provisionLinkWallet } = await load();
    stubFetch(() => json({ error: "Not authorised" }, 403));
    await expect(
      provisionLinkWallet({
        linkId: LINK,
        chainId: 84532,
        signTypedData: async () => "0x1234",
        signerAddress: "0x4444444444444444444444444444444444444444",
      })
    ).rejects.toThrow("Not authorised");
  });
});
