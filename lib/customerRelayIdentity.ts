/**
 * Relay identity for the WALLETLESS Payment Links customer — deliberately
 * independent of thirdweb/useSmartAccount. useRelayIdentity() (in
 * components/useRelayIdentity.ts) is the MERCHANT's identity hook: it's keyed
 * by their thirdweb smart-account address, because a merchant is always
 * authenticated. A customer opening /pay/[linkId] is never authenticated —
 * per PAYMENT-LINKS.md, "no auth, no wallet provider, the customer never sees
 * a connect prompt" — so there is no address to key anything by, and no
 * wallet to wait on.
 *
 * All this identity is for is encrypting/decrypting the LP's payout address
 * (UPI ID, PIX key, etc.) end-to-end between the LP and this browser — it's a
 * bare ECIES keypair, not a blockchain account. createRelayIdentity() is a
 * pure, local, synchronous function (see @p2pdotme/sdk/orders) — no network,
 * no wallet, no signature.
 */
// TYPE-ONLY import. The runtime half is loaded on demand below.
//
// The SDK's order module carries the ECIES stack (asn1.js/elliptic), which is
// 98 kB gzipped — the single largest thing on the customer's pay page, and the
// page has no use for it until somebody actually pays. Every other SDK import
// in this app was already deferred; this one was static, so it pulled all of it
// into the first paint of the one page that loads on a phone over mobile data.
import type { RelayIdentity, RelayIdentityStore } from "@p2pdotme/sdk/orders";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// Own dedicated slot — NOT components/useRelayIdentity.ts's merchant prefix
// (payqr.relay:<address>) and NOT the widget's own legacy global key
// (@P2PME:RELAY_IDENTITY, which useRelayIdentity.syncToSdkStore mirrors into
// for the MERCHANT's Checkout/Cashout widgets). A customer's browser has no
// merchant address to scope by and never touches that widget global.
const CUSTOMER_RELAY_KEY = "payqr.customerRelay";

let cachedStore: RelayIdentityStore | null = null;

/** The relay identity store for customerOrder.ts's createOrders() client. */
export async function customerRelayStore(): Promise<RelayIdentityStore> {
  if (!cachedStore) {
    const { createLocalStorageRelayStore } = await import("@p2pdotme/sdk/orders");
    cachedStore = createLocalStorageRelayStore({ key: CUSTOMER_RELAY_KEY });
  }
  return cachedStore;
}

/** Get-or-create the customer's relay keypair. No wallet, no address, no
 *  network call — safe to call on first paint of a public, unauthenticated
 *  page. */
export async function getCustomerIdentity(): Promise<RelayIdentity> {
  const store = await customerRelayStore();
  const existing = await store.get();
  if (existing?.publicKey && existing?.privateKey) return existing;
  const { createRelayIdentity } = await import("@p2pdotme/sdk/orders");
  const fresh = createRelayIdentity();
  await store.set(fresh);
  return fresh;
}

/**
 * The customer's relay identity as a viem signing account.
 *
 * RelayIdentity is a plain secp256k1 keypair (address + privateKey), not an
 * ECIES-only key — it's the SAME key the worker derives `customerKey` from
 * via publicKeyToAddress(pubKey) when placing a link order (see
 * worker/src/pay.ts). That's what lets it double as the EIP-712 signer
 * LinkRouter checks on markPaid/cancel (payment-integrators PR #104) — no
 * second keypair needed.
 */
export async function getCustomerSigner(): Promise<PrivateKeyAccount> {
  const identity = await getCustomerIdentity();
  return privateKeyToAccount(identity.privateKey);
}
