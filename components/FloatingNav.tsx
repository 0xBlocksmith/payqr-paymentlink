"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";

/** The sections that get the floating pill. Everything else (login, pay page,
 *  create-link flow, QR…) is a focused flow and keeps the full screen. */
export const PILL_ROUTES = ["/dashboard", "/transactions", "/withdraw", "/disputes", "/settings"];

const Home = (p: any) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M3 11.5 12 4l9 7.5M5.5 10v10h13V10" /></svg>
);

export function usePillVisible() {
  const path = usePathname() || "";
  return PILL_ROUTES.some((r) => path === r || path.startsWith(r + "/"));
}

/**
 * Floating glass pill, icons only — the old side-menu sections as a bottom
 * switcher. Mounted once in Providers (not per page) so it persists across
 * navigations and the active highlight slides between icons.
 */
export function FloatingNav() {
  const path = usePathname() || "";
  const { t } = useT();
  const items = [
    { href: "/dashboard", label: t("nav.home"), Ico: Home },
    { href: "/transactions", label: t("nav.transactions"), Ico: Icon.Repeat },
    { href: "/withdraw", label: t("nav.withdraw"), Ico: Icon.Up },
    { href: "/disputes", label: t("nav.disputes"), Ico: Icon.Headset },
    { href: "/settings", label: t("nav.settings"), Ico: Icon.Gear },
  ];
  if (!usePillVisible()) return null;
  const active = items.findIndex((i) => path === i.href || path.startsWith(i.href + "/"));
  return (
    <nav className="fnav" aria-label={t("dash3.mainNav")}>
      {active >= 0 && (
        <span className="fnav-glow" style={{ transform: `translateX(${active * 100}%)` }} aria-hidden="true" />
      )}
      {items.map((it, i) => (
        <Link key={it.href} href={it.href} prefetch aria-label={it.label} title={it.label}
          aria-current={i === active ? "page" : undefined} className={`fnav-item ${i === active ? "on" : ""}`}>
          <it.Ico />
        </Link>
      ))}
    </nav>
  );
}
