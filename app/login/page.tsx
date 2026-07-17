"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/useAuth";
import { flagNewUser, tourSeen, AppTour } from "../../components/AppTour";
import { Logo, Icon } from "../../components/Icons";
import { Splash } from "../../components/Splash";
import { InstallButton } from "../../components/InstallButton";
import { ThemeButton } from "../../components/ThemeButton";
import { useT } from "../../lib/i18n";
import { isUserCancel } from "../../lib/contract";
import {
  COUNTRIES, LANGUAGES, loadCountry,
  saveCountry, markPrefsSet, prefsSet,
} from "../../lib/countries";

export default function Login() {
  const router = useRouter();
  const { ready, authenticated, login } = useAuth();
  const { t, lang, setLang } = useT();
  const [showTour, setShowTour] = useState(false);
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [openMenu, setOpenMenu] = useState<null | "country" | "lang">(null);
  const [loginError, setLoginError] = useState("");
  const langLabel = LANGUAGES.find((l) => l.code === lang)?.label || "English";

  // ISO-2 code per country for real flag images (emoji flags don't render on Windows).
  const CC: Record<string, string> = { india: "in", brazil: "br", argentina: "ar" };
  const flagUrl = (id: string) => `https://flagcdn.com/w40/${CC[id] || "un"}.png`;

  // Only bounce an authenticated user off the login page once their prefs are
  // set — otherwise they're here precisely to pick currency/language. Without
  // this guard, an authenticated-but-no-prefs user ping-pongs /login <-> /
  // forever (the "/" gate sends no-prefs users back to /login), which Chrome
  // throttles as a navigation loop.
  useEffect(() => {
    if (ready && authenticated && prefsSet()) router.replace("/");
  }, [ready, authenticated, router]);

  useEffect(() => {
    setCountry(loadCountry());
  }, []);

  // Show the "how it works" tour ONCE per device — only for a visitor who has
  // never completed it (tourSeen() checks the localStorage flag AppTour writes on
  // finish). A returning user who already saw it isn't shown it again on every
  // login-page visit; they can still reopen it via the "How it works" button.
  // Skip entirely for an already-authenticated session (they're redirected to /).
  useEffect(() => {
    if (ready && !authenticated && !tourSeen()) setShowTour(true);
  }, [ready, authenticated]);

  async function onLogin() {
    // Persist the country pick so the app is country-aware immediately (harmless
    // even if login is then cancelled).
    saveCountry(country.id);
    // Already signed in (e.g. returned here only to pick prefs)? Don't reopen
    // the connect modal — just proceed; "/" now routes to the dashboard since
    // prefs are set. Otherwise open the thirdweb connect modal (email/Google).
    if (authenticated) { markPrefsSet(); router.replace("/"); return; }
    setLoginError("");
    try {
      await login();
      // Only mark prefs "set" AFTER a successful login — otherwise a cancelled
      // connect would persist "prefs set" with no account, and the next visit
      // would skip the prefs nudge despite the user never finishing setup.
      markPrefsSet();
      // Flag the how-it-works tour for a first-time device (AppTour's own
      // localStorage gate means a returning user won't re-see it).
      flagNewUser();
      router.replace("/");
    } catch (e) {
      // A closed modal / user-cancel is fine — stay quietly on the login page.
      // But a REAL failure (offline, misconfigured client id) must say
      // something, or the Login button just silently does nothing.
      if (!isUserCancel(e)) {
        setLoginError("Couldn't connect — check your internet and try again.");
      }
    }
  }

  // While auth is still resolving on a cold start, show the splash instead of the
  // login card — otherwise a returning (already-authenticated) user briefly sees
  // the full login UI during the / → /login → / settle before being redirected.
  if (!ready) return <Splash />;

  return (
    <div className="login-screen">
      <AppTour force={showTour} onClose={() => setShowTour(false)} />

      <div className="login-card">
        {/* top bar: product name + download / theme symbols on the right */}
        <div className="login-bar">
          <div className="login-name">PayQR</div>
          <div className="login-bar-actions">
            <InstallButton variant="icon" />
            <ThemeButton />
          </div>
        </div>
        <h1 className="login-headline">{t("login.headline")}</h1>

        {/* PayQR logo orbited by country pills travelling ON a circle */}
        <div className="orbit-illu">
          {/* the dashed orbit circle */}
          <svg className="orbit-svg" viewBox="0 0 240 240" fill="none" aria-hidden="true">
            <circle className="orbit-arc" cx="120" cy="120" r="92" />
          </svg>

          {/* PayQR logo in the center (no glow) */}
          <div className="orbit-logo">
            <Logo size={84} />
          </div>

          {/* country pills ride ON the circle, evenly spaced, staying upright */}
          {COUNTRIES.map((c, i) => (
            <span key={c.id} className="pmpill"
              style={{ animationDelay: `${-(12 / COUNTRIES.length) * i}s` }}>
              <img className="pm-flag" src={flagUrl(c.id)} alt="" />
              <span className="pm-name">{c.fiat}</span>
            </span>
          ))}
        </div>

        <div className="login-sub">{t("login.selectPrefs")}</div>
        <div className="login-drops">
          {/* currency — custom dropdown */}
          <div className="picker">
            <button className={`picker-btn ${openMenu === "country" ? "on" : ""}`}
              onClick={() => setOpenMenu(openMenu === "country" ? null : "country")}>
              <img className="pk-flag-img" src={flagUrl(country.id)} alt="" />
              <span className="pk-text">{country.symbol} {country.code}</span>
              <span className="pk-car">▾</span>
            </button>
            {openMenu === "country" && (
              <div className="picker-pop">
                {COUNTRIES.map((c) => (
                  <button key={c.id} className={`picker-item ${c.id === country.id ? "sel" : ""}`}
                    onClick={() => { setCountry(c); saveCountry(c.id); setOpenMenu(null); }}>
                    <img className="pk-flag-img" src={flagUrl(c.id)} alt="" />
                    <span className="pk-item-txt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
                    {c.id === country.id && <span className="pk-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* language — custom dropdown */}
          <div className="picker">
            <button className={`picker-btn ${openMenu === "lang" ? "on" : ""}`}
              onClick={() => setOpenMenu(openMenu === "lang" ? null : "lang")}>
              <span className="pk-globe">🌐</span>
              <span className="pk-text">{langLabel}</span>
              <span className="pk-car">▾</span>
            </button>
            {openMenu === "lang" && (
              <div className="picker-pop">
                {LANGUAGES.map((l) => (
                  <button key={l.code} className={`picker-item ${l.code === lang ? "sel" : ""}`}
                    onClick={() => { setLang(l.code as any); setOpenMenu(null); }}>
                    <span className="pk-item-txt">{l.label}</span>
                    {l.code === lang && <span className="pk-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Terms link — a real <a> to the hosted Terms of Service, opened in a
            new tab so it doesn't drop the user mid-login. The /{lang}/ segment
            matches the legal site's locale prefix, falling back to English. */}
        <p className="login-terms">{t("login.terms")}{" "}
          <a className="login-terms-link"
            href={`https://www.payqr.pro/${lang || "en"}/legal/terms-of-service`}
            target="_blank" rel="noopener noreferrer">{t("login.termsLink")}</a></p>

        <button className="btn login-btn" disabled={!ready} onClick={onLogin}>
          {ready ? t("login.login") : t("login.loading")}
        </button>
        {loginError && <p className="error" style={{ textAlign: "center", marginTop: 8 }}>{loginError}</p>}
        <button className="login-howto" onClick={() => setShowTour(true)}>
          <Icon.Compass width="15" height="15" /> {t("login.howto")}
        </button>
      </div>
    </div>
  );
}
