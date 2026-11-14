"use client";

import { useCallback, useRef, useState } from "react";
import { useActiveWallet, useProfiles } from "thirdweb/react";
import { inAppWallet, preAuthenticate } from "thirdweb/wallets/in-app";
import { thirdwebClient } from "../lib/thirdweb";

/**
 * Step-up (2FA) before money leaves the account.
 *
 * The merchant logs in with phone or Google through a thirdweb in-app wallet.
 * To move funds we make them prove it again: a fresh SMS code (phone), email
 * code (email) or Google popup, verified by thirdweb. The proof is checked
 * against the logged-in account: the re-authenticated EOA must equal the active
 * wallet's admin EOA, so a different phone/Google account cannot pass.
 *
 * Uses a throw-away in-app wallet instance and never calls disconnect() on it
 * (that would wipe the shared stored session and log the merchant out).
 *
 * This is a client-side gate. It stops a walk-up on an unlocked device or a
 * stolen session cookie, but it is not an on-chain control: someone who can run
 * their own code with the live session can still sign directly.
 */
const TTL_MS = 5 * 60 * 1000;
const KEY = "payqr.stepUp";

function recentlyVerified(addr: string) {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return !!v && v.addr === addr && Date.now() - v.at < TTL_MS;
  } catch { return false; }
}
function markVerified(addr: string) {
  try { sessionStorage.setItem(KEY, JSON.stringify({ addr, at: Date.now() })); } catch { /* ignore */ }
}

type Method = { strategy: "phone"; phoneNumber: string }
  | { strategy: "email"; email: string }
  | { strategy: "google" };

export function useStepUp() {
  const wallet = useActiveWallet();
  const { data: profiles } = useProfiles({ client: thirdwebClient });
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const adminAddr = (wallet as any)?.getAdminAccount?.()?.address as string | undefined;

  const method: Method | null = (() => {
    const p: any = profiles?.[0];
    if (!p) return null;
    if (p.type === "phone" && p.details?.phone) return { strategy: "phone", phoneNumber: p.details.phone };
    if (p.type === "email" && p.details?.email) return { strategy: "email", email: p.details.email };
    if (p.type === "google") return { strategy: "google" };
    return null;
  })();

  const finish = useCallback((ok: boolean) => {
    setOpen(false); setCode(""); setSent(false); setError(""); setBusy(false);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const sendCode = useCallback(async (m: Method) => {
    if (m.strategy === "google") return;
    setBusy(true); setError("");
    try {
      await preAuthenticate({ client: thirdwebClient, ...m } as any);
      setSent(true);
    } catch (e: any) {
      setError(e?.message || "Couldn't send the code. Try again.");
    } finally { setBusy(false); }
  }, []);

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

  const verify = useCallback(async () => {
    if (!method || !adminAddr) return;
    setBusy(true); setError("");
    try {
      const tmp = inAppWallet();
      const acct = await tmp.connect(
        method.strategy === "google"
          ? { client: thirdwebClient, strategy: "google" }
          : ({ client: thirdwebClient, ...method, verificationCode: code.trim() } as any)
      );
      if (acct.address.toLowerCase() !== adminAddr.toLowerCase()) {
        setError("That doesn't match the account you're signed in with.");
        setBusy(false);
        return;
      }
      markVerified(adminAddr);
      finish(true);
    } catch (e: any) {
      setError(method.strategy === "google" ? "Google verification was cancelled or failed." : "That code didn't work. Check it and try again.");
      setBusy(false);
    }
  }, [method, adminAddr, code, finish]);

  const modal = open && method ? (
    <div className="confirm-overlay" style={{ zIndex: 1000 }}>
      <div className="confirm-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-h">Verify it's you</div>
        <p className="confirm-sub">
          {method.strategy === "phone" && `Enter the code we texted to ${method.phoneNumber}.`}
          {method.strategy === "email" && `Enter the code we emailed to ${method.email}.`}
          {method.strategy === "google" && "Confirm with your Google account to continue."}
        </p>
        {method.strategy !== "google" && (
          <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
            placeholder="123456" value={code} disabled={!sent || busy}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            style={{ textAlign: "center", letterSpacing: 4 }} />
        )}
        {error && <p className="error" style={{ textAlign: "center", marginTop: 8 }}>{error}</p>}
        <div className="confirm-actions">
          <button className="btn ghost" disabled={busy} onClick={() => finish(false)}>Cancel</button>
          <button className="btn" onClick={verify}
            disabled={busy || (method.strategy !== "google" && code.length < 4)}>
            {busy ? "Checking…" : method.strategy === "google" ? "Continue with Google" : "Verify"}
          </button>
        </div>
        {method.strategy !== "google" && (
          <button type="button" className="btn ghost" style={{ marginTop: 8 }} disabled={busy}
            onClick={() => sendCode(method)}>Resend code</button>
        )}
      </div>
    </div>
  ) : null;

  return { requireStepUp, stepUpModal: modal };
}
