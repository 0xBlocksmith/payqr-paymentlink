"use client";

import { useRouter } from "next/navigation";
import { useT } from "../lib/i18n";
import { campaignRange, type Campaign } from "../lib/campaign";

/**
 * $500 Volume Challenge promo slide — same dark-gradient card as the main
 * promo banner (not a separate green treatment), lives inside the
 * dashboard's swipeable promo carousel. Clicking opens /campaign.
 */

export function CampaignPromo({ campaign }: { campaign: Campaign }) {
  const router = useRouter();
  const { t, lang } = useT();
  const heading = t("camp.bannerH").replace("{goal}", `$${campaign.goalUsdc}`);
  const sub = t("camp.bannerSub")
    .replace("{country}", t(`camp.country.${campaign.countryId}`))
    .replace("{range}", campaignRange(campaign, lang));
  return (
    <button
      className="promo promo-campaign"
      onClick={() => router.push("/campaign")}
      aria-label={heading}
    >
      <div className="promo-tag">{t("camp.tag")}</div>
      <div className="promo-h">{heading}</div>
      <div className="promo-sub">{sub}</div>
      <span className="promo-reward">{t("camp.trackProgress")}</span>
    </button>
  );
}
