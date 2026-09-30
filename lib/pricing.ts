/**
 * On-chain checkout pricing — so the customer pays EXACTLY the fiat the merchant
 * quoted (e.g. ₹500), with all USDC↔fiat spread/fees absorbed on the merchant's
 * USDC side.
 *
 * The p2p.me <Checkout> widget derives the fiat the customer sees & pays from
 * the on-chain price config, NOT from anything we hand it as a display string:
 *
 *     chargedFiat = usdcAmount * buyPrice / 1e6
 *     feeUsdc     = (usdcAmount <= smallOrderThreshold) ? smallOrderFixedFee : 0
 *     feeFiat     = feeUsdc * buyPrice / 1e6
 *     totalFiat   = chargedFiat + feeFiat          // what the customer pays
 *
 * If we size usdcAmount from our own estimate rate (lib/rates.ts) it won't match
 * the Diamond's live buyPrice, so a ₹500 quote renders as ~₹492. To pin the
 * customer's total to the quote we must INVERT the widget's formula against the
 * SAME on-chain numbers it reads, and size usdcAmount so totalFiat == quote:
 *
 *     usdcAmount = round(quoteFiat6 * 1e6 / buyPrice) - feeUsdc
 *
 * This reads getPriceConfig / getSmallOrderThreshold / getSmallOrderFixedFeeBuy
 * off the Diamond exactly like the widget (checkout.js) does, so the preview
 * screen, the accepted "Pay exactly X" screen, the UPI deep-link, and SDK
 * routing all land on the quoted fiat.
 */
import { createPublicClient, http, stringToHex, parseAbi } from "viem";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";
import { DIAMOND_ADDRESS } from "./p2p";

// Minimal slice of the Diamond ABI — only the reads the widget uses to price a
// BUY. Mirrors @p2pdotme/widgets' DIAMOND_ABI (getPriceConfig tuple + the V22
// per-order-type small-order fee selector, with a pre-V22 unified fallback).
const PRICE_ABI = parseAbi([
  "struct PriceConfig { uint256 buyPrice; uint256 sellPrice; int256 buyPriceOffset; uint256 baseSpread; }",
  "function getPriceConfig(bytes32 currency) view returns (PriceConfig)",
  "function getSmallOrderThreshold(bytes32 currency) view returns (uint256)",
  "function getSmallOrderFixedFeeBuy(bytes32 currency) view returns (uint256)",
  "function getSmallOrderFixedFeeSell(bytes32 currency) view returns (uint256)",
  "function getSmallOrderFixedFee(bytes32 currency) view returns (uint256)", // deprecated unified (pre-V22)
]);

const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

export type PriceConfig = {
  buyPrice: bigint;            // 6-dec fiat per USDC — what a CUSTOMER pays to buy (checkout)
  sellPrice: bigint;           // 6-dec fiat per USDC — what a MERCHANT gets cashing OUT (withdraw)
  smallOrderThreshold: bigint; // 6-dec USDC; orders <= this pay the fixed fee
  smallOrderFixedFee: bigint;  // 6-dec USDC (BUY pays half the unified fee)
};

/** BUY small-order fee — typed V22 selector, fall back to the unified one. */
async function readBuyFixedFee(currencyHex: `0x${string}`): Promise<bigint> {
  try {
    return (await reader.readContract({
      address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
      functionName: "getSmallOrderFixedFeeBuy", args: [currencyHex],
    } as any)) as bigint;
  } catch {
    try {
      return (await reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getSmallOrderFixedFee", args: [currencyHex],
      } as any)) as bigint;
    } catch {
      return 0n;
    }
  }
}

/** SELL (cash-out) small-order fee — typed V22 selector, fall back to unified. */
async function readSellFixedFee(currencyHex: `0x${string}`): Promise<bigint> {
  try {
    return (await reader.readContract({
      address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
      functionName: "getSmallOrderFixedFeeSell", args: [currencyHex],
    } as any)) as bigint;
  } catch {
    try {
      return (await reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getSmallOrderFixedFee", args: [currencyHex],
      } as any)) as bigint;
    } catch {
      return 0n;
    }
  }
}

