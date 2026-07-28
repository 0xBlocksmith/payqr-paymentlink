"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AccountMenu } from "./AccountMenu";
import { ThemeButton } from "./ThemeButton";
import { InstallButton } from "./InstallButton";
import { DisputeButton } from "./DisputeButton";
import { SideMenu } from "./SideMenu";
import { Icon, Logo } from "./Icons";

export function Nav({ center = null, back = false, backHref = "/dashboard", menu = true }) {
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
      {center && <div className="nav-center">{center}</div>}
      <div className="nav-right">
        <InstallButton />
        <DisputeButton />
        <ThemeButton />
        <AccountMenu />
      </div>
      <SideMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </nav>
  );
}
