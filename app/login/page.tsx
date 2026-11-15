"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/useAuth";
import { flagNewUser, tourSeen, AppTour } from "../../components/AppTour";
import { Splash } from "../../components/Splash";
import { InstallButton } from "../../components/InstallButton";
import { GlassHeader } from "../../components/GlassHeader";
import { GlassError } from "../../components/ui/GlassError";
import { useDismiss } from "../../components/useDismiss";
import { Icon } from "../../components/Icons";
import { useLockPeriod } from "../../components/useLockPeriod";
import { useT } from "../../lib/i18n";
import { fmtCountdown, fmtLockWindow } from "../../lib/format";
import { toUserError, type UserError } from "../../lib/errors";
import { FLOW_STILL, flowFrame } from "../../lib/flowDemo";
import {
  COUNTRIES, loadCountry,
  saveCountry, markPrefsSet, prefsSet, fmtSymbolCode,
} from "../../lib/countries";
import "../../styles/glass.css"; // the glass design system (reference page — pending approval)
import "../../styles/glass-page.css";

/* ── icons: one consistent 1.6px stroke, currentColor ─────────────────── */
const Svg = ({ children, sw = 1.6 }: { children: ReactNode; sw?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
/** a phone showing a QR — the customer's local payment */
const IconPay = () => (
  <Svg>
    <rect x="5" y="2.5" width="14" height="19" rx="3" />
    <rect x="8" y="6" width="3" height="3" rx=".6" /><rect x="13" y="6" width="3" height="3" rx=".6" /><rect x="8" y="11" width="3" height="3" rx=".6" />
    <path d="M13 12h3M13 14.5h3M8 17.5h8" />
  </Svg>
);
/** a clock — the settlement period */
const IconClock = () => (<Svg><circle cx="12" cy="12" r="8.6" /><path d="M12 7.2V12l3.2 2" /></Svg>);
/** a wallet — the recipient */
const IconWallet = () => (
  <Svg>
    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17a2 2 0 0 1 2 2v1" />
    <rect x="3.5" y="8" width="17" height="11.5" rx="2.6" />
    <path d="M16 13.8h2.6" />
  </Svg>
);
/** a coin with a dollar sign — USDC */
const IconUsdc = () => (
  <Svg sw={1.9}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v10M14.5 9.4c-.4-.9-1.4-1.4-2.5-1.4-1.4 0-2.4.7-2.4 1.8 0 2.6 4.9 1.2 4.9 3.9 0 1.1-1.1 2-2.6 2-1.3 0-2.2-.5-2.7-1.4" />
  </Svg>
);
const IconCheck = () => (<Svg sw={2.4}><path d="m5 12.5 4.5 4.5L19 7.5" /></Svg>);
const Caret = () => (
  <svg className="lg-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
);

// ISO-2 code per country for real flag images (emoji flags don't render on Windows).
const CC: Record<string, string> = { india: "in", brazil: "br", argentina: "ar", venezuela: "ve" };
const flagUrl = (id: string) => `https://flagcdn.com/w40/${CC[id] || "un"}.png`;

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/**
 * ONE connected journey: a local payment enters, waits out the settlement period
 * inside a smart contract, and USDC is released to the recipient.
 *
 * ILLUSTRATIVE ONLY. Nothing here reads or moves real funds: the tokens are a
 * looping animation (lib/flowDemo.ts). The settlement period shown is the real
 * on-chain figure for the picked country; the countdown is an accelerated demo
 * of it. With reduced motion the flow is still and the countdown is not animated.
 */
function Journey({ country }: { country: (typeof COUNTRIES)[number] }) {
  const { t, lang } = useT();
  const { secs, loading, error, refetch } = useLockPeriod(country.code);
  const reduce = usePrefersReducedMotion();
  const [tNow, setTNow] = useState(0);

  // Drive the demo with rAF (paused automatically in a hidden tab), ~30 fps.
  useEffect(() => {
    if (reduce) return;
    let raf = 0;
    let last = 0;
    const start = performance.now();
    const loop = (now: number) => {
      if (now - last > 33) { last = now; setTNow((now - start) / 1000); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reduce]);

  const f = reduce ? FLOW_STILL : flowFrame(tNow);
  const periodText = fmtLockWindow(secs, lang);
  const m = periodText.match(/^(\d[\d.,]*)\s*(.*)$/);            // "15 days" → "15" + "days"
  const withDays = !!secs && secs >= 3 * 86400;
  const countdown = secs ? fmtCountdown(f.remaining * secs, withDays) : "";
  const C = 2 * Math.PI * 27;                                      // contract ring circumference

  return (
    <div className="lg-hero">
      <section className="lg-band" aria-label={`${t("login.flowPay")} → ${t("login.flowHold")} → ${t("login.flowUsdc")}`}>
        <div className="lg-glow" aria-hidden="true" style={{ opacity: 0.35 + f.glow * 0.65 }} />

        {/* the continuous track the whole journey travels along */}
        <div className="lg-track" aria-hidden="true">
          <span className="lg-track-base" />
          <span className="lg-track-fill" style={{ left: 0, width: `${f.payP * 50}%` }} />
          <span className="lg-track-fill" style={{ left: "50%", width: `${f.coinP * 50}%` }} />
          <span className="glass glass-chip lg-tok lg-tok--pay"
            style={{ left: `${15 + f.payP * 33}%`, opacity: f.payOpacity, transform: `translate(-50%, -50%) scale(${f.payScale})` }}>
            {country.symbol.trim()}
          </span>
          <span className="lg-tok lg-tok--usdc"
            style={{ left: `${60 + f.coinP * 28}%`, opacity: f.coinOpacity, transform: "translate(-50%, -50%)" }}>
            <IconUsdc />
          </span>
        </div>

        <div className="lg-cols">
          {/* 1 — local payment in */}
          <div className="lg-col">
            <div className="lg-ico-box"><span className="glass lg-ico"><IconPay /></span></div>
            <div className="lg-lab">{t("login.flowPay")}<small>{country.fiat}</small></div>
          </div>

          {/* 2 — the smart contract holds it for the settlement period */}
          <div className="lg-col lg-col--mid">
            <div className="lg-ico-box">
              <svg className="lg-ring" viewBox="0 0 64 64" aria-hidden="true">
                <defs><linearGradient id="lgRing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#4b78ee" /><stop offset="1" stopColor="#1d5be0" /></linearGradient></defs>
                <circle cx="32" cy="32" r="27" fill="none" stroke="rgba(75,120,238,.18)" strokeWidth="3" />
                <circle cx="32" cy="32" r="27" fill="none" stroke="url(#lgRing)" strokeWidth="3" strokeLinecap="round"
                  strokeDasharray={`${C * f.remaining} ${C}`} transform="rotate(-90 32 32)" />
              </svg>
              <span className="glass lg-ico lg-ico--contract" style={{ boxShadow: `0 0 0 1px rgba(75,120,238,.14), 0 10px 24px -10px rgba(58,100,220,${0.12 + f.glow * 0.2})` }}><IconClock /></span>
            </div>
            <div className="lg-lab">{t("login.flowHold")}</div>

            {/* the settlement period + live countdown — the focal point */}
            <div className="lg-period" aria-live="off">
              {loading ? (
                <span className="lg-skel" />
              ) : error || !periodText ? (
                <button className="lg-link" onClick={() => refetch()}>{t("sn.unavailable")} · {t("sn.retry")}</button>
              ) : (
                <>
                  <span className="lg-eyebrow">{t("sn.window")}</span>
                  <span className="lg-per">
                    {m ? (<><b>{m[1]}</b><i>{m[2]}</i></>) : <b>{periodText}</b>}
                  </span>
                  <span className="lg-cd" role="timer" aria-label={periodText}>{f.unlocked ? t("login.unlocked") : countdown}</span>
                </>
              )}
            </div>
          </div>

          {/* 3 — USDC released to the recipient */}
          <div className="lg-col">
            <div className="lg-ico-box">
              <span className="glass lg-ico" style={{ transform: `scale(${1 + f.arrive * 0.06})` }}><IconWallet /></span>
              <span className="lg-badge" style={{ opacity: f.arrive > 0.05 || f.coinP >= 1 ? 1 : 0, transform: `scale(${f.arrive > 0.05 || f.coinP >= 1 ? 1 : 0.5})` }}><IconCheck /></span>
            </div>
            <div className="lg-lab">{t("login.flowUsdc")}</div>
          </div>
        </div>
      </section>
      <p className="lg-demo">{t("login.demo")}</p>
    </div>
  );
}

export default function Login() {
  const router = useRouter();
  const { ready, authenticated, login } = useAuth();
  const { t, lang } = useT();
  const [showTour, setShowTour] = useState(false);
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [openMenu, setOpenMenu] = useState<null | "country">(null);
  const [loginError, setLoginError] = useState<UserError | null>(null);
  const countryRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => setOpenMenu(null);
  useDismiss(countryRef, openMenu === "country", closeMenu);

  // Only bounce an authenticated user off the login page once their prefs are
  // set — otherwise they're here precisely to pick currency/language. Without
  // this guard, an authenticated-but-no-prefs user ping-pongs /login <-> /
  // forever (the "/" gate sends no-prefs users back to /login), which Chrome
  // throttles as a navigation loop.
  useEffect(() => {
    if (ready && authenticated && prefsSet()) router.replace("/");
  }, [ready, authenticated, router]);

  useEffect(() => { setCountry(loadCountry()); }, []);

  // Show the "how it works" tour ONCE per device — only for a visitor who has
  // never completed it. A returning user can still reopen it from the header.
  useEffect(() => {
    if (ready && !authenticated && !tourSeen()) setShowTour(true);
  }, [ready, authenticated]);

  async function onLogin() {
    // Persist the country pick so the app is country-aware immediately (harmless
    // even if login is then cancelled).
    saveCountry(country.id);
    // Already signed in (e.g. returned here only to pick prefs)? Don't reopen
    // the connect modal — just proceed.
    if (authenticated) { markPrefsSet(); router.replace("/"); return; }
    setLoginError(null);
    try {
      await login();
      // Only mark prefs "set" AFTER a successful login — a cancelled connect
      // must not persist "prefs set" with no account.
      markPrefsSet();
      flagNewUser(); // first-time device → how-it-works tour
      router.replace("/");
    } catch (e) {
      // A closed modal / user-cancel is fine — stay quietly on the page. A REAL
      // failure must say something, or the button just silently does nothing.
      const ue = toUserError(e, { context: "login", fallbackKey: "login.err.generic" });
      if (ue.kind !== "cancelled") setLoginError(ue);
    }
  }

  // While auth is still resolving on a cold start, show the splash — otherwise a
  // returning (already-authenticated) user briefly sees the login UI.
  if (!ready) return <Splash />;

  return (
    <div className="glass-root lg-page">
      <div className="lg-lights" aria-hidden="true" />
      <AppTour force={showTour} onClose={() => setShowTour(false)} />

      <div className="lg-inner">
        {/* header — the /p bar: logo left; install · how-it-works · language right */}
        <GlassHeader>
          <InstallButton variant="icon" />
          <button className="glass-icon-btn" onClick={() => setShowTour(true)}
            aria-label={t("login.howto")} title={t("login.howto")}>
            <Icon.Compass />
          </button>
        </GlassHeader>

        <main className="lg-main">
          <div>
            <h1 className="lg-h1">{t("login.title")}</h1>
            <p className="lg-sub">{t("login.sub")}</p>
          </div>
          <Journey country={country} />
        </main>

        {/* pinned bottom: country, then the primary action */}
        <footer className="lg-foot">
          <div className="lg-rel" ref={countryRef}>
            <p className="lg-field-cap" id="lg-country-cap">{t("login.country")}</p>
            <button className="glass-btn glass-btn--field glass-btn--block" aria-haspopup="listbox"
              aria-expanded={openMenu === "country"} aria-labelledby="lg-country-cap lg-country-val"
              onClick={() => setOpenMenu(openMenu === "country" ? null : "country")}>
              <span className="lg-field-main" id="lg-country-val">
                <img className="lg-flag" src={flagUrl(country.id)} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                {country.name} · {fmtSymbolCode(country)}
              </span>
              <Caret />
            </button>
            {openMenu === "country" && (
              <div className="glass glass-pop lg-country-pop" role="listbox" aria-label={t("login.country")}>
                {COUNTRIES.map((c) => (
                  <button key={c.id} role="option" aria-selected={c.id === country.id} className="glass-opt"
                    onClick={() => { setCountry(c); saveCountry(c.id); setOpenMenu(null); }}>
                    <img className="lg-flag" src={flagUrl(c.id)} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                    <span style={{ flex: 1 }}>{c.name}<small>{c.fiat} · {fmtSymbolCode(c)}</small></span>
                    {c.id === country.id && <span aria-hidden="true" style={{ color: "var(--g-blue)" }}>✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button className="glass-btn glass-btn--primary glass-btn--lg glass-btn--block" disabled={!ready} onClick={onLogin}>
            {ready ? t("login.login") : t("login.loading")}
          </button>
          <GlassError error={loginError} />

          {/* Terms — a real <a> to the hosted Terms of Service, in a new tab. The
              /{lang}/ segment matches the legal site's locale prefix. */}
          <p className="lg-terms">{t("login.terms")}{" "}
            <a href={`https://www.payqr.pro/${lang || "en"}/legal/terms-of-service`}
              target="_blank" rel="noopener noreferrer">{t("login.termsLink")}</a></p>
        </footer>
      </div>
    </div>
  );
}
