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
 *
 * Rendered as a white clone of the dashboard's dark promo card (rather than
 * the scrolling ticker this used to be) so the lock duration is readable at
 * a glance instead of having to wait for it to scroll into view.
 */
export function SettlementPromo({ country }: { country: Country | null }) {
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
  const template = t("dash.settlementNotice");
  const [before, after] = template.split("{days}");
  const afterText = (after ?? "").replace("{country}", country?.name ?? "");
  const beforeText = before.replace("{country}", country?.name ?? "");

  return (
    <div className="promo promo-white">
      <div className="promo-tag">SETTLEMENT WINDOW</div>
      <div className="promo-sub promo-sub-dark">
        {beforeText}
        <span className="promo-highlight">{days} {days === 1 ? "day" : "days"}</span>
        {afterText}
      </div>
    </div>
  );
}
