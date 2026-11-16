"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchHistory } from "../lib/history";

/**
 * The merchant's sales history as ONE shared, cached query.
 *
 * The dashboard, the Transactions page and the dispute picker each used to run
 * their own copy of `fetchHistory` on their own timer — two sequential subgraph
 * queries apiece, repeated on every navigation. They now share a cache entry
 * (same key), so moving between pages shows the data immediately and refreshes
 * it at most once per interval. Polling pauses while the tab is hidden and
 * resumes (with an immediate refetch) when it is visible again.
 *
 * `fetchHistory` throws on a network or subgraph fault, so a failed refresh
 * keeps the last good rows (`data`) and flags `isError` — never a silent empty list.
 */
export const HISTORY_POLL_MS = 15_000;

export function historyQuery(address?: string | null, proxies?: string[] | null) {
  return {
    queryKey: ["history", String(address || "").toLowerCase(), (proxies ?? []).map((p) => p.toLowerCase()).join(",")] as const,
    queryFn: () => fetchHistory(address, proxies ?? undefined),
    staleTime: 10_000,
  };
}

export function useHistory(address?: string | null, proxies?: string[] | null) {
  return useQuery({
    ...historyQuery(address, proxies),
    // `proxies === undefined` means "still resolving" — don't query the subgraph
    // with an incomplete set of proxies and then again with the full one.
    enabled: !!address && proxies !== undefined && proxies !== null,
    refetchInterval: HISTORY_POLL_MS,
    refetchIntervalInBackground: false,
  });
}
