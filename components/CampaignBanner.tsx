"use client";

import { useRouter } from "next/navigation";
import { useT } from "../lib/i18n";

/**
 * $500 Volume Challenge promo slide — same dark-gradient card as the main
 * promo banner (not a separate green treatment), lives inside the
 * dashboard's swipeable promo carousel. Clicking opens /campaign.
 */
export function CampaignPromo() {
  const router = useRouter();
  const { t } = useT();
  return (
    <button
      className="promo promo-campaign"
      onClick={() => router.push("/campaign")}
      aria-label={t("camp.bannerH")}
    >
      <div className="promo-tag">{t("camp.tag")}</div>
      <div className="promo-h">{t("camp.bannerH")}</div>
      <div className="promo-sub">{t("camp.bannerSub")}</div>
      <span className="promo-reward">{t("camp.trackProgress")}</span>
    </button>
  );
}
