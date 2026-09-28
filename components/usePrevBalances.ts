"use client";

import { useReadContracts } from "wagmi";
import { PREV_CONTRACT_ADDRESSES, INTEGRATOR_ABI } from "../lib/contract";

export interface PrevBalance {
  contract: `0x${string}`;
  /** Still inside the settlement lock. */
  pending: bigint;
  /** Withdrawable right now. */
  available: bigint;
  /** Earliest future unlock among this contract's buckets, unix seconds, or 0. */
  nextUnlock: number;
}

/**
 * The merchant's balance on EVERY previous integrator, read in one multicall.
 *
 * Used by the dashboard and the withdraw page so the headline balance is the
 * merchant's whole balance across contract upgrades, not just the current one.
 * Returns empty (and makes no calls) when no previous contract is configured.
 */
export function usePrevBalances(address: `0x${string}` | undefined) {
  const enabled = !!address && PREV_CONTRACT_ADDRESSES.length > 0;
  const { data, refetch, isLoading } = useReadContracts({
    contracts: PREV_CONTRACT_ADDRESSES.flatMap((contract) => [
      { address: contract, abi: INTEGRATOR_ABI, functionName: "getMerchantBalance", args: [address!] } as const,
      { address: contract, abi: INTEGRATOR_ABI, functionName: "getMerchantBuckets", args: [address!] } as const,
    ]),
    query: { enabled, refetchInterval: 20000 },
  });

  const now = Math.floor(Date.now() / 1000);
  const rows: PrevBalance[] = [];
  PREV_CONTRACT_ADDRESSES.forEach((contract, i) => {
    // A failed read (an RPC blip, or an address that is not an integrator)
    // counts as zero for that contract rather than hiding every other one.
    const bal = data?.[i * 2];
    const bk = data?.[i * 2 + 1];
    if (bal?.status !== "success") return;
    const [pending, available] = bal.result as readonly [bigint, bigint, bigint, boolean];
    if (pending + available === 0n) return;
    const buckets = (bk?.status === "success" ? bk.result : []) as readonly { amount: bigint; unlockTimestamp: bigint }[];
    const future = buckets
      .filter((b) => b.amount > 0n && Number(b.unlockTimestamp) > now)
      .map((b) => Number(b.unlockTimestamp));
    rows.push({ contract, pending, available, nextUnlock: future.length ? Math.min(...future) : 0 });
  });

  const pending = rows.reduce((s, r) => s + r.pending, 0n);
  const available = rows.reduce((s, r) => s + r.available, 0n);
  return { rows, pending, available, total: pending + available, refetch, isLoading };
}
