"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./Icons";
import { EcosystemButton } from "./EcosystemPanel";
import { usePillVisible } from "./FloatingNav";
import { useT } from "../lib/i18n";

/**
 * No header bar. Only the dashboard (`home`) shows a top row: the PayQR logo on
 * the left (light / dark artwork swapped by theme), the P2P mark + Explore
 * button on the right. Every other page has no logo at all; sub-flows keep a
 * small floating back control. (`menu` / `action` are accepted for call-site
 * compatibility and ignored.)
 */
export function Nav({ back = false, backHref = "/dashboard", home = false }: { back?: boolean; backHref?: string; home?: boolean; menu?: boolean; action?: unknown }) {
  const router = useRouter();
  const { t } = useT();
  const pill = usePillVisible();
  const showBack = back && !pill;
  if (!home && !showBack) return null;
  return (
    <header className="nav-lite">
      {showBack && (
        <button
          className="nav-back nav-back-float"
          aria-label={t("nav.back")}
          // replace, not push: "back" should unwind, not grow the history stack.
          onClick={() => (backHref ? router.replace(backHref) : router.back())}
        >
          <Icon.Back />
        </button>
      )}
      {home && (
        <>
          <Link href="/dashboard" className="brand nav-logo" aria-label="PayQR">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="logo-light" src="/logo.png" alt="PayQR" height={30} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="logo-dark" src="/logo-dark-theam.png" alt="PayQR" height={30} />
          </Link>
          <div className="nav-right">
            <EcosystemButton />
          </div>
        </>
      )}
    </header>
  );
}
