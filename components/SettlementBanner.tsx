"use client";

import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../lib/contract";
import { codeToHex } from "../lib/p2p";
import { STATIC_STALE_MS } from "../lib/cache";
import { useT } from "../lib/i18n";
import type { Country } from "../lib/types";

/**
 * Upfront, always-visible notice of the settlement/unlock window (a received
 * sale is locked for `lockPeriod(currency)` before it's withdrawable) — a
 * merchant discovered this today ONLY by placing their first order and
 * seeing the dashboard's live countdown card, by which point the money was
 * already locked. Reads lockPeriod directly (on-chain, admin-tunable per
 * currency, no redeploy) so it's accurate BEFORE the merchant has any orders
 * or buckets to derive a countdown from.
 */
export function SettlementBanner({ country }: { country: Country | null }) {
  const { t } = useT();
  const currencyHex = country ? (codeToHex(country.code) as `0x${string}`) : undefined;
  const { data: lockSecs } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "lockPeriod",
    args: [currencyHex as `0x${string}`],
    query: { enabled: !!currencyHex, staleTime: STATIC_STALE_MS },
  });

  if (lockSecs == null) return null;
  // Same day-rounding as the live unlock countdown elsewhere (dashboard/
  // withdraw) — round up so a sub-day window never reads as "0 days".
  const days = Math.max(1, Math.ceil(Number(lockSecs) / 86400));
  const message = t("dash.settlementNotice")
    .replace("{days}", String(days))
    .replace("{country}", country?.name ?? "");

  // Duplicate the text so the marquee has a second copy to scroll into view
  // right behind the first — an unbroken loop instead of a gap-then-repeat.
  return (
    <div className="settle-banner" role="status">
      <div className="settle-banner-track">
        <span className="settle-banner-item">{message}</span>
        <span className="settle-banner-item" aria-hidden="true">{message}</span>
      </div>
    </div>
  );
}
