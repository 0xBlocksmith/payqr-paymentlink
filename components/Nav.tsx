"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AccountMenu } from "./AccountMenu";
import { ThemeButton } from "./ThemeButton";
import { InstallButton } from "./InstallButton";
import { DisputeButton } from "./DisputeButton";
import { SideMenu } from "./SideMenu";
import { EcosystemButton } from "./EcosystemPanel";
import { Icon, Logo } from "./Icons";

export function Nav({ action = null, back = false, backHref = "/dashboard", menu = true }) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <nav className="nav">
      {back ? (
        <button
          className="nav-back"
          aria-label="Back"
          // replace, not push: "back" should unwind, not grow the history stack
          // (dashboard → qr → back(push dashboard) → hardware-back landed on qr
          // again, stacking dashboard/qr/dashboard/… forever).
          onClick={() => (backHref ? router.replace(backHref) : router.back())}
        >
          <Icon.Back />
        </button>
      ) : menu ? (
        <button className="nav-back" aria-label="Menu" onClick={() => setMenuOpen(true)}>
          <Icon.Menu />
        </button>
      ) : null}
      <Link href="/dashboard" className="brand" aria-label="PayQR">
        <Logo size={24} className="brand-mark" />
      </Link>
      {/* `action` (the "How it works" pill) rides in the RIGHT cluster, not a
          separately-centered absolute box: pinned to the viewport's 50% it kept
          its own position while the icon cluster grew from the right, so at some
          widths the pill and the ecosystem button ended up flush against each
          other with no gap. In-flow it sits next to the store icon and inherits
          the cluster's gap at every width. (Was `center` — renamed, since it no
          longer centers anything.) */}
      <div className="nav-right">
        {action}
        <EcosystemButton />
        <InstallButton />
        <DisputeButton />
        <ThemeButton />
        <AccountMenu />
      </div>
      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </nav>
  );
}
