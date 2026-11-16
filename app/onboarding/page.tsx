"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { encodeFunctionData, stringToHex } from "viem";
import { useMerchant } from "../../components/useMerchant";
import { Splash } from "../../components/Splash";
import { GlassHeader } from "../../components/GlassHeader";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../lib/contract";
import { loadCountry, prefsSet, saveCountry, COUNTRIES } from "../../lib/countries";
import { useT } from "../../lib/i18n";
import { fill } from "../../lib/format";
import { toUserError, type UserError } from "../../lib/errors";
import { SettlementNote } from "../../components/ui/SettlementNote";
import { GlassError } from "../../components/ui/GlassError";
import { LoadingState } from "../../components/ui/LoadingState";
import "../../styles/glass.css";      // the glass design system (reference: /login)
import "../../styles/glass-page.css"; // the shared full-screen glass page shell

/** How many "what does your business do?" suggestions there are (ob.sug.1 … N).
 *  (Not exported: Next.js only allows specific exports from a page file.) */
const SECTOR_SUGGESTIONS = 8;

// ISO-2 code per country for the flag image.
const CC: Record<string, string> = { india: "in", brazil: "br", argentina: "ar", venezuela: "ve" };

/**
 * Registration — the first screen a NEW account sees after logging in
 * (the root route sends unregistered accounts here).
 *
 * Full-screen, in the same soft glass style as /login. Two questions:
 *   1. Business name — free text.
 *   2. What does your business do? — SEMI-OPEN: tap a suggestion or type your own.
 * Then registerMerchant on-chain (gas-free).
 *
 * No payout handle (UPI/PIX/CBU) is collected anywhere any more. The contract
 * still takes the field, so registration sends EMPTY payout bytes ("0x").
 */
