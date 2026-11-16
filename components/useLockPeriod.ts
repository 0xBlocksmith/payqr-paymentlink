"use client";

import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../lib/contract";
import { codeToHex } from "../lib/p2p";
import { STATIC_STALE_MS } from "../lib/cache";

/**
 * The on-chain settlement lock for a currency (`lockPeriod(currency)` — set by
 * the protocol admin, per currency, no redeploy). The ONE source of truth for
 * every settlement message in the app; nothing is hardcoded.
 *
 * `secs` is null until known. `error` is true when the read failed — callers
 * must then show an "unavailable" state rather than invent a number. (Values
 * observed on Base mainnet at the time of writing: INR 15 days; BRL/ARS/VEN
 * 1.5 days — read live, never assumed.)
 */
export function useLockPeriod(currency: string | null | undefined) {
  const hex = currency ? (codeToHex(currency) as `0x${string}`) : undefined;
  const q = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "lockPeriod",
    args: [hex as `0x${string}`],
    query: { enabled: !!hex, staleTime: STATIC_STALE_MS },
  });
  const secs = q.data != null ? Number(q.data) : null;
  return {
    secs,
    loading: !!hex && q.isLoading,
    error: !!hex && q.isError,
    refetch: q.refetch,
  };
}
