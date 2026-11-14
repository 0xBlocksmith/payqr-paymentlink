/**
 * Dispute appeal ladder (live on Base mainnet): circle -> country admin -> P2P ops.
 * The order's `user` can push a dispute up a tier; USER-fault decisions at tier
 * 1/2 stay appealable until their window closes, and only DisputeSettled is final.
 *
 * Reads and encodes the Diamond directly: @p2pdotme/sdk <=1.3.11 and
 * @p2pdotme/widgets <=1.9.0 can raise but cannot appeal.
 */
import { createPublicClient, encodeFunctionData, http, parseAbi, type Address } from "viem";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";
import { DIAMOND_ADDRESS } from "./p2p";

export const DISPUTE_ABI = parseAbi([
  "function appealDispute(uint256 orderId)",
  "function finalizeDispute(uint256 orderId)",
  "function getDisputeTier(uint256 orderId) view returns (uint8 tier, uint64 tierSince, uint64 appealableAt)",
  "function getDisputeDecision(uint256 orderId) view returns (uint8 faultType, uint8 decisionTier, address decidedBy, uint64 decidedAt, uint64 appealableUntil)",
]);

const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

export type LadderState =
  | { kind: "none" }
  /** Waiting on the tier's decision. `appealableAt` is when the user may escalate. */
  | { kind: "awaiting"; tier: number; appealableAt: number }
  /** Tier missed its SLA: the user may appeal. */
  | { kind: "appeal-sla"; tier: number }
  /** USER-fault decision pending: the user may appeal until `until`. */
  | { kind: "appeal-window"; tier: number; until: number }
  /** Window closed on a USER-fault decision: anyone may finalize. */
  | { kind: "finalize"; tier: number };

/** Pure state derivation. Times are unix seconds. */
export function deriveLadderState(
  tier: number,
  appealableAt: number,
  faultType: number,
  decisionTier: number,
  appealableUntil: number,
  now: number
): LadderState {
  if (tier === 0) return { kind: "none" };
  if (faultType !== 0) {
    const t = decisionTier || tier;
    return now < appealableUntil && t < 3
      ? { kind: "appeal-window", tier: t, until: appealableUntil }
      : { kind: "finalize", tier: t };
  }
  if (tier < 3 && appealableAt > 0 && now >= appealableAt) return { kind: "appeal-sla", tier };
  return { kind: "awaiting", tier, appealableAt };
}

export async function readLadderState(orderId: string): Promise<LadderState> {
  if (!DIAMOND_ADDRESS) return { kind: "none" };
  const address = DIAMOND_ADDRESS as Address;
  const id = BigInt(orderId);
  const [[tier, , appealableAt], [faultType, decisionTier, , , until]] = await Promise.all([
    (reader as any).readContract({ address, abi: DISPUTE_ABI, functionName: "getDisputeTier", args: [id] }) as Promise<readonly [number, bigint, bigint]>,
    (reader as any).readContract({ address, abi: DISPUTE_ABI, functionName: "getDisputeDecision", args: [id] }) as Promise<readonly [number, number, Address, bigint, bigint]>,
  ]);
  return deriveLadderState(
    Number(tier), Number(appealableAt), Number(faultType), Number(decisionTier), Number(until),
    Math.floor(Date.now() / 1000)
  );
}

export const encodeAppeal = (orderId: string) =>
  encodeFunctionData({ abi: DISPUTE_ABI, functionName: "appealDispute", args: [BigInt(orderId)] });
export const encodeFinalize = (orderId: string) =>
  encodeFunctionData({ abi: DISPUTE_ABI, functionName: "finalizeDispute", args: [BigInt(orderId)] });

/** Diamond dispute errors by selector, for AA providers that report raw hex. */
const DISPUTE_ERRORS: Record<string, string> = {
  "0xea8e4eb5": "Only the account that placed this order can do that.",
  "0x69ac4b4e": "Only the account that placed this order can appeal.",
  "0x88d039ce": "There is no open dispute on this order.",
  "0x64536065": "This step hasn't run out of time yet. Appeal becomes available if it isn't decided in time.",
  "0xe27a7ee0": "The appeal window has closed. Finalize the decision instead.",
  "0xa8714168": "This dispute is already at the final level.",
  "0x2cab5cf9": "There is no pending decision to finalize.",
  "0x09b57248": "The appeal window is still open. Finalize after it ends.",
  "0x866e9f89": "This dispute is already settled.",
};

export function disputeErrorMessage(e: any): string | null {
  let walked = "";
  try { walked = e?.walk?.()?.signature || ""; } catch { /* ignore */ }
  const text = `${e?.shortMessage || ""} ${e?.message || ""} ${e?.signature || ""} ${walked}`.toLowerCase();
  for (const [sel, msg] of Object.entries(DISPUTE_ERRORS)) if (text.includes(sel)) return msg;
  return null;
}
