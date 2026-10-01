"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient, useReadContract } from "wagmi";
import { encodeFunctionData, stringToHex } from "viem";
import { useMerchant } from "../../components/useMerchant";
import { Icon, Logo } from "../../components/Icons";
import { Splash } from "../../components/Splash";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, friendlyError } from "../../lib/contract";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { loadCountry, prefsSet } from "../../lib/countries";
import { codeToHex } from "../../lib/p2p";
import { STATIC_STALE_MS } from "../../lib/cache";

/**
 * Registration only (country + language already chosen on /select). Shop name
 * alone → registered ON-CHAIN via registerMerchant (encPayoutId, shopName).
 * The payout handle (UPI/PIX/CBU) is added later from Settings, where it's
 * CLIENT-SIDE ENCRYPTED (encryptPayout) before it touches the chain — the
 * contract only ever stores opaque `bytes`. The handle is OPTIONAL at
 * registration, so we send empty bytes and the contract requires one at
 * withdrawal instead. (This used to send an encrypted PAYOUT_PLACEHOLDER
 * sentinel to satisfy a non-empty check that no longer exists; Settings and the
 * cash-out widget still recognise that sentinel for older registrations.)
 */
export default function Onboarding() {
  const router = useRouter();
  const { ready, authenticated, isRegistered, sendTransaction, refetchRegistered } = useMerchant({
    requireRegistered: false,
  });
  const publicClient = usePublicClient();
  const { getIdentity } = useRelayIdentity();

  const [country, setCountry] = useState(null);
  const [shopName, setShopName] = useState("");
  const [sector, setSector] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Settlement/unlock window for the chosen country — surfaced HERE, before
  // the merchant can accept their first payment, not just after (when the
  // dashboard's live countdown is the only place this shows up and the money
  // is already locked). Reads on-chain lockPeriod directly so it's accurate
  // even before this merchant has any orders/buckets of their own.
  const currencyHex = country ? (codeToHex(country.code) as `0x${string}`) : undefined;
  const { data: lockSecs } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "lockPeriod",
    args: [currencyHex as `0x${string}`],
    query: { enabled: !!currencyHex, staleTime: STATIC_STALE_MS },
  });
  const settlementDays = lockSecs != null ? Math.max(1, Math.ceil(Number(lockSecs) / 86400)) : null;

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
    // The contract caps a shop name at 128 BYTES (FieldTooLong). Non-Latin
    // scripts take 3 bytes a character, so check bytes, not characters.
    if (new TextEncoder().encode(shopName.trim()).length > 128)
      return setError("That shop name is too long — please shorten it.");
    if (!sector.trim()) return setError("Enter what your business sells.");
    // bytes32 holds 31 bytes. Checked here so an over-long label is a sentence
    // the merchant can act on rather than an on-chain revert. Measured in BYTES,
    // not characters — a label with accented or non-Latin characters is longer
    // than it looks.
    if (new TextEncoder().encode(sector.trim()).length > 31)
      return setError("That business sector is too long — please shorten it.");
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

      // No real payout handle yet — it is added later from Settings, which
      // encrypts it before it touches the chain.
      //
      // We now send EMPTY bytes. registerMerchant used to reject those, which is
      // why this once encrypted a PAYOUT_PLACEHOLDER sentinel purely to get past
      // the check. The contract made the handle optional at registration and
      // moved the requirement to the withdrawal gate — so sending the sentinel
      // would now actively DEFEAT that guard, because a sentinel is non-empty
      // and the gate only tests for emptiness. A merchant would sail past it and
      // place a SELL whose fiat has nowhere to land.
      //
      // Settings and the cash-out widget still recognise the old sentinel, for
      // merchants who registered under the previous contract.
      const encPayout = "0x" as `0x${string}`;

      // The new contract locks the offramp currency at registration, so we pass
      // the chosen country's ISO code (e.g. "INR"/"BRL"/"ARS") as the 3rd arg.
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "registerMerchant",
        args: [encPayout, shopName.trim(), country.code, stringToHex(sector.trim(), { size: 32 })],
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
            <label>WHAT DO YOU SELL?</label>
            <input
              className="input"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              placeholder="e.g. Groceries, Salon, Electronics"
              maxLength={31}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            Gas-free — we cover all network fees. Add your {country.payoutLabel} later in Settings before you withdraw.
          </p>

          {/* Settlement-window explainer — a standalone section (not just a small
              muted line) so a new merchant can't miss that funds lock for a
              period before they're withdrawable, before they ever take a sale. */}
          <div className="onb-settle">
            <span className="onb-settle-ico"><Icon.Clock width="18" height="18" /></span>
            <div>
              <div className="onb-settle-h">How settlement works</div>
              <div className="onb-settle-sub">
                {settlementDays != null
                  ? <>Every sale settles to USDC on-chain, then unlocks for withdrawal after <b>{settlementDays} day{settlementDays === 1 ? "" : "s"}</b>. You can track the countdown any time from your dashboard.</>
                  : "Every sale settles to USDC on-chain, then unlocks for withdrawal after a short lock period. You can track the countdown any time from your dashboard."}
              </div>
            </div>
          </div>
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
