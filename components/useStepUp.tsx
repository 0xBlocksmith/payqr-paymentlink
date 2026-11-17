"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveWallet, useProfiles } from "thirdweb/react";
import { inAppWallet, preAuthenticate } from "thirdweb/wallets/in-app";
import { thirdwebClient } from "../lib/thirdweb";
import { OtpInput } from "./ui/OtpInput";
import { useT } from "../lib/i18n";
import { fill } from "../lib/format";

/**
 * Step-up (2FA) for sensitive actions. Used by dispute appeals; it is NOT part
 * of the withdraw flows (removed there).
 *
 * The merchant logs in with phone or Google through a thirdweb in-app wallet.
 * To move funds we make them prove it again: a fresh one-time code by SMS
 * (phone) or a Google confirmation, verified by thirdweb. The proof is
 * checked against the logged-in account: the re-authenticated EOA must equal the
 * active wallet's admin EOA, so a different phone/Google account cannot pass.
 *
 * Google accounts have no code to type — a Google sign-in is the verification,
 * so those users get a single "Continue with Google".
 *
 * Uses a throw-away in-app wallet instance and never calls disconnect() on it
 * (that would wipe the shared stored session and log the merchant out).
 *
 * This is a client-side gate. It stops a walk-up on an unlocked device or a
 * stolen session cookie, but it is not an on-chain control.
 *
 * UI: the verification is a PAGE, not a card popup. `stepUpView` is the page
 * content (render it in place of your screen while `stepUpOpen` is true);
 * `stepUpModal` is the same view wrapped as a full-screen layer for callers that
 * cannot swap their own content.
 */
const TTL_MS = 5 * 60 * 1000;
const KEY = "payqr.stepUp";
const RESEND_SECS = 30;
const CODE_LEN = 6;

function recentlyVerified(addr: string) {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return !!v && v.addr === addr && Date.now() - v.at < TTL_MS;
  } catch { return false; }
}
function markVerified(addr: string) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ addr, at: Date.now() })); } catch { /* ignore */ }
}

// PayQR signs merchants in with a phone number or Google only.
type Method = { strategy: "phone"; phoneNumber: string }
  | { strategy: "google" };

function maskPhone(p: string) {
  const d = p.replace(/\s/g, "");
  return d.length <= 4 ? d : `${d.slice(0, Math.min(3, d.length - 4))}••••${d.slice(-4)}`;
}
export function useStepUp() {
  const { t } = useT();
  const wallet = useActiveWallet();
  const { data: profiles } = useProfiles({ client: thirdwebClient });
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const adminAddr = (wallet as any)?.getAdminAccount?.()?.address as string | undefined;

  const method: Method | null = (() => {
    const p: any = profiles?.[0];
    if (!p) return null;
    if (p.type === "phone" && p.details?.phone) return { strategy: "phone", phoneNumber: p.details.phone };
    if (p.type === "google") return { strategy: "google" };
    return null;
  })();

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const finish = useCallback((ok: boolean) => {
    setOpen(false); setCode(""); setSent(false); setError(""); setBusy(false); setCooldown(0);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const sendCode = useCallback(async (m: Method) => {
    if (m.strategy === "google") return;
    setBusy(true); setError(""); setCode("");
    try {
      await preAuthenticate({ client: thirdwebClient, ...m } as any);
      setSent(true);
      setCooldown(RESEND_SECS);
    } catch (e: any) {
      setError(e?.message || t("su.sendFail"));
    } finally { setBusy(false); }
  }, [t]);

  /** Resolves true when the merchant is verified (now or within the last 5 min). */
  const requireStepUp = useCallback((): Promise<boolean> => {
    if (!adminAddr) return Promise.resolve(false);
    if (recentlyVerified(adminAddr)) return Promise.resolve(true);
    if (!method) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
      void sendCode(method);
    });
  }, [adminAddr, method, sendCode]);

  const verify = useCallback(async (typed?: string) => {
    if (!method || !adminAddr) return;
    const c = (typed ?? code).trim();
    if (method.strategy !== "google" && c.length < CODE_LEN) return;
    setBusy(true); setError("");
    try {
      const tmp = inAppWallet();
      const acct = await tmp.connect(
        method.strategy === "google"
          ? { client: thirdwebClient, strategy: "google" }
          : ({ client: thirdwebClient, ...method, verificationCode: c } as any)
      );
      if (acct.address.toLowerCase() !== adminAddr.toLowerCase()) {
        setError(t("su.mismatch"));
        setBusy(false);
        return;
      }
      markVerified(adminAddr);
      finish(true);
    } catch {
      setError(method.strategy === "google" ? t("su.googleFail") : t("su.badCode"));
      setCode("");
      setBusy(false);
    }
  }, [method, adminAddr, code, finish, t]);

  const isOpen = open && !!method;

  const view = isOpen && method ? (
    <div className="su-page" role="region" aria-labelledby="su-title">
      <button type="button" className="wallet-back" disabled={busy} onClick={() => finish(false)}>
        ‹ {t("su.cancel")}
      </button>

      <div className="su-hero">
        <span className="su-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2.2 2.2L15.5 10" /></svg>
        </span>
        <h1 id="su-title">{t("su.title")}</h1>
        <p className="su-sub">
          {method.strategy === "phone" && fill(t("su.subPhone"), { to: maskPhone(method.phoneNumber) })}
          {method.strategy === "google" && t("su.subGoogle")}
        </p>
      </div>

      {method.strategy !== "google" ? (
        <>
          <OtpInput value={code} onChange={setCode} onComplete={(v) => verify(v)}
            disabled={!sent || busy} invalid={!!error} length={CODE_LEN} />
          <div className="su-status" role="status" aria-live="polite">
            {busy ? (sent ? t("su.checking") : t("su.sending")) : error ? <span className="error">{error}</span> : null}
          </div>
          <div className="su-resend">
            {cooldown > 0
              ? <span className="muted">{fill(t("su.resendIn"), { s: cooldown })}</span>
              : <button type="button" className="linklike" disabled={busy} onClick={() => sendCode(method)}>{t("su.resend")}</button>}
          </div>
        </>
      ) : (
        <>
          <div className="su-status" role="status">{error && <span className="error">{error}</span>}</div>
          <div className="wd-slide">
            <button className="btn" disabled={busy} onClick={() => verify()}>
              {busy ? t("su.checking") : t("su.google")}
            </button>
          </div>
        </>
      )}
    </div>
  ) : null;

  // Same page, wrapped as a full-screen layer for screens that can't swap content.
  const modal = isOpen && typeof document !== "undefined"
    ? createPortal(<div className="su-layer"><div className="screen">{view}</div></div>, document.body)
    : null;

  return { requireStepUp, stepUpModal: modal, stepUpView: view, stepUpOpen: isOpen };
}
