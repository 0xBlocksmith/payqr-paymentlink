"use client";

import { useRef, useState, type ReactNode } from "react";
import { useT } from "../lib/i18n";
import { LANGUAGES } from "../lib/countries";
import { useDismiss } from "./useDismiss";
import { useTheme } from "./theme";

/**
 * The header shared by the glass pages (/login, /onboarding): the PayQR mark on
 * the left (the same bar as the /p payer page), optional extra actions, and the
 * language selector on the right. Picking a language applies everywhere at once.
 */
export function GlassHeader({ children }: { children?: ReactNode }) {
  const { t, lang, setLang } = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const { resolved, setTheme } = useTheme();
  const dark = resolved === "dark";
  const label = LANGUAGES.find((l) => l.code === lang)?.label || "English";

  return (
    <header className="lg-top">
      <img className="lg-logo" src="/payqr-mark-sm.png" alt="PayQR" width={44} height={28} />
      <div className="lg-actions">
        {children}
        <button className="glass-icon-btn" onClick={() => setTheme(dark ? "light" : "dark")}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}>
          {dark ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
          )}
        </button>
        <div className="lg-rel" ref={ref}>
          <button className="glass-btn glass-btn--sm" aria-haspopup="listbox" aria-expanded={open}
            aria-label={`${t("login.language")}: ${label}`} onClick={() => setOpen((o) => !o)}>
            <span style={{ display: "inline-flex", width: 18, height: 18 }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.9 3.1 2.9 14.9 0 18M12 3c-2.9 3.1-2.9 14.9 0 18" />
              </svg>
            </span>
            {label}
            <svg className="lg-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {open && (
            <div className="glass glass-pop lg-lang-pop" role="listbox" aria-label={t("login.language")}>
              {LANGUAGES.map((l) => (
                <button key={l.code} role="option" aria-selected={l.code === lang} className="glass-opt"
                  onClick={() => { setLang(l.code as any); setOpen(false); }}>
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
