"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";

/**
 * Top-nav shortcut to the per-order dispute/support chips (OrderDisputeManager,
 * rendered on Transactions rows — see components/OrderDisputeManager.tsx).
 * There's no standalone "all my disputes" screen in @p2pdotme/widgets/support
 * (every surface there is keyed by a specific orderId), so this just jumps to
 * Transactions, where the real per-order chips live. Hidden ON the
 * Transactions page itself — no point linking to the page you're already on.
 */
export function DisputeButton() {
  const pathname = usePathname();
  const { t } = useT();
  if (pathname === "/transactions") return null;
  return (
    <Link
      href="/transactions"
      className="theme-btn"
      aria-label={t("nav.disputes")}
      title={t("nav.disputes")}
    >
      <Icon.Headset />
    </Link>
  );
}