export default function Onboarding() {
  const router = useRouter();
  const { t } = useT();
  const { ready, authenticated, isRegistered, sendTransaction, refetchRegistered } = useMerchant({
    requireRegistered: false,
  });
  const publicClient = usePublicClient();

  const [country, setCountry] = useState(null);
  const [cOpen, setCOpen] = useState(false);
  const [shopName, setShopName] = useState("");
  const [sector, setSector] = useState("");
  const [touched, setTouched] = useState({ name: false, sector: false });
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<"" | "wallet" | "register" | "confirm">("");
  const [error, setError] = useState<UserError | string | null>(null);
  // Registration was submitted but could not be confirmed in time. The business
  // may well exist; never ask the merchant to register again — just re-check.
  const [unconfirmed, setUnconfirmed] = useState(false);

  // Keep the latest sendTransaction in a ref so the submit poll loop sees the
  // smart wallet becoming ready (the value changes after first render).
  const sendRef = useRef(sendTransaction);
  useEffect(() => { sendRef.current = sendTransaction; }, [sendTransaction]);

  // Set once we've just registered from THIS screen so the "already registered
  // → /dashboard" effect below doesn't race our own navigation.
  const justRegistered = useRef(false);

  useEffect(() => {
    // Country/language must be chosen first.
    if (!prefsSet()) { router.replace("/login"); return; }
    setCountry(loadCountry());
  }, [router]);

  useEffect(() => {
    if (isRegistered === true && !justRegistered.current) router.replace("/dashboard");
  }, [isRegistered, router]);

  // Inline validation (bytes, not characters: the contract caps the name at 128
  // BYTES and the sector at 31 — non-Latin scripts take 3 bytes a character).
  const bytes = (v: string) => new TextEncoder().encode(v.trim()).length;
  const nameErr = !shopName.trim() ? t("ob.err.name") : bytes(shopName) > 128 ? t("ob.err.nameLong") : "";
  const sectorErr = !sector.trim() ? t("ob.err.sector") : bytes(sector) > 31 ? t("ob.err.sectorLong") : "";

  const suggestions = Array.from({ length: SECTOR_SUGGESTIONS }, (_, i) => t(`ob.sug.${i + 1}`));
  const picked = (s: string) => sector.trim().toLowerCase() === s.toLowerCase();

  const uncertainErr = (): UserError => ({ message: t("err.timeout"), kind: "timeout", uncertain: true, ref: "" });

  function done() {
    justRegistered.current = true;
    router.replace("/dashboard?welcome=1");
  }

  async function checkAgain() {
    setBusy(true); setError(null);
    try {
      const r: any = await refetchRegistered?.();
      if (r?.data === true) return done();
      setError(uncertainErr());
    } catch {
      setError(t("err.network"));
    } finally { setBusy(false); }
  }

  async function submit(e?: { preventDefault?: () => void }) {
    e?.preventDefault?.();
    if (busy) return;
    setError(null);
    setTouched({ name: true, sector: true });
    if (!country) return setError(t("ob.err.loading"));
    if (nameErr || sectorErr) return;
    setBusy(true);
    let submitted = false;
    try {
      // Wait for the smart wallet to initialise (a few seconds on first login).
      setStage("wallet");
      let tries = 0;
      while (!sendRef.current && tries < 40) {
        await new Promise((r) => setTimeout(r, 400));
        tries++;
      }
      const send = sendRef.current;
      if (!send) { setBusy(false); setStage(""); return setError(t("ob.err.wallet")); }

      // EMPTY payout bytes: the handle is added later from Settings (see header).
      const encPayout = "0x" as `0x${string}`;
      // The contract locks the offramp currency at registration (3rd arg).
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "registerMerchant",
        args: [encPayout, shopName.trim(), country.code, stringToHex(sector.trim(), { size: 32 })],
      });

      justRegistered.current = true; // before the tx resolves: the flag flip must not redirect us
      setStage("register");
      const hash = await send({ to: CONTRACT_ADDRESS, data });
      submitted = true;

      setStage("confirm");
      let receipt: any = null;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      } catch { /* slow receipt: fall through to the on-chain flag below */ }
      if (receipt?.status === "reverted") {
        justRegistered.current = false;
        setBusy(false); setStage("");
        return setError(t("ob.err.reverted"));
      }

      // Refresh the cached `registered` read BEFORE navigating, so the next page
      // doesn't see a stale `false` and bounce back here.
      let confirmed = receipt?.status === "success";
      try {
        const r: any = await refetchRegistered?.();
        if (r?.data === true) confirmed = true;
      } catch { /* handled below */ }

      if (confirmed) return done();
      // Submitted, outcome unknown. Do NOT claim failure or ask to retry.
      setUnconfirmed(true);
      setError(uncertainErr());
      setBusy(false); setStage("");
    } catch (err) {
      if (!submitted) justRegistered.current = false; // nothing was sent — re-arm the guard
      setError(toUserError(err, { context: "register", fallbackKey: "ob.err.generic", uncertainKey: submitted ? "err.timeout" : undefined }));
      if (submitted) setUnconfirmed(true);
      setBusy(false); setStage("");
    }
  }

  // Auth gate — a logged-out deep-link must not flash an interactive form.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <div className="glass-root lg-page"><LoadingState label={t("ui.loading")} /></div>;

  const stageLabel = stage === "wallet" ? t("ob.stage.wallet") : stage === "register" ? t("ob.stage.register") : stage === "confirm" ? t("ob.stage.confirm") : "";

  return (
    <div className="glass-root lg-page">
      <div className="lg-lights" aria-hidden="true" />
      <div className="lg-inner">
        <GlassHeader />

        <main className="lg-main ob-main">
          <div>
            <h1 className="lg-h1">{t("ob.biz.title")}</h1>
            <p className="lg-sub">{t("ob.biz.sub")}</p>
          </div>

          {/* The country this business will be paid in. It is locked on-chain once
              registered, so it is confirmable (and fixable) right here. */}
          <div className="lg-rel ob-country">
            <button type="button" className="glass-btn glass-btn--sm" aria-haspopup="listbox" aria-expanded={cOpen}
              onClick={() => setCOpen((o) => !o)}>
              <img className="lg-flag" src={`https://flagcdn.com/w40/${CC[country.id] || "un"}.png`} alt=""
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
              {country.name} · {country.code} · {country.fiat}
              <svg className="lg-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {cOpen && (
              <div className="glass glass-pop" role="listbox" style={{ top: "calc(100% + 8px)", left: "50%", transform: "translateX(-50%)", minWidth: 240 }}>
                {COUNTRIES.map((c) => (
                  <button key={c.id} type="button" role="option" aria-selected={c.id === country.id} className="glass-opt"
                    onClick={() => { saveCountry(c.id); setCountry(c); setCOpen(false); }}>
                    <img className="lg-flag" src={`https://flagcdn.com/w40/${CC[c.id] || "un"}.png`} alt="" />
                    <span style={{ flex: 1 }}>{c.name}<small>{c.code} · {c.fiat}</small></span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <form id="ob-form" className="ob-form" onSubmit={submit} noValidate>
            <div>
              <label className="glass-label" htmlFor="ob-name">{t("ob.biz.nameLabel")}</label>
              <input id="ob-name" className="glass-input" value={shopName} autoComplete="organization"
                enterKeyHint="next" placeholder={t("ob.biz.namePh")} disabled={busy}
                aria-invalid={touched.name && !!nameErr} aria-describedby={touched.name && nameErr ? "ob-name-err" : undefined}
                onBlur={() => setTouched((x) => ({ ...x, name: true }))}
                onChange={(e) => setShopName(e.target.value)} />
              {touched.name && nameErr && <div id="ob-name-err" className="ob-err" role="alert">{nameErr}</div>}
            </div>

            {/* SEMI-OPEN question: suggestions to tap, or type your own. */}
            <div>
              <label className="glass-label" htmlFor="ob-sector">{t("ob.biz.doLabel")}</label>
              <div className="ob-chips" role="group" aria-label={t("ob.biz.doLabel")}>
                {suggestions.map((s) => (
                  <button key={s} type="button" className="glass glass-chip glass-chip--btn" aria-pressed={picked(s)}
                    disabled={busy} onClick={() => { setSector(picked(s) ? "" : s); setTouched((x) => ({ ...x, sector: true })); }}>
                    {s}
                  </button>
                ))}
              </div>
              <input id="ob-sector" className="glass-input" style={{ marginTop: 12 }} value={sector} enterKeyHint="done"
                placeholder={t("ob.biz.doPh")} disabled={busy}
                aria-invalid={touched.sector && !!sectorErr} aria-describedby={touched.sector && sectorErr ? "ob-sector-err" : "ob-sector-hint"}
                onBlur={() => setTouched((x) => ({ ...x, sector: true }))}
                onChange={(e) => setSector(e.target.value)} />
              {touched.sector && sectorErr
                ? <div id="ob-sector-err" className="ob-err" role="alert">{sectorErr}</div>
                : <div id="ob-sector-hint" className="ob-hint">{t("ob.biz.doHint")}</div>}
            </div>

            <div className="ob-notes">
              <SettlementNote currency={country.code} />
              <span>{t("ob.shop.lock")}</span>
            </div>

            <GlassError error={error} />
          </form>
        </main>

        {/* pinned bottom: the primary action */}
        <footer className="lg-foot">
          {!unconfirmed ? (
            <button className="glass-btn glass-btn--primary glass-btn--lg glass-btn--block" type="submit" form="ob-form" disabled={busy}>
              {busy ? (stageLabel || t("ui.loading")) : t("ob.shop.cta")}
            </button>
          ) : (
            <button className="glass-btn glass-btn--primary glass-btn--lg glass-btn--block" type="button" disabled={busy} onClick={checkAgain}>
              {t("link.checkNow")}
            </button>
          )}
          {busy && <LoadingState inline label={stageLabel} slowAfterMs={15000} timeoutMs={90000} onRetry={() => window.location.reload()} />}
          {!busy && !unconfirmed && (
            <div className="ob-foot-actions">
              <button type="button" className="lg-link" onClick={() => router.replace("/login")}>{t("ob.changePrefs")}</button>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
