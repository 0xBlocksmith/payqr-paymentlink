"use client";

import { useState } from "react";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";

// The wider P2P app store — this terminal runs on the P2P protocol, and the
// ecosystem sheet lets merchants discover the other apps in the family. Loaded
// in an embedded iframe so they never leave PayQR (with an escape hatch to open
// it in a real tab).
const ECOSYSTEM_URL = process.env.NEXT_PUBLIC_ECOSYSTEM_URL || "https://p2p.store";

/** Full-height bottom sheet that embeds the P2P app store in an iframe. */
function EcosystemSheet({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet eco-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="eco-head">
          <button
            type="button"
            className="btn small secondary eco-newtab"
            onClick={() => window.open(ECOSYSTEM_URL, "_blank", "noopener,noreferrer")}
          >
            <Icon.Link width="15" height="15" /> {t("eco.openNewTab")}
          </button>
          <button className="sheet-x" onClick={onClose} aria-label={t("eco.title")}>✕</button>
        </div>
        <div className="eco-frame-wrap">
          {!loaded && (
            <div className="eco-skel">
              <span className="eco-skel-bar" style={{ height: 40 }} />
              <span className="eco-skel-bar" style={{ height: 120 }} />
              <span className="eco-skel-bar" style={{ width: "66%" }} />
              <span className="eco-skel-bar" style={{ width: "50%" }} />
              <span className="eco-skel-bar" style={{ height: 120 }} />
              <span className="eco-skel-bar" style={{ width: "75%" }} />
            </div>
          )}
          <iframe
            src={ECOSYSTEM_URL}
            title={t("eco.title")}
            onLoad={() => setLoaded(true)}
            className="eco-frame"
            allow="clipboard-read; clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    </div>
  );
}

/** Compact nav-bar button (top-right) that opens the ecosystem sheet. */
export function EcosystemButton() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="eco-btn"
        aria-label={t("eco.title")}
        title={t("eco.title")}
        onClick={() => setOpen(true)}
      >
        <Icon.Ecosystem width="20" height="20" />
      </button>
      {open && <EcosystemSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/** Dashboard promo-carousel slide — same dark-gradient card as the other
 * promo slides, opens the ecosystem sheet on tap. */
export function EcosystemPromo() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="promo promo-campaign" onClick={() => setOpen(true)} aria-label={t("eco.title")}>
        <div className="promo-tag">{t("eco.title")}</div>
        <div className="promo-h">{t("eco.cardTitle")}</div>
        <div className="promo-sub">{t("eco.cardSubtitle")}</div>
      </button>
      {open && <EcosystemSheet onClose={() => setOpen(false)} />}
    </>
  );
}
