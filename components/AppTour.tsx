"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";

/**
 * First-run guided tour. A dimmed overlay with an illustrated card per step —
 * each step shows a small preview of that part of the app, not just text.
 * Auto-runs once (localStorage flag); reopened via the "How it works" pill.
 */

// ── Per-step mini illustrations (small, real-looking app previews) ──
function ArtWelcome() {
  return (
    <div className="tour-art welcome">
      <div className="ta-mark">P</div>
      <div className="ta-coin"><Icon.Wallet width="22" height="22" /></div>
      <div className="ta-ping" />
    </div>
  );
}
function ArtAccept({ t }) {
  return (
    <div className="tour-art">
      <div className="ta-amount">₹250</div>
      <div className="ta-keys">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => <span key={k}>{k}</span>)}
      </div>
      <div className="ta-cta"><Icon.Qr width="14" height="14" /> {t("tour.s2Cta")}</div>
    </div>
  );
}
function ArtMoney({ t }) {
  return (
    <div className="tour-art">
      <div className="ta-pill">{t("tour.s3Earnings")} · ₹4,250</div>
      <div className="ta-bal-label">{t("tour.s3Received")}</div>
      <div className="ta-bal">$1,240</div>
      <div className="ta-row"><span className="ta-dot in" /> + $24.50 <span className="ta-ago">2 min</span></div>
    </div>
  );
}
function ArtActivity({ t }) {
  return (
    <div className="tour-art">
      <div className="ta-filters"><span className="on">{t("tour.s4All")}</span><span>{t("tour.s4Sales")}</span><span>{t("tour.s4Settled")}</span></div>
      {[["+$24.50", t("tour.s4Settled"), "in"], ["+$50.00", t("tour.s4Settling"), "in"], ["−$100", t("tour.s4ToBank"), "out"]].map(([a, s, d], i) => (
        <div className="ta-row" key={i}>
          <span className={`ta-dot ${d}`} /> {a}
          <span className="ta-badge">{s}</span>
        </div>
      ))}
    </div>
  );
}
function ArtWithdraw({ t }) {
  return (
    <div className="tour-art">
      <div className="ta-bal-label">{t("tour.s5Ready")}</div>
      <div className="ta-bal">$1,116</div>
      <div className="ta-opt sel"><Icon.Bank width="16" height="16" /> {t("tour.s5Bank")} <span className="ta-chk">✓</span></div>
      <div className="ta-opt"><Icon.Wallet width="16" height="16" /> {t("tour.s5Usdc")}</div>
    </div>
  );
}

const STEPS = [
  { art: ArtWelcome, titleKey: "tour.s1Title", textKey: "tour.s1Text" },
  { art: ArtAccept, titleKey: "tour.s2Title", textKey: "tour.s2Text" },
  { art: ArtMoney, titleKey: "tour.s3Title", textKey: "tour.s3Text" },
  { art: ArtActivity, titleKey: "tour.s4Title", textKey: "tour.s4Text" },
  { art: ArtWithdraw, titleKey: "tour.s5Title", textKey: "tour.s5Text" },
];

const KEY = "payqr.tourDone";
const NEW_KEY = "payqr.tourPending"; // set at login for a first-time device

export function tourSeen() {
  if (typeof window === "undefined") return true;
  try { return localStorage.getItem(KEY) === "1"; } catch { return true; }
}

/** Called from login after a successful sign-in. If this device has already
 *  completed the tour, DON'T reset it — otherwise a returning user (or one who
 *  just finished the tour on the login screen) would be shown it again on the
 *  dashboard. Only flag genuinely-fresh devices so the dashboard auto-opens it
 *  once for a first-time user who logged in before the tour was shown. */
export function flagNewUser() {
  try {
    if (localStorage.getItem(KEY) === "1") return; // already seen — leave it
    localStorage.setItem(NEW_KEY, "1");
  } catch {}
}
export function AppTour({ force = false, onClose }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (force) { setOpen(true); setI(0); return; }
    // Auto-open for anyone who hasn't completed the tour yet on this device —
    // this covers first-time users (flagged at login) and any fresh login
    // where the tour was never finished. Once finished, it won't show again.
    if (!tourSeen()) { setOpen(true); setI(0); }
  }, [force]);

  function finish() {
    try {
      localStorage.setItem(KEY, "1");
      localStorage.setItem(NEW_KEY, "0"); // consume the pending flag
    } catch {}
    setOpen(false);
    onClose?.();
  }

  if (!open) return null;
  const step = STEPS[i];
  const Art = step.art;
  const last = i === STEPS.length - 1;

  return (
    <div className="tour-overlay" role="dialog" aria-modal="true">
      <div className="tour-card">
        <button className="tour-x" onClick={finish} aria-label="Close">✕</button>

        {/* illustrated preview */}
        <div className="tour-stage" key={i}>
          <Art t={t} />
        </div>

        <div className="tour-body">
          <div className="tour-num">
            {i === 0 ? t("tour.getStarted") : t("tour.step").replace("{n}", String(i)).replace("{total}", String(STEPS.length - 1))}
          </div>
          <div className="tour-title">{t(step.titleKey)}</div>
          <div className="tour-text">{t(step.textKey)}</div>
        </div>

        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((_, k) => <i key={k} className={k === i ? "on" : ""} />)}
          </div>
          <div className="tour-btns">
            {i > 0 && <button className="tour-skip" onClick={() => setI(i - 1)}>{t("tour.back")}</button>}
            <button className="tour-next" onClick={() => (last ? finish() : setI(i + 1))}>
              {last ? t("tour.done") : t("tour.next")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
