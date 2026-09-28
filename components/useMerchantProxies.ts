"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { ALL_CONTRACT_ADDRESSES, CONTRACT_ADDRESS, CROSS_VERSION_ABI } from "../lib/contract";

/**
 * The merchant's proxy on EVERY integrator — current and previous.
 *
 * Each integrator deploys its own per-merchant proxy (CREATE2 from the
 * integrator's address), so the same merchant has a DIFFERENT proxy on each
 * contract. Link sales and fiat withdrawals are recorded under the proxy, so
 * history that only knew the current proxy lost every link sale and withdrawal
 * the merchant made before an upgrade.
 *
 * `proxies` is undefined while loading, so callers can wait rather than
 * querying with a partial list and briefly showing a shorter history.
 */
export function useMerchantProxies(address: `0x${string}` | undefined) {
  const { data } = useReadContracts({
    contracts: ALL_CONTRACT_ADDRESSES.map(
      (contract) =>
        ({ address: contract, abi: CROSS_VERSION_ABI, functionName: "proxyAddress", args: [address!] }) as const
    ),
    query: { enabled: !!address && ALL_CONTRACT_ADDRESSES.length > 0, staleTime: Infinity },
  });

  return useMemo(() => {
    if (!data) return { proxies: undefined, currentProxy: undefined, byContract: {} as Record<string, string> };
    const byContract: Record<string, string> = {};
    ALL_CONTRACT_ADDRESSES.forEach((contract, i) => {
      const r = data[i];
      const p = r?.status === "success" ? String(r.result) : "";
      if (/^0x[0-9a-fA-F]{40}$/.test(p) && !/^0x0+$/i.test(p)) byContract[contract.toLowerCase()] = p;
    });
    return {
      proxies: Object.values(byContract),
      currentProxy: byContract[(CONTRACT_ADDRESS || "").toLowerCase()],
      byContract,
    };
  }, [data]);
}