/**
 * The small-order cash-out (SELL) fee + threshold for a currency, both 6-dec
 * USDC. A withdrawal whose amount is <= threshold pays the fixed fee on top —
 * which is why "Max" on a tiny balance must reserve `fee` so the total doesn't
 * exceed the balance. Returns { threshold: 0, fee: 0 } if unreadable (Max then
 * just uses the full balance, same as before).
 */
export async function fetchCashoutFee(code: string): Promise<{ threshold: bigint; fee: bigint }> {
  if (!DIAMOND_ADDRESS) return { threshold: 0n, fee: 0n };
  const currencyHex = stringToHex(code, { size: 32 });
  try {
    const [threshold, fee] = await Promise.all([
      reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getSmallOrderThreshold", args: [currencyHex],
      } as any) as Promise<bigint>,
      readSellFixedFee(currencyHex),
    ]);
    return { threshold: (threshold as bigint) ?? 0n, fee: fee ?? 0n };
  } catch {
    return { threshold: 0n, fee: 0n };
  }
}

/**
 * Read the live on-chain price config for a currency code ("INR", "BRL", …).
 * Returns null if the Diamond isn't configured/reachable (caller falls back to
 * the estimate-rate path so the terminal still works).
 */
export async function fetchPriceConfig(code: string): Promise<PriceConfig | null> {
  if (!DIAMOND_ADDRESS) return null;
  const currencyHex = stringToHex(code, { size: 32 });
  try {
    const [price, threshold, fixedFee] = await Promise.all([
      reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getPriceConfig", args: [currencyHex],
      } as any),
      reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getSmallOrderThreshold", args: [currencyHex],
      } as any),
      readBuyFixedFee(currencyHex),
    ]);
    const buyPrice = (price as any).buyPrice as bigint;
    const sellPrice = ((price as any).sellPrice as bigint) ?? 0n;
    if (!buyPrice || buyPrice <= 0n) return null;
    return {
      buyPrice,
      sellPrice,
      smallOrderThreshold: threshold as bigint,
      smallOrderFixedFee: fixedFee,
    };
  } catch {
    return null;
  }
}

/**
 * Size the USDC amount so the customer's on-chain total lands as close as
 * possible to the quoted fiat. `quoteFiat` is the plain fiat number the
 * merchant typed (e.g. 500 for ₹500). Returns 6-dec `usdcAmount`, or 0 if it
 * can't be priced.
 *
 * Inverts the widget's totalFiat = usdcAmount*buyPrice/1e6 + feeUsdc*buyPrice/1e6.
 * The fee only applies to small orders (usdcAmount <= threshold), so we solve
 * once assuming the fee applies, then drop it if the result is above threshold
 * and re-solve without it — matching the widget's own conditional exactly.
 *
 * NOTE: the integrator's product-2 unit price is now 1e-6 USDC (one 6-dec unit),
 * so the on-chain `quantity` == this usdcAmount to the last 6-dec unit — there is
 * NO cent quantization to snap to any more. Returning the exact inverse directly
 * is therefore lossless: the widget's displayed total reproduces the quoted fiat
 * to within one 6-dec unit of USDC (sub-₹0.0001), which killed the old half-cent
 * drift that read as "the total doesn't match what I typed" on small orders.
 */
export function usdcForFiat(quoteFiat: number, cfg: PriceConfig): bigint {
  const quoteFiat6 = BigInt(Math.round(quoteFiat * 1e6)); // 6-dec fiat
  const { buyPrice, smallOrderThreshold, smallOrderFixedFee } = cfg;

  // Exact-fiat usdc solving totalFiat == quoteFiat6.
  const grossUsdc = (quoteFiat6 * 1_000_000n) / buyPrice;
  // >= (not >): at EXACT equality the fee must still be subtracted — otherwise
  // the full gross is kept as principal, the widget adds the fee on top, and a
  // quote equal to the fee's fiat value charges the customer ~2× the quote.
  // With >=, equality yields principal 0 → the <= 0 guard returns 0n and the
  // caller shows "Amount too small" instead.
  let usdc = grossUsdc >= smallOrderFixedFee ? grossUsdc - smallOrderFixedFee : grossUsdc;
  if (usdc > smallOrderThreshold) usdc = grossUsdc;
  if (usdc <= 0n) return 0n;
  return usdc;
}

