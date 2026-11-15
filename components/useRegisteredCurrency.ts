"use client";

import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, currencyFromBytes32 } from "../lib/contract";
import { STATIC_STALE_MS } from "../lib/cache";

/**
 * The merchant's REGISTERED currency — the on-chain value (immutable) that the
 * contract enforces for caps and settlement. Settlement messaging after
 * registration must key off this, not the freely-changeable UI country stored
 * in localStorage (which can disagree).
 *
 * Returns code "" while unknown, "INR" / "BRL" / … once read.
 */
export function useRegisteredCurrency(address?: string) {
  const { data: info, isLoading } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address as `0x${string}`], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  const code = currencyFromBytes32(info?.[2] as string);
  return { code, loading: !!address && isLoading };
}
