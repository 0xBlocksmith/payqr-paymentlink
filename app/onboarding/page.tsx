"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { useMerchant } from "../../components/useMerchant";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { Logo } from "../../components/Icons";
import { Splash } from "../../components/Splash";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, friendlyError } from "../../lib/contract";
import { encryptPayout } from "../../lib/payoutCrypto";
import { loadCountry, prefsSet } from "../../lib/countries";

/**
 * Registration only (country + language already chosen on /select). Shop name +
 * the country's payout field → registered ON-CHAIN via registerMerchant
 * (encPayoutId, shopName). The payout handle is CLIENT-SIDE ENCRYPTED to the
 * merchant's own relay key (encryptPayout) before it ever touches the chain — the
 * contract only ever stores opaque `bytes`, never the plaintext UPI/PIX/CBU.
 * Gas sponsored — no wallet popups.
 */
export default function Onboarding() {
  const router = useRouter();
  const { ready, authenticated, isRegistered, sendTransaction, refetchRegistered } = useMerchant({
    requireRegistered: false,
  });
  const { getIdentity } = useRelayIdentity();
  const publicClient = usePublicClient();

  const [country, setCountry] = useState(null);
  const [payoutId, setPayoutId] = useState("");
  const [shopName, setShopName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Keep the latest sendTransaction in a ref so the submit poll loop sees the
  // smart wallet becoming ready (the value changes after first render).
  const sendRef = useRef(sendTransaction);
  useEffect(() => { sendRef.current = sendTransaction; }, [sendTransaction]);

  // Set once we've just registered from THIS screen. The merchant came here by
  // tapping "Accept Payment", so after setup they must land on the terminal
  // (/qr) to enter an amount — NOT bounce to the dashboard. Without this guard
  // the "already registered → /dashboard" effect below fires the instant our own
  // refetchRegistered() flips isRegistered true, beating our router.replace("/qr").
  const justRegistered = useRef(false);

  useEffect(() => {
    // Country/language must be chosen first.
    if (!prefsSet()) { router.replace("/login"); return; }
    setCountry(loadCountry());
  }, [router]);

  // Already registered → go to dashboard (only once we actually know). But if we
  // JUST registered from this screen, submit() is taking them to /qr — don't
  // hijack that navigation to the dashboard.
  useEffect(() => {
    if (isRegistered === true && !justRegistered.current) router.replace("/dashboard");
  }, [isRegistered, router]);

  async function submit(e) {
    e.preventDefault();
    setError("");
    // country loads from localStorage in an effect; guard so submit can never
    // dereference a null country (would otherwise throw a raw TypeError on the
    // registration path). The form isn't shown until country loads, but a fast
    // submit / corrupted prefs shouldn't crash it.
    if (!country) return setError("Still loading your settings — try again in a second.");
    if (!shopName.trim()) return setError("Enter your shop name.");
    if (!country.validatePayout(payoutId.trim())) {
      return setError(`Enter a valid ${country.payoutLabel} (like ${country.payoutPlaceholder}).`);
    }
    setBusy(true);
    try {
      // Wait for the smart wallet to initialise (it can take a few seconds on
      // first login). Read via ref so we see it appear.
      let tries = 0;
      while (!sendRef.current && tries < 40) {
        await new Promise((r) => setTimeout(r, 400));
        tries++;
      }
      const send = sendRef.current;
      if (!send) {
        setBusy(false);
        return setError("Your gas-free wallet is still connecting. Wait a moment and try again.");
      }

      // Encrypt the payout handle to the merchant's OWN relay key before it ever
      // goes on-chain — the contract stores only opaque `bytes` (never the raw
      // UPI/PIX handle). Self-recipient: only this merchant can decrypt it back.
      const identity = await getIdentity();
      const encPayout = await encryptPayout(payoutId.trim(), identity);

      // The new contract locks the offramp currency at registration, so we pass
      // the chosen country's ISO code (e.g. "INR"/"BRL"/"ARS") as the 3rd arg.
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "registerMerchant",
        args: [encPayout, shopName.trim(), country.code],
      });
      // Mark BEFORE the tx resolves: refetchRegistered() below flips isRegistered
      // true and would trigger the /dashboard redirect effect otherwise.
      justRegistered.current = true;
      const hash = await send({ to: CONTRACT_ADDRESS, data });

      // Confirm the receipt; surface an on-chain revert instead of silently
      // routing on to /qr (which would bounce back here as still-unregistered).
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt?.status === "reverted") {
          setBusy(false);
          return setError("Registration failed on-chain. Please try again.");
        }
      } catch {
        // Receipt slow? Fall through — the refetched `registered` flag confirms it.
      }
      // Refresh the cached `registered` read BEFORE navigating. /qr reads the same
      // wagmi query key; without this it sees the stale `false` and bounces the
      // merchant back to onboarding → dashboard instead of the terminal.
      try { await refetchRegistered?.(); } catch {}
      // They came here from "Accept Payment" — continue to the terminal.
      router.replace("/qr");
    } catch (err) {
      justRegistered.current = false; // registration didn't complete — re-enable the guard
      console.error("register failed:", err);
      // friendlyError maps a user-cancel (MetaMask "User denied…"/4001, thirdweb
      // "User rejected", closed modal) to "Cancelled." and any contract revert to a
      // plain sentence — never a raw wallet string.
      setError(friendlyError(err, "Setup couldn't complete. Please try again."));
      setBusy(false);
    }
  }

  // Auth gate — same pattern as every other page. Without it, a logged-out
  // deep-link (e.g. expired thirdweb session with prefs still in localStorage)
  // flashes a fully interactive "Set up your shop" form that can even be
  // submitted (it spins on the wallet poll, then errors) before the redirect.
  if (!ready || !authenticated) return <Splash />;

  if (!country) {
    return <div className="onb-screen"><p className="muted">Loading…</p></div>;
  }

  return (
    <div className="onb-screen">
      <div className="onb-card">
        <div className="brand login-brand" style={{ marginBottom: 14 }}>
          <Logo size={28} className="brand-mark" /> PayQR
        </div>
        <h1 className="onb-h1">Set up<br />your shop</h1>
        <p className="muted onb-sub">
          {country.flag} {country.name} · you’re paid out in {country.code} ({country.fiat}).
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label>SHOP NAME</label>
            <input
              className="input"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              placeholder="My Shop"
            />
          </div>
          <div className="field">
            <label>{country.payoutLabel.toUpperCase()} (WHERE PAYOUTS LAND)</label>
            <input
              className="input"
              value={payoutId}
              onChange={(e) => setPayoutId(e.target.value)}
              placeholder={country.payoutPlaceholder}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
            Gas-free — we cover all network fees.
          </p>
          <button className="btn" disabled={busy} type="submit" style={{ width: "100%" }}>
            {busy ? "Setting up…" : "Open my terminal"}
          </button>
          {!ready && !busy && (
            <p className="muted" style={{ fontSize: 11.5, textAlign: "center", marginTop: 6 }}>
              Connecting your gas-free wallet…
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button
            type="button"
            className="onb-back"
            onClick={() => router.replace("/login")}
            disabled={busy}
          >
            ‹ Change country / language
          </button>
        </form>
      </div>
    </div>
  );
}
