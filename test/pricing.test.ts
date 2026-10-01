import { describe, expect, it } from "vitest";
import { fiatForUsdc, minimumFiat, minimumUsdc, usdcForFiat, usdcForUsdcTarget, type PriceConfig } from "../lib/pricing";

// ₹85 per USDC; orders up to 5 USDC pay a 0.1 USDC fee.
const INR: PriceConfig = {
  buyPrice: 85_000_000n,
  sellPrice: 84_000_000n,
  smallOrderThreshold: 5_000_000n,
  smallOrderFixedFee: 100_000n,
};
const NO_FEE: PriceConfig = { ...INR, smallOrderFixedFee: 0n };

describe("usdcForFiat → fiatForUsdc", () => {
  // The customer must pay what the merchant typed, below and above the
  // small-order threshold (5 USDC ≈ ₹425 here).
  it.each([10, 20, 99.99, 424, 426, 500, 10_000])("₹%s round-trips to within ₹0.0001", (quote) => {
    const usdc = usdcForFiat(quote, INR);
    expect(usdc).toBeGreaterThan(0n);
    expect(Math.abs(fiatForUsdc(usdc, INR) - quote)).toBeLessThan(0.0001);
  });

  it("takes the fee out of a small order", () => {
    // ₹10 = 117647 gross units, less the 100000 fee.
    expect(usdcForFiat(10, INR)).toBe(17_647n);
  });

  it("charges no fee above the threshold", () => {
    expect(usdcForFiat(1000, INR)).toBe(11_764_705n);
  });

  it("refuses a quote equal to the fee — it would charge about twice the quote", () => {
    expect(usdcForFiat(8.5, INR)).toBe(0n);
  });

  it("refuses zero and negative quotes", () => {
    expect(usdcForFiat(0, INR)).toBe(0n);
    expect(usdcForFiat(-5, INR)).toBe(0n);
  });
});

describe("minimum amounts", () => {
  it("minimumFiat is the exact boundary", () => {
    const min = minimumFiat(INR);
    expect(min).toBe(8.500085);
    expect(usdcForFiat(min, INR)).toBeGreaterThan(0n);
    expect(usdcForFiat(min - 0.000001, INR)).toBe(0n);
  });

  it("minimumUsdc is one unit above the fee", () => {
    expect(minimumUsdc(INR)).toBe(0.100001);
  });

  it("there is no minimum without a fee", () => {
    expect(minimumFiat(NO_FEE)).toBe(0);
    expect(minimumUsdc(NO_FEE)).toBe(0);
  });
});

describe("usdcForUsdcTarget", () => {
  it("total charged equals the USDC typed", () => {
    const principal = usdcForUsdcTarget(1, INR);
    expect(principal).toBe(900_000n);
    expect(principal + INR.smallOrderFixedFee).toBe(1_000_000n);
  });

  it("keeps the full amount above the threshold", () => {
    expect(usdcForUsdcTarget(10, INR)).toBe(10_000_000n);
  });
});
