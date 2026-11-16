"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchPriceConfig } from "../lib/pricing";

/**
 * The live on-chain price for a currency as ONE shared, cached query, with
 * explicit loading / failed states — so no screen can sit on "Fetching the
 * rate…" forever when the read failed.
 *
 * This is for DISPLAY (live hints while typing). Anything that creates an order
 * or link still re-reads `fetchPriceConfig` at submit time for a fresh price.
 */
export function usePriceConfig(code?: string | null) {
  const q = useQuery({
    queryKey: ["price", code],
    queryFn: async () => {
      const cfg = await fetchPriceConfig(code as string);
      if (!cfg) throw new Error(`no price for ${code}`);
      return cfg;
    },
    enabled: !!code,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: 1,
  });
  return { cfg: q.data ?? null, loading: !!code && q.isLoading, failed: q.isError && !q.data, refetch: q.refetch };
}
