import { stringToHex, hexToString, type Hex } from "viem";

/**
 * Client-side encryption for the merchant's PAYOUT HANDLE (UPI / PIX / CBU).
 *
 * WHY: the on-chain contract stores the handle as an opaque `bytes` blob and
 * never sees the plaintext — the raw handle must never be public on-chain (it's
 * real-world financial PII: anyone could map a merchant wallet → their bank id).
 * So we encrypt it IN THE BROWSER before it ever goes on-chain, and decrypt it
 * back in the browser for display. There is no backend — the ciphertext lives on
 * the chain, the key lives in the merchant's own relay identity.
 *
 * KEY: the merchant's own relay identity (see components/useRelayIdentity.ts) —
 * a per-address keypair persisted in localStorage. We encrypt the handle TO the
 * merchant's own relay pubkey (self-recipient), so only they can read it back.
 * The SDK's ECIES (`encryptPaymentAddress`/`decryptPaymentAddress`, secp256k1 +
 * AES-GCM) is the same vetted crypto the SELL/payout flow uses.
 *
 * WIRE FORMAT: `encryptPaymentAddress` yields a compact hex CIPHER STRING
 * (cipherStringify). We store it on-chain as UTF-8 `bytes` (stringToHex) so ANY
 * cipher string round-trips exactly; on read we hexToString back to the cipher
 * string before decrypting. (This is the same cipherStringify text the widget's
 * deliverFiatPayout submits — we just persist a self-encrypted copy for display.)
 *
 * CROSS-DEVICE CAVEAT: the relay identity is per-device localStorage (wiped on
 * logout). On a fresh device the merchant gets a NEW relay key, so a handle
 * encrypted with the OLD key can't be decrypted there — `decryptPayout` returns
 * null and the UI shows a neutral "saved" label instead of garbage. The merchant
 * can always re-enter the handle (updateProfile re-encrypts to the new key). No
 * funds are ever at risk — this value is display/pre-fill convenience only; the
 * actual payout is collected fresh by the Cashout widget at withdraw time.
 */

type RelayIdentity = { address: `0x${string}`; publicKey: string; privateKey: `0x${string}` };

/**
 * Sentinel plaintext used ONLY to satisfy registerMerchant's on-chain requirement
 * for non-empty encPayoutId bytes when a merchant completes onboarding with just
 * a shop name (payout handle added later via Settings → updateProfile). It is a
 * real ciphertext (so it round-trips through decryptPayout like any other value)
 * but callers MUST check for it and treat it as "no payout set yet" — never show
 * it or prefill it into a withdrawal form as if it were a real UPI/PIX/CBU handle.
 */
export const PAYOUT_PLACEHOLDER = "__unset__";

/** Encrypt any plaintext string to the merchant's own relay key (self-recipient)
 *  → on-chain `bytes` (0x-hex), using the SDK's ECIES (secp256k1 + AES-GCM).
 *  Shared primitive behind encryptPayout (below) and payment-links' encrypted
 *  description (lib/paymentLinks.ts's buildCreateLinkCalldata caller) — same
 *  crypto, same wire format, different field on-chain. Throws only on a
 *  genuine crypto failure or empty input; `errorMessage` customizes the latter
 *  for the caller's own field name. */
export async function encryptToSelf(
  plain: string,
  identity: RelayIdentity,
  errorMessage = "Could not secure this value. Please try again."
): Promise<Hex> {
  // Guard the primitive itself: empty/whitespace input must never be
  // encrypted-and-stored (it would decrypt back to "" and render as a
  // confusing falsy state). Callers should pre-validate too, but this keeps
  // the shared primitive safe for any future caller.
  if (!plain || !plain.trim()) {
    throw new Error(errorMessage);
  }
  const { encryptPaymentAddress } = await import("@p2pdotme/sdk/orders");
  const res = await encryptPaymentAddress({
    paymentAddress: plain,
    recipientPublicKey: identity.publicKey, // self-recipient: only the merchant can read it
    senderIdentity: identity,
  });
  // neverthrow ResultAsync — unwrap explicitly.
  if (!res.isOk()) {
    throw new Error(errorMessage);
  }
  // Persist the cipher STRING as UTF-8 bytes so it round-trips exactly.
  return stringToHex(res.value);
}

/** Encrypt a plaintext payout handle to the merchant's own relay key → on-chain
 *  `bytes` (0x-hex). Throws only on a genuine crypto failure (caller handles). */
export async function encryptPayout(plain: string, identity: RelayIdentity): Promise<Hex> {
  return encryptToSelf(plain, identity, "Enter a payout ID before saving.");
}

/** Decrypt an on-chain `bytes` payout blob back to plaintext, or null if it
 *  can't be decrypted on this device (different/absent relay key) or is empty.
 *  Never throws — display code treats null as "no readable handle". */
export async function decryptPayout(
  onchain: Hex | string | undefined,
  identity: RelayIdentity | null | undefined
): Promise<string | null> {
  if (!onchain || onchain === "0x" || !identity) return null;
  try {
    const cipherStr = hexToString(onchain as Hex); // bytes → cipher string
    if (!cipherStr) return null;
    const { decryptPaymentAddress } = await import("@p2pdotme/sdk/orders");
    const res = await decryptPaymentAddress({ encrypted: cipherStr, recipientIdentity: identity });
    return res.isOk() ? res.value : null;
  } catch {
    return null;
  }
}
