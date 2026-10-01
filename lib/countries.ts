/**
 * Country / currency config — the single source of truth for multi-country UI.
 *
 * Adding a new country later = add one entry here (and make sure its circle has
 * a p2p seller). The contract already accepts any currency as a parameter on the
 * order side; the withdraw side reads `code` once the `withdrawFiat` change ships.
 */
import type { Country, Language } from "./types";

export const COUNTRIES: Country[] = [
  {
    id: "india",
    flag: "🇮🇳",
    name: "India",
    code: "INR",
    symbol: "₹",
    fiat: "UPI",
    payoutLabel: "UPI ID",
    payoutPlaceholder: "name@upi",
    validatePayout: (v) => v.includes("@"),
    locale: "en-IN",
  },
  {
    id: "brazil",
    flag: "🇧🇷",
    name: "Brazil",
    code: "BRL",
    symbol: "R$",
    fiat: "PIX",
    payoutLabel: "PIX key",
    payoutPlaceholder: "pix@key.br / CPF / phone",
    validatePayout: (v) => v.trim().length >= 3,
    locale: "pt-BR",
  },
  {
    id: "argentina",
    flag: "🇦🇷",
    name: "Argentina",
    code: "ARS",
    // Bare "$" reads as USD outside Argentina (where it's the normal peso
    // sign) — every amount in this app is shown next to other currencies
    // (INR/BRL), so use the unambiguous ISO code instead. Trailing space so
    // bare `${symbol}${amount}` concatenation sites read "ARS 500", not the
    // squished "ARS500".
    symbol: "ARS ",
    fiat: "Transfers 3.0",
    payoutLabel: "CBU / alias",
    payoutPlaceholder: "alias.mp / CBU",
    validatePayout: (v) => v.trim().length >= 3,
    locale: "es-AR",
  },
  {
    id: "venezuela",
    flag: "🇻🇪",
    name: "Venezuela",
    // The p2p.me protocol keys Venezuela's circle/price as "VEN" (its SDK's
    // CURRENCY.VEN), NOT the ISO "VES" — the on-chain bytes32 must match or no
    // circle/price is ever found. Same reason the SDK uses "MEX" for Mexico.
    code: "VEN",
    // Trailing space for the same reason as ARS: "Bs 500", not "Bs500".
    symbol: "Bs ",
    fiat: "Pago Móvil",
    payoutLabel: "Pago Móvil (phone|Cédula/RIF|bank)",
    payoutPlaceholder: "04121234567|V12345678|Banesco",
    validatePayout: isPagoMovil,
    locale: "es-VE",
  },
];

/** Pago Móvil payout handle in the p2p.me SDK's compound "phone|RIF|bank" form
 *  (the same shape its Cashout widget packs), so a saved handle round-trips. */
function isPagoMovil(v: string): boolean {
  const parts = v.split("|");
  if (parts.length !== 3) return false;
  const phone = parts[0].replace(/\D/g, "");
  return /^0?4\d{9}$/.test(phone) &&
    /^[VEJGRP]\d+$/.test(parts[1].trim().toUpperCase()) &&
    parts[2].trim().length > 0;
}

export const DEFAULT_COUNTRY: Country = COUNTRIES[0];

export function getCountry(id: string | null | undefined): Country {
  return COUNTRIES.find((c) => c.id === id) || DEFAULT_COUNTRY;
}

/**
 * Resolve a display config for ANY currency code the protocol can settle — not
 * only the ones listed above.
 *
 * The list above is a UI convenience, but which currencies actually exist is
 * decided elsewhere: the protocol's live circles (see p2p.ts's
 * `fetchSupportedCurrencies`, read from the subgraph) and whatever a merchant
 * registered on-chain. Those move without this file moving, so a currency that
 * is perfectly real here can be absent above.
 *
 * The old lookup — `getCountry(COUNTRIES.find(c => c.code === code)?.id)` —
 * handled that by returning DEFAULT_COUNTRY, which is India. So an unlisted
 * currency did not degrade, it LIED: a link priced in a currency this file has
 * never heard of rendered its amounts with a ₹ and Indian digit grouping, to a
 * customer about to send real money. Showing the wrong currency symbol on a
 * payment screen is worse than showing a plain one.
 *
 * So an unknown code degrades to something honest instead: the ISO code as its
 * own symbol, neutral grouping, and a generic bank-transfer rail. Every field
 * stays populated, so callers need no special case — and adding a country to
 * the list above still upgrades it to the local symbol, rail name and payout
 * validator, exactly as before.
 */
