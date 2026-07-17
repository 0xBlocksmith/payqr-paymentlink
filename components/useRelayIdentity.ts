"use client";

import { useSmartAccount } from "./useSmartAccount";

/**
 * Lazily creates + persists the p2p relay identity (the keypair whose pubkey the
 * LP encrypts the payout details to) — SCOPED TO THE CONNECTED SMART-ACCOUNT
 * ADDRESS.
 *
 * SECURITY: the relay identity must never be shared across merchants on a shared
 * device. The p2p SDK's default store is a single global localStorage slot, so a
 * merchant who didn't formally log out could leave their key behind for the next
 * account to silently reuse — meaning merchant B's payout details would get
 * encrypted to merchant A's key (A could then decrypt B's UPI/PIX handle). To
 * make that impossible, we key the identity by the connected address: each
 * merchant gets their OWN keypair, and switching accounts can never adopt a stale
 * one. (clearLocalUserData still wipes them on logout as defence-in-depth.)
 */
const KEY_PREFIX = "payqr.relay:"; // + lowercased smart-account address
// The p2p SDK/widget's OWN relay store is a single global localStorage slot with
// this key (createLocalStorageRelayStore's DEFAULT_KEY). The Checkout/Cashout
// widgets place the order AND later decrypt the payer's UPI/PIX handle using
// WHATEVER identity lives here. Our app instead keeps a per-address identity (so
// two merchants on one device can't share a key). Those two stores must hold the
// SAME keypair, or the widget decrypts the payout with the wrong private key and
// shows "Session changed" instead of the real UPI/PIX id. syncToSdkStore() below
// mirrors our per-address identity into this global slot right before a widget
// mounts, keeping them in lockstep.
const SDK_GLOBAL_KEY = "@P2PME:RELAY_IDENTITY";

export function useRelayIdentity() {
  const { address } = useSmartAccount();

  async function getIdentity() {
    if (!address) throw new Error("Wallet not connected — cannot create a relay identity.");
    const { createRelayIdentity } = await import("@p2pdotme/sdk/orders");
    const storeKey = KEY_PREFIX + address.toLowerCase();

    // Read our per-address slot.
    let identity: any = null;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) identity = JSON.parse(raw);
    } catch { identity = null; }

    // Create + persist if missing or corrupt.
    if (!identity || !identity.publicKey || !identity.privateKey) {
      identity = createRelayIdentity();
      try { localStorage.setItem(storeKey, JSON.stringify(identity)); } catch {}
    }
    return identity;
  }

  // Mirror OUR per-address identity into the widget's global slot so the widget
  // places orders AND decrypts the returned payout with the SAME key. Without
  // this, the widget falls back to (or generates) a different global identity and
  // the payout it fetches at ACCEPTED decrypts to the literal "Session changed".
  // Call this right before mounting a Checkout/Cashout widget. Returns the identity.
  async function syncToSdkStore() {
    const identity = await getIdentity();
    try {
      const raw = localStorage.getItem(SDK_GLOBAL_KEY);
      // Only rewrite when it differs, so we don't thrash the widget's store on
      // every re-render (an identical write still fires a storage event elsewhere).
      if (raw !== JSON.stringify(identity)) {
        localStorage.setItem(SDK_GLOBAL_KEY, JSON.stringify(identity));
      }
    } catch { /* storage disabled — the widget will fall back to its own key */ }
    return identity;
  }

  return { getIdentity, syncToSdkStore };
}
// Note: clearing on logout/account-switch is centralized in
// lib/countries.ts:clearLocalUserData and useAuth's account-switch guard — both
// wipe payqr.relay:* and the widget's global @P2PME:RELAY_IDENTITY key.
