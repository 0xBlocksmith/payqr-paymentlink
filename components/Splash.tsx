"use client";

import { useEffect, useState } from "react";
import { getLang, translate } from "../lib/i18n";

/**
 * Branded full-screen splash shown while the app initializes (thirdweb wallet
 * init, prefs read, first route). Replaces the bare "Loading…" text so the wait looks
 * intentional and on-brand — important on iOS where a blank flash reads as slow.
 *
 * The theme-init inline script in layout has already set the background color
 * before this renders, so there's no white flash.
 *
 * It no longer spins forever: if initialisation takes unusually long (a failed
 * wallet chunk, a stuck auto-connect) it says so after a few seconds and offers a
 * reload, instead of leaving the merchant on a frozen logo.
 */
export function Splash() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(id);
  }, []);
  const lang = typeof window === "undefined" ? "en" : getLang();
  return (
    <div className="splash" role="status" aria-live="polite" aria-label="PayQR">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="splash-logo" src="/splash.png" alt="PayQR" width={130} height={130} />
      <div className="splash-dots"><i /><i /><i /></div>
      {slow && (
        <div style={{ marginTop: 18, textAlign: "center", padding: "0 24px" }}>
          <p className="muted" style={{ marginBottom: 10 }}>{translate("splash.slow", lang)}</p>
          <button className="btn small" onClick={() => window.location.reload()}>{translate("ui.refresh", lang)}</button>
        </div>
      )}
    </div>
  );
}