export function countryForCurrency(code: string | null | undefined): Country {
  const wanted = String(code || "").trim().toUpperCase();
  const known = COUNTRIES.find((c) => c.code === wanted);
  if (known) return known;
  if (!wanted) return DEFAULT_COUNTRY;

  return {
    id: `currency:${wanted}`,
    flag: "🌐",
    name: wanted,
    code: wanted,
    // Trailing space for the same reason ARS has one: bare `${symbol}${amount}`
    // concatenation would otherwise read "MXN500".
    symbol: `${wanted} `,
    fiat: "Bank transfer",
    payoutLabel: "Payment address",
    payoutPlaceholder: "",
    validatePayout: (v) => v.trim().length >= 3,
    // Neutral grouping. Never inherit another country's locale — en-IN would
    // render 100000 as "1,00,000" for a currency that does not group that way.
    locale: "en",
  };
}

const KEY = "payqr.country";
const LANG_KEY = "payqr.lang";
const DONE_KEY = "payqr.prefsSet";

export const LANGUAGES: Language[] = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
];

/** Read the merchant's chosen country (UI preference, localStorage). */
export function loadCountry(): Country {
  if (typeof window === "undefined") return DEFAULT_COUNTRY;
  try {
    return getCountry(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_COUNTRY;
  }
}

export function saveCountry(id: string): void {
  try { localStorage.setItem(KEY, id); } catch {}
}

/** Has the merchant completed the country+language step? */
export function prefsSet(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return false; }
}
export function markPrefsSet(): void {
  try { localStorage.setItem(DONE_KEY, "1"); } catch {}
}

/**
 * Clear all per-merchant browser state on LOGOUT. Without this, a shared device
 * leaks one merchant's data into the next account: the p2p RELAY IDENTITY (so
 * merchant B would place orders whose payout comms are encrypted to merchant A's
 * key), the pending-sale banner, and the country/language/onboarding prefs.
 * thirdweb's own disconnect only clears its session, not our app storage.
 */
export function clearLocalUserData(): void {
  const exact = [
    KEY, LANG_KEY, DONE_KEY,
    "payqr.pendingSession",     // an unfinished sale (qr page)
    "payqr.dismissedStuck",     // locally-dismissed stuck orders (qr/dashboard)
    "payqr.tourDone", "payqr.tourPending",
    "@P2PME:RELAY_IDENTITY",    // legacy global relay keypair (pre address-scoping)
  ];
  // Prefix-match: every per-address relay identity (payqr.relay:0x…) — so a
  // shared device never leaves one merchant's payout key for the next account.
  try {
    exact.forEach((k) => localStorage.removeItem(k));
    // Prefix-match: per-address relay identities AND cached merchant profiles —
    // so a shared device never leaves one merchant's payout key or shop name for
    // the next account.
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith("payqr.relay:") || k.startsWith("payqr.merchantProfile:"))) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/** Format a fiat amount with the country's symbol + locale grouping.
 *  `decimals` = MAXIMUM fraction digits: whole amounts stay clean ("₹500"),
 *  amounts that carry cents show them in full ("₹10.50") instead of being
 *  rounded to a different number than the customer actually paid ("₹11").
 *  Defaults to 2 — every fiat figure here is money (an estimate, a cap, a
 *  charge), and rounding to whole units silently drops real value for
 *  currencies with a low USDC rate (ARS, BRL): "50 USDC ≈ $78,697.42 ARS"
 *  rounded to "$78,697" looked "fine" only because the missing 42 centavos
 *  are imperceptible at that scale, while in es-AR/pt-BR locales the
 *  thousands separator is "." — so a rounded whole number like 78697 renders
 *  as "78.697", which reads as a fractional amount instead of a whole one. */
export function fmtFiat(
  country: Country,
  amount: number | string,
  opts: { decimals?: number } = {}
): string {
  const { decimals = 2 } = opts;
  const n = Number(amount) || 0;
  const min =
    decimals > 0 && !Number.isInteger(Number(n.toFixed(decimals))) ? decimals : 0;
  const grouped = n.toLocaleString(country.locale, {
    minimumFractionDigits: min,
    maximumFractionDigits: decimals,
  });
  return `${country.symbol}${grouped}`;
}

/** "<symbol> <code>" for a currency picker row (e.g. "₹ INR", "R$ BRL") — but
 *  when the symbol IS the code (ARS's symbol is the ISO code itself, trimmed
 *  of its trailing space), skip the symbol so it doesn't read "ARS  ARS". */
export function fmtSymbolCode(country: Country): string {
  const sym = country.symbol.trim();
  return sym === country.code ? country.code : `${sym} ${country.code}`;
}
