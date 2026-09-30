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
  // A shopkeeper behind the counter, a QR stand on the desk, and the customer's
  // phone-scan cue — the "in person" story, drawn instead of a keypad.
  return (
    <div className="tour-art">
      <div className="ta-pill">{t("tour.s2Pill")}</div>
      <svg viewBox="0 0 162 110" width="100%" role="img" aria-hidden="true">
        {/* person */}
        <circle cx="46" cy="30" r="12" fill="#f3c9a5" />
        <path d="M34 27c1-9 8-14 14-13 7 0 12 5 12 13-4-4-9-6-13-6-5 0-9 2-13 6z" fill="#2b2a4a" />
        <path d="M22 78c0-17 10-30 24-30s24 13 24 30z" fill="var(--accent)" />
        <circle cx="42" cy="31" r="1.2" fill="#2b2a4a" />
        <circle cx="51" cy="31" r="1.2" fill="#2b2a4a" />
        <path d="M43 36c2 2 6 2 8 0" stroke="#2b2a4a" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        {/* arm resting toward the stand */}
        <path d="M62 62c8 3 14 8 18 13" stroke="var(--accent)" strokeWidth="7" strokeLinecap="round" fill="none" />
        {/* desk */}
        <rect x="6" y="76" width="150" height="8" rx="3" fill="#8a6a4d" />
        <rect x="14" y="84" width="6" height="22" fill="#6d523b" />
        <rect x="142" y="84" width="6" height="22" fill="#6d523b" />
        {/* QR stand */}
        <path d="M108 76l6-8h24l6 8z" fill="#d9d7f2" />
        <rect x="110" y="34" width="34" height="42" rx="4" fill="#fff" stroke="var(--accent)" strokeWidth="2" />
        <rect x="116" y="40" width="22" height="22" rx="1.5" fill="var(--text)" />
        <rect x="118.5" y="42.5" width="6" height="6" fill="#fff" />
        <rect x="129.5" y="42.5" width="6" height="6" fill="#fff" />
        <rect x="118.5" y="53.5" width="6" height="6" fill="#fff" />
        <rect x="128" y="52" width="3" height="3" fill="#fff" />
        <rect x="132" y="56" width="3" height="3" fill="#fff" />
        <text x="127" y="71" textAnchor="middle" fontSize="6.5" fontWeight="800" fill="var(--accent)">PayQR</text>
      </svg>
      <div className="ta-cta"><Icon.Qr width="14" height="14" /> {t("tour.s2Cta")}</div>
    </div>
  );
}
function ArtLink({ t }) {
  return (
    <div className="tour-art">
      <div className="ta-pill">{t("tour.sLPill")}</div>
      <div className="ta-amount">₹1,200</div>
      <div className="ta-opt sel"><Icon.Link width="16" height="16" /> payqr.pro/pay/… <span className="ta-chk">✓</span></div>
      <div className="ta-cta" style={{ marginTop: 8 }}><Icon.Link width="14" height="14" /> {t("tour.sLCta")}</div>
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
  { art: ArtLink, titleKey: "tour.sLTitle", textKey: "tour.sLText" },
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