/**
 * Size the principal so the customer's on-chain total lands on the USDC
 * amount the MERCHANT typed directly (terminal's USDC input mode), same
 * guarantee as usdcForFiat but without a fiat leg.
 *
 * The widget computes totalUsdc = principal + (principal <= threshold ?
 * smallOrderFixedFee : 0). Passing `targetUsdc` straight through as the
 * principal (the old behavior) lets the widget add the fee ON TOP, so typing
 * "1 USDC" charged the customer 1 USDC + fee — never what the merchant
 * quoted. Subtract the fee first so principal + fee == targetUsdc, matching
 * usdcForFiat's inversion; if that pushes the principal above the threshold
 * (fee no longer applies at that size), fall back to the un-inverted amount.
 */
/**
 * The smallest amount a small order can be charged at EXACTLY, in local
 * currency (`minimumFiat`) and in USDC (`minimumUsdc`). Below the small-order
 * fee's own value there is no principal left once the fee is taken out, and
 * usdcForFiat / usdcForUsdcTarget then keep the amount AND the Diamond adds the
 * fee on top — 10 ARS would charge ~50. The /qr terminal refuses those with its
 * minimum-order floor; payment links check these. 0 when there is no fee.
 */
export function minimumFiat(cfg: PriceConfig): number {
  if (cfg.smallOrderFixedFee <= 0n) return 0;
  // The least quote whose principal is at least one 6-dec unit after the fee.
  return Number(((cfg.smallOrderFixedFee + 1n) * cfg.buyPrice + 999_999n) / 1_000_000n) / 1e6;
}

export function minimumUsdc(cfg: PriceConfig): number {
  return cfg.smallOrderFixedFee > 0n ? Number(cfg.smallOrderFixedFee + 1n) / 1e6 : 0;
}

export function usdcForUsdcTarget(targetUsdc: number, cfg: PriceConfig): bigint {
  const target6 = BigInt(Math.round(targetUsdc * 1e6));
  const { smallOrderThreshold, smallOrderFixedFee } = cfg;

  let usdc = target6 >= smallOrderFixedFee ? target6 - smallOrderFixedFee : target6;
  if (usdc > smallOrderThreshold) usdc = target6;
  if (usdc <= 0n) return 0n;
  return usdc;
}

/**
 * usdcForFiat's inverse: what fiat a customer actually pays for a link whose
 * on-chain `amount` (6-dec USDC-equivalent, as stored by createLink) is
 * `usdcAmount`.
 *
 * A payment-link amount is written ONCE at creation time from a fiat quote
 * (usdcForFiat), so displaying it back requires re-deriving the fiat the same
 * way the widget will charge it: totalFiat = (usdcAmount + fee) * buyPrice /
 * 1e6, fee applying only when usdcAmount is at/under the threshold — mirrors
 * this file's header comment exactly, just run in the other direction.
 * Returns null if the amount can't be priced right now (Diamond unreachable),
 * so callers can show a loading/placeholder state instead of a wrong number.
 */
export function fiatForUsdc(usdcAmount: bigint, cfg: PriceConfig): number {
  const { buyPrice, smallOrderThreshold, smallOrderFixedFee } = cfg;
  const feeUsdc = usdcAmount <= smallOrderThreshold ? smallOrderFixedFee : 0n;
  const totalFiat6 = (usdcAmount + feeUsdc) * buyPrice / 1_000_000n;
  return Number(totalFiat6) / 1e6;
}
