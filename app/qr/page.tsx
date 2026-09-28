"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Splash } from "../../components/Splash";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, perTxCapUsdc, currencyFromBytes32 } from "../../lib/contract";
import { fetchUsdcRate } from "../../lib/rates";
import { fetchPriceConfig, usdcForFiat, usdcForUsdcTarget } from "../../lib/pricing";
import { STATIC_STALE_MS, loadMerchantProfile, saveMerchantProfile } from "../../lib/cache";
import { loadCountry, fmtFiat, fmtSymbolCode, COUNTRIES, getCountry } from "../../lib/countries";
import { loadPendingOrder, savePendingOrder, clearPendingOrder } from "../../lib/p2p";
import { fetchOrder, receiptToken } from "../../lib/history";
import type { PendingOrder } from "../../lib/p2p";
import { useT } from "../../lib/i18n";
import { EXPLORER_URL } from "../../lib/chain";
import { decryptPayout } from "../../lib/payoutCrypto";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import dynamic from "next/dynamic";

// Partially hide a payout handle for a SHAREABLE receipt: keep the first 2 chars
// and everything from "@"/domain, mask the middle. e.g. "sheldon@upi" → "sh•••@upi",
// "9876543210" → "98•••3210". Never exposes the full identifier on a public link.
// Mirrors transactions/page.tsx's maskHandle exactly.
function maskHandle(h: string): string {
  const s = (h || "").trim();
  if (!s) return "";
  const at = s.indexOf("@");
  if (at > 0) {
    const user = s.slice(0, at);
    const head = user.slice(0, 2);
    return `${head}${"•".repeat(Math.max(1, Math.min(3, user.length - 2)))}${s.slice(at)}`;
  }
  if (s.length <= 4) return s[0] + "•••";
  return `${s.slice(0, 2)}•••${s.slice(-4)}`;
}

const INTEGRATOR = CONTRACT_ADDRESS;
const SCAN = EXPLORER_URL;

const CheckoutWidget = dynamic(
  () => import("../../components/CheckoutWidget").then((m) => m.CheckoutWidget),
  { ssr: false }
);

// Quick-amount presets per country (local fiat).
const QUICK = { INR: [10, 20, 50], BRL: [5, 10, 20], ARS: [500, 1000, 2000] };
// Quick-amount presets when charging directly in USDC.
const QUICK_USDC = [1, 5, 10];

// Format the RAW typed amount for display: group the integer part with the
// country's locale but keep the decimal part EXACTLY as typed (so "10.", "10.1",
// "10.10" all render faithfully while the merchant is entering them). Passing the
// string through a number formatter would round/strip the in-progress decimal.
function fmtTyped(raw: string): string {
  if (!raw) return "0";
  const [intPart, decPart] = raw.split(".");
  // Group the integer part with a COMMA and keep "." as the decimal separator —
  // ALWAYS, regardless of locale. The keypad's decimal key inserts a ".", but
  // pt-BR / es-AR use "." as their THOUSANDS separator, so a locale formatter
  // turns "1000" into "1.000" (reads as a decimal) and "1000.50" into the
  // ambiguous "1.000.50". A fixed comma-group / dot-decimal keeps the amount
  // unmistakable and consistent with what the merchant typed.
  const grouped = (intPart || "0").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

// A short success chime + vibration — like every POS app.
function paymentFeedback() {
  try {
    if (navigator.vibrate) navigator.vibrate([40, 30, 60]);
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [880, 1175]; // a pleasant two-note "ding"
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    });
  } catch {}
}

export default function PosQr() {
  const router = useRouter();
  const { ready, authenticated, address, isRegistered } = useMerchant();
  const { t } = useT();
  const { getIdentity } = useRelayIdentity();

  const [country, setCountry] = useState(null);   // the currency THIS sale charges in
  const [payOpts, setPayOpts] = useState([]);     // countries the protocol can settle
  const [pickOpen, setPickOpen] = useState(false);
  const [amt, setAmt] = useState("");        // local fiat the merchant types
  const [lastAmt, setLastAmt] = useState(""); // for "repeat"
  const [inputMode, setInputMode] = useState<"fiat" | "usdc">("fiat"); // what `amt` is denominated in
  const [rate, setRate] = useState(null);           // p2p rate (on-chain price via rates.ts); used until priceCfg loads
  const [priceCfg, setPriceCfg] = useState(null);   // live on-chain price for `country` — the REAL charge price
  const [error, setError] = useState("");
  const [liveWidget, setLiveWidget] = useState(null);
  const [done, setDone] = useState(null);
  const [payError, setPayError] = useState("");
  const [busy, setBusy] = useState(false); // pricing the sale (reading on-chain buyPrice)
  const [imgBusy, setImgBusy] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  // A payment session that was started but not finished (widget closed / left)
  // BEFORE the order landed on-chain. Persisted so the merchant can RESUME it
  // instead of losing the sale, and can CANCEL a stuck one. Cleared on
  // complete/cancel. (Bug: closing the p2p dialog used to orphan the session
  // forever.)
  const [pendingSession, setPendingSession] = useState(null);
  const SESSION_KEY = "payqr.pendingSession";
  const SESSION_TTL_MS = 15 * 60 * 1000; // 15 min — a stale session auto-expires
  const [pending, setPending] = useState<PendingOrder | null>(null); // order placed on-chain but never finished

  // Default the sale currency to the merchant's registered country.
  useEffect(() => { setCountry(loadCountry()); }, []);

  // On load, restore a recent unfinished session (drop it if older than the TTL).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s?.startedAt || Date.now() - s.startedAt > SESSION_TTL_MS) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      setPendingSession(s);
    } catch { localStorage.removeItem(SESSION_KEY); }
  }, []);

  function saveSession(s) {
    const rec = { ...s, startedAt: Date.now() };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(rec)); } catch {}
    setPendingSession(rec);
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    setPendingSession(null);
  }
  function resumeSession() {
    if (!pendingSession) return;
    setPayError(""); setDone(null);
    // Restore the SAME currency the session was originally sized in — `country`
    // may have since reverted to the merchant's registered/home currency (e.g.
    // on a remount), and mounting the widget against the wrong currency prices
    // this session's usdcAmount using a different currency's on-chain rate.
    const sessionCountry =
      (pendingSession.countryId != null ? getCountry(pendingSession.countryId) : null) ||
      COUNTRIES.find((c) => c.code === pendingSession.currency) ||
      country;
    setCountry(sessionCountry);
    setLiveWidget({
      usdcAmount: BigInt(pendingSession.usdcAmount),
      quantity: BigInt(pendingSession.quantity),
      fiatAmount: pendingSession.fiatAmount != null ? BigInt(pendingSession.fiatAmount) : undefined,
      fiat: pendingSession.fiat, usdc: pendingSession.usdc, country: sessionCountry,
    });
  }

  // On mount, check for a payment that was placed on-chain but never finished
  // (e.g. merchant closed the QR dialog mid-payment) so it can be resumed
  // instead of silently lost.
  useEffect(() => { setPending(loadPendingOrder()); }, []);

  // Every configured country is selectable as the accept currency. The widget
  // resolves the circle for the picked currency at order time; if the protocol
  // adds a circle, nothing here changes.
  useEffect(() => { setPayOpts(COUNTRIES); }, []);

  // Accepting a payment requires registration. If the merchant reached here
  // without registering, send them to set up their shop first — but ONLY once the
  // registration read has actually resolved (ready). Redirecting on a raw/stale
  // `false` (e.g. mid account-switch, before the query re-keys to the new address)
  // would ping-pong a registered merchant /qr → /onboarding → /dashboard. Reusing
  // useMerchant.isRegistered (sequenced on saReady && !!address && !regLoading)
  // plus the `ready` gate makes the redirect fire only on a trustworthy false.
  useEffect(() => {
    if (ready && isRegistered === false) router.replace("/onboarding");
  }, [ready, isRegistered, router]);

  // Shop profile (name / registered currency) is static for the session — cache it.
  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  // Persist the (non-financial) profile so the shop name paints INSTANTLY on the
  // next visit while the fresh on-chain read confirms in the background.
  const [cachedProfile, setCachedProfile] = useState(() => loadMerchantProfile(address));
  useEffect(() => { setCachedProfile(loadMerchantProfile(address)); }, [address]);
  useEffect(() => { if (address && info) saveMerchantProfile(address, info); }, [address, info]);
  const shopLabel = info?.[1] || cachedProfile?.shopName || "";

  // Decrypt the merchant's own saved payout handle (getMerchantInfo[0]) once, so
  // a BUY receipt link can carry a MASKED version — "which account did I actually
  // pay?" for the customer, same mechanism the withdraw receipt already uses for
  // cash-outs. Best-effort: on a device without the relay key it stays "" and the
  // receipt simply omits the row (falls back to the wallet address only).
  const [upiMasked, setUpiMasked] = useState("");
  useEffect(() => {
    const enc = (info?.[0] as string) || "";
    if (!enc || enc === "0x") { setUpiMasked(""); return; }
    let alive = true;
    (async () => {
      try {
        const id = await getIdentity();
        const plain = await decryptPayout(enc, id);
        if (alive) setUpiMasked(plain ? maskHandle(plain) : "");
      } catch { if (alive) setUpiMasked(""); }
    })();
    return () => { alive = false; };
  }, [info, getIdentity]);

  const { data: daily, refetch: refetchDaily } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getDailyTxInfo",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const [used, limit] = daily ?? [0n, 25n];
  const limitReached = daily ? used >= limit : false;

  // LIVE per-tx cap: read perTxCap(registeredCurrency) straight from the contract
  // (info[2] is the registered currency as bytes32) so the cap ALWAYS matches
  // on-chain — including any admin setPerTxCap override — with no redeploy. Falls
  // back to the hardcoded 50/100 mirror only until this read resolves.
  const registeredCurrencyB32 = (info?.[2] as `0x${string}`) || undefined;
  const { data: liveCapRaw } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "perTxCap",
    args: [registeredCurrencyB32 as `0x${string}`],
    query: { enabled: !!registeredCurrencyB32 },
  });

  useEffect(() => {
    if (!country) return;
    let alive = true;
    const load = () => fetchUsdcRate(country).then((r) => alive && setRate(r));
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [country]);

  // Load the LIVE on-chain price for the selected currency — this is the rate
  // the checkout ACTUALLY charges at (getPriceConfig buyPrice + small-order fee).
  // rates.ts now sources the SAME on-chain price, so the estimate and this only
  // differ before it loads. We show the estimate off THIS so the "≈ X USDC" the
  // merchant sees before pressing Accept matches the checkout total exactly.
  useEffect(() => {
    if (!country) { setPriceCfg(null); return; }
    let alive = true;
    setPriceCfg(null); // clear stale price while the new currency's loads
    fetchPriceConfig(country.code)
      .then((cfg) => { if (alive) setPriceCfg(cfg ? { code: country.code, ...cfg } : { code: country.code, missing: true }); })
      .catch(() => { if (alive) setPriceCfg({ code: country.code, missing: true }); });
    return () => { alive = false; };
  }, [country]);

  // The on-chain buyPrice as a plain number of fiat-per-USDC, when it's for the
  // CURRENT currency and usable. This is what both the estimate and generate()
  // price against, so they always agree.
  const onchainRate =
    priceCfg && !priceCfg.missing && priceCfg.code === country?.code && priceCfg.buyPrice > 0n
      ? Number(priceCfg.buyPrice) / 1e6
      : null;
  // Effective fiat-per-USDC for the pre-submit estimate: prefer the freshly-read
  // on-chain price (what checkout charges); fall back to `rate` (also the p2p
  // on-chain price, via rates.ts) only until this dedicated read loads.
  const estRate = onchainRate ?? (rate ? rate.rate : null);

  const amtNum = Number(amt) || 0;
  // In USDC mode the typed number IS the USDC amount. In fiat mode the estimate
  // must match what generate()/checkout will actually charge:
  //  • With the on-chain price loaded, run the SAME usdcForFiat() inversion the
  //    order is sized with (it accounts for the small-order fixed fee), so the
  //    "≈ X USDC" equals the checkout amount to the cent.
  //  • Before that loads / for an unpriced currency, fall back to a plain
  //    market-rate division.
  const usdcEquiv =
    inputMode === "usdc"
      ? amtNum
      : amtNum > 0
        ? onchainRate && priceCfg && !priceCfg.missing
          ? Number(usdcForFiat(amtNum, priceCfg)) / 1e6
          : estRate
            ? amtNum / estRate
            : 0
        : 0;
  const fiatEquiv = inputMode === "usdc" ? (estRate && amtNum > 0 ? amtNum * estRate : 0) : amtNum;
  // Per-tx cap keys off the merchant's REGISTERED currency (what the contract
  // enforces in validateOrder), NOT the currency picked in the terminal — else
  // an INR merchant (50 cap) charging in BRL would be shown a 100 cap and the
  // on-chain placeOrder would revert ExceedsPerTxCap.
  // Prefer the LIVE on-chain cap (reflects admin setPerTxCap overrides); fall
  // back to the hardcoded 50/100 mirror only while the read is loading.
  const registeredCode = currencyFromBytes32(info?.[2] as string);
  const capUsdc =
    liveCapRaw != null
      ? Number(liveCapRaw) / 1e6
      : perTxCapUsdc(registeredCode || country?.code || "INR");
  const overCap = usdcEquiv > capUsdc;

  // MINIMUM-ORDER FLOOR (audit LOW): on small orders the Diamond adds a fixed
  // offramp fee (smallOrderFixedFee, in USDC) ON TOP of the principal. If the
  // merchant quotes a fiat amount BELOW that fee's fiat value, usdcForFiat sizes a
  // tiny principal and the widget's shown total is dominated by the fee — the
  // customer would be charged far more than the tiny amount typed. That's never a
  // loss to the merchant (they still net ~their quote in USDC and the widget shows
  // the real total before pay), but it's a confusing "why is ₹1 costing ₹40?"
  // trap. So require a fiat quote to at least cover its own fee. USDC-mode entry
  // has no such inversion, so it's unaffected. The floor is the fee's fiat value;
  // 0 when there's no small-order fee (or the price isn't loaded yet).
  const feeUsdc =
    priceCfg && !priceCfg.missing && priceCfg.code === country?.code
      ? Number(priceCfg.smallOrderFixedFee ?? 0n) / 1e6
      : 0;
  const minFiat = inputMode === "usdc" || !estRate ? 0 : feeUsdc * estRate;
  // <= (not <): a quote EXACTLY equal to the fee's fiat value inverts to a 0
  // principal + full fee, i.e. the customer would pay ~2× the quote for the
  // merchant to net ~the quote. Equality must be blocked too.
  const underMin = minFiat > 0 && amtNum > 0 && amtNum <= minFiat;

  function press(k) {
    setError("");
    setAmt((cur) => {
      if (k === "del") return cur.slice(0, -1);
      if (k === ".") return cur.includes(".") ? cur : (cur || "0") + ".";
      // Digit: max 2 decimal places once a "." is present.
      if (cur.includes(".")) {
        const decimals = cur.split(".")[1] ?? "";
        if (decimals.length >= 2) return cur;
      }
      const next = (cur + k).replace(/^0+(?=\d)/, "");
      // Cap total length so the display stays sane (10 chars incl. the dot).
      return next.length > 10 ? cur : next;
    });
  }

  async function generate() {
    setError("");
    if (!estRate) return;
    if (amtNum <= 0) return setError(inputMode === "usdc" ? "Enter the amount in USDC." : `Enter the amount in ${country.code}.`);
    if (overCap) {
      return setError(
        `Max ${capUsdc} USDC per sale (≈ ${fmtFiat(country, capUsdc * estRate)} now).`
      );
    }
    // Reject a fiat quote too small to cover its own offramp fee (audit LOW: else
    // the customer's total is fee-dominated and reads as a wrong charge).
    if (underMin) {
      return setError(
        `Amount too small — a sale must be at least ${fmtFiat(country, minFiat)} (the network fee on tiny orders).`
      );
    }

    // Snapshot the charge currency NOW so everything downstream (the priced
    // usdcAmount, the <CheckoutWidget currencies=…> prop, the saved session)
    // agrees on THIS currency even if `country` changes before they run.
    const chargeCountry = country;

    setBusy(true);
    let usdcTarget: bigint;
    if (inputMode === "usdc") {
      // SIZE THE PRINCIPAL SO THE CUSTOMER'S TOTAL LANDS ON THE USDC AMOUNT THE
      // MERCHANT TYPED — same inversion as the fiat branch below, just without a
      // fiat leg. Passing amtNum straight through as the principal (the old
      // behavior) let the widget add the small-order fee ON TOP, so "1 USDC"
      // charged the customer 1 USDC + fee instead of exactly 1 USDC.
      try {
        const cfg = await fetchPriceConfig(chargeCountry.code);
        usdcTarget = cfg ? usdcForUsdcTarget(amtNum, cfg) : BigInt(Math.round(amtNum * 1e6));
      } catch {
        usdcTarget = BigInt(Math.round(amtNum * 1e6));
      } finally {
        setBusy(false);
      }
    } else {
      // SIZE THE USDC SO THE CUSTOMER PAYS EXACTLY WHAT THE MERCHANT QUOTED,
      // against the SAME on-chain buyPrice both the estimate above (estRate) and
      // the checkout widget use. Re-read fresh here (the cached `priceCfg` is for
      // display; this guarantees the order is sized against the latest on-chain
      // value at submit time). Falls back to the estimate math if unpriceable.
      try {
        const cfg = await fetchPriceConfig(chargeCountry.code);
        usdcTarget = cfg ? usdcForFiat(amtNum, cfg) : BigInt(Math.round(usdcEquiv * 1e6));
      } catch {
        usdcTarget = BigInt(Math.round(usdcEquiv * 1e6));
      } finally {
        setBusy(false);
      }
    }

    // The integrator's product-2 unit price is 1e-6 USDC (one 6-dec unit), so the
    // on-chain quantity IS the 6-dec USDC amount exactly — quantity == usdcAmount,
    // no cent-rounding. This removes the up-to-half-a-cent drift the old whole-cent
    // snap introduced (which at low-buyPrice currencies read as ~₹1 off on small
    // orders): the widget's displayed total = quantity × unit price = usdcTarget,
    // to the last 6-dec unit. usdcForFiat() already sizes usdcTarget to the exact
    // quoted fiat; USDC-direct entry and the no-price-config fallback are already
    // whole 6-dec amounts, so this is a lossless identity for every path.
    const quantity = usdcTarget;
    if (quantity === 0n) return setError("Amount too small.");

    // CAP RE-CHECK (audit H1/H2) against the ACTUAL submitted amount, bigint-vs-
    // bigint. The `overCap` guard above compares the DISPLAY estimate (a float
    // from the cached priceCfg) to the cap; but `usdcTarget` is re-priced here
    // from a FRESH on-chain read, so a mid-flight buyPrice move can size it over
    // the cap even though the estimate passed — the on-chain placeOrder would then
    // revert ExceedsPerTxCap at the register. Compare the real bigint directly to
    // the live raw cap (contract reverts on quantity > cap, so == cap is allowed).
    // Only enforced when we have the authoritative on-chain cap; the mirror is a
    // display fallback and must not hard-block on float-derived values.
    if (liveCapRaw != null && quantity > liveCapRaw) {
      return setError(
        `Max ${capUsdc} USDC per sale (≈ ${fmtFiat(country, capUsdc * estRate)} now). ` +
          `The live price moved this order over the cap — lower the amount slightly.`
      );
    }
    const usdcAmount = quantity;
    const usdc = Number(usdcAmount) / 1e6;
    const fiatCharged = inputMode === "usdc" ? usdc * (estRate ?? 0) : amtNum;

    // DECIMAL-DRIFT FIX: the order can only be sized in whole USDC cents, so a
    // round fiat quote (₹250) rarely maps to an exact cent — the on-chain total
    // drifts a fraction (₹249.57). When that drift is purely the cent-granularity
    // floor (≤ one USDC cent's worth of fiat), pass the merchant's TYPED round
    // fiat to the widget as `fiatAmount` so the CUSTOMER sees ₹250.00 exactly,
    // absorbing the sub-cent difference. The widget uses this only for its
    // displayed fiat + SDK routing; the on-chain order is still the cent-snapped
    // usdcAmount. Outside fiat mode, or if the difference is larger than one cent
    // (i.e. NOT just granularity — don't mask a genuinely different total), leave
    // it undefined so the widget shows its honest on-chain quote.
    let fiatAmount: bigint | undefined;
    if (inputMode === "fiat" && estRate) {
      const onchainFiat = usdc * estRate;                  // what the cents value to
      const oneCentFiat = estRate * 0.01;                  // one USDC cent in fiat
      if (Math.abs(onchainFiat - amtNum) <= oneCentFiat + 1e-9) {
        fiatAmount = BigInt(Math.round(amtNum * 1e6));     // 6-dec typed round fiat
      }
    }

    setLastAmt(amt);
    setLiveWidget({ usdcAmount, quantity, fiat: fiatCharged, usdc, fiatAmount, country: chargeCountry });
    // Persist so the session survives a closed dialog / refresh and can be resumed.
    // fiatAmount (bigint) is stored as a string; restored on resume so a reopened
    // order keeps the same clean customer total.
    saveSession({
      usdcAmount: usdcAmount.toString(), quantity: quantity.toString(),
      fiat: fiatCharged, usdc, fiatAmount: fiatAmount != null ? fiatAmount.toString() : null,
      currency: chargeCountry.code, countryId: chargeCountry.id,
    });
  }

  // Reopen the checkout modal against a previously-placed order (the merchant
  // closed the dialog before it finished) instead of starting a fresh sale.
  function resumePending() {
    if (!pending) return;
    setError("");
    // Same rationale as resumeSession(): restore the currency this order was
    // actually placed in, not whatever `country` currently is.
    const pendingCountry = getCountry(pending.countryId) || country;
    setCountry(pendingCountry);
    setLiveWidget({
      resumeOrderId: pending.orderId,
      usdcAmount: BigInt(Math.round(pending.usdc * 1e6)),
      quantity: 0n, fiat: pending.fiat, usdc: pending.usdc, country: pendingCountry,
    });
  }

  function discardPending() {
    clearPendingOrder();
    setPending(null);
  }

  // Public receipt link the CUSTOMER opens to verify their payment. The token
  // stops casual enumeration of sequential order ids in a browser, but it is
  // NOT a cryptographic secret — it's derived from public on-chain data (see
  // receiptToken() in lib/history.ts), so treat the receipt contents (amount,
  // payer address, timestamp) as on-chain-public, not confidential.
  function receiptUrl() {
    if (typeof window === "undefined" || !done || !done.token) return "";
    const rcCountry = done.country || country;
    const q = new URLSearchParams({
      shop: shopLabel || "My Shop",
      // decimals:2 — a ₹10.50 sale must not read "₹11" on the customer's receipt.
      fiat: fmtFiat(rcCountry, done.fiat, { decimals: 2 }),
      token: done.token,
      kind: "buy",                              // customer paid the merchant
      ...(rcCountry?.code ? { cur: rcCountry.code } : {}),
      // Masked payout handle — "which account did I pay?" on the customer's
      // receipt. Already masked before it leaves this device (see upiMasked
      // above); omitted entirely if this device couldn't decrypt it.
      ...(upiMasked ? { upi: upiMasked } : {}),
    });
    return `${window.location.origin}/receipt/${done.orderId}?${q.toString()}`;
  }

  // Render the confirmation card to a PNG and hand it to the OS share sheet
  // (or download it, if sharing files isn't supported) — so the merchant can
  // forward proof of payment as an image instead of just a link.
  async function shareReceipt() {
    if (!captureRef.current || imgBusy || !done) return;
    setImgBusy(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: getComputedStyle(captureRef.current).backgroundColor || "#ffffff",
        scale: Math.min(window.devicePixelRatio || 2, 3),
      });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return;
      const file = new File([blob], `payqr-receipt-${done.orderId}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "PayQR receipt" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      // Best-effort — leave the merchant with the on-screen confirmation if it fails.
    } finally {
      setImgBusy(false);
    }
  }

  // Auth gate: never flash the terminal for a logged-out deep-link/refresh.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>Loading…</p></div></>;

  const quick = QUICK[country.code] || QUICK.INR;

  return (
    <>
      <Nav back />
      <div className="screen">

        {liveWidget && (
          <>
            <CheckoutWidget
              orderId={liveWidget.resumeOrderId}
              usdcAmount={liveWidget.usdcAmount}
              fiatAmount={liveWidget.fiatAmount}
              quantity={liveWidget.quantity}
              productName={shopLabel || "PayQR sale"}
              currencies={[{
                symbol: liveWidget.country.code, flag: liveWidget.country.flag,
                paymentMethod: liveWidget.country.fiat, symbolNative: liveWidget.country.symbol,
              }]}
              onPlaced={(orderId) => {
                savePendingOrder({
                  orderId: String(orderId), fiat: liveWidget.fiat, usdc: liveWidget.usdc,
                  countryId: liveWidget.country.id, shopLabel, savedAt: Date.now(),
                });
              }}
              onComplete={(orderId) => {
                paymentFeedback();
                clearPendingOrder(); setPending(null);
                const id = String(orderId);
                setDone({ orderId: id, usdc: liveWidget.usdc, fiat: liveWidget.fiat, token: "", country: liveWidget.country });
                setLiveWidget(null); setAmt(""); clearSession(); refetchDaily();
                // The receipt link's access token needs this order's real tx hash.
                // The subgraph usually indexes it within seconds of settlement,
                // but can lag longer under load — poll for up to ~45s (with a
                // gentle backoff) so the "Show receipt" link reliably gets a token
                // instead of silently staying hidden.
                (async () => {
                  let delay = 1200;
                  for (let i = 0; i < 20; i++) {
                    const o: any = await fetchOrder(id);
                    if (o?.txHash) {
                      setDone((d: any) => (d && d.orderId === id ? { ...d, token: receiptToken(id, o.txHash) } : d));
                      return;
                    }
                    await new Promise((r) => setTimeout(r, delay));
                    delay = Math.min(delay + 400, 3000); // 1.2s → 3s, capped
                  }
                  // Poll exhausted (~45s of subgraph lag) — stop claiming the link
                  // is coming. token:null = "gave up" (vs "" = still preparing);
                  // the card then points the merchant at the image share instead
                  // of showing "Preparing receipt link…" forever.
                  setDone((d: any) => (d && d.orderId === id && !d.token ? { ...d, token: null } : d));
                })();
              }}
              onCancel={() => {
                clearPendingOrder(); setPending(null);
                setLiveWidget(null); clearSession(); refetchDaily();
              }}
              onClose={() => setLiveWidget(null)}
              onError={(m) => {
                // Do NOT discard the on-chain order record here. onError can fire
                // on a transient RPC/subgraph error AFTER the order was placed
                // (onPlaced) — the customer may already be mid-payment. Wiping the
                // record while keeping the pre-chain session alive steered the
                // merchant into "Resume payment", which RE-PLACES a second order
                // for the same sale (double charge). Instead: drop the pre-chain
                // session (so nothing can re-place) and surface the placed order
                // (if any) via the resume-tracking panel.
                setPayError(m); setLiveWidget(null); clearSession();
                setPending(loadPendingOrder());
              }}
            />
          </>
        )}

        {/* Resume / cancel an unfinished payment that hasn't reached the chain
            yet (dialog was closed or app left before the order was placed).
            Fixes the orphaned-session bug + gives a way out of a stuck order. */}
        {pendingSession && !pending && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Payment in progress</h2>
            <p className="muted" style={{ margin: "6px 0 12px" }}>
              {/* Format with the currency the session was STARTED in, not the
                  current `country` (which may have reverted to the merchant's
                  home currency on a remount) — else a BRL session shows the ₹
                  symbol / INR grouping. Mirrors resumeSession()'s resolution. */}
              You have an unfinished sale of{" "}
              {fmtFiat(
                (pendingSession.countryId != null ? getCountry(pendingSession.countryId) : null) ||
                  COUNTRIES.find((c) => c.code === pendingSession.currency) ||
                  country,
                pendingSession.fiat
              )}{" "}
              {pendingSession.currency}.
              Resume to show the QR again, or cancel to start over.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={resumeSession}>Resume payment</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={clearSession}>Cancel</button>
            </div>
          </div>
        )}

        {/* A payment was placed on-chain but the dialog closed before it
            finished — offer to pick it back up instead of losing it. */}
        {pending && !liveWidget && !done && !payError && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Unfinished payment</h2>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              A sale for {fmtFiat(getCountry(pending.countryId), pending.fiat)} is still
              in progress (order #{pending.orderId}).
            </p>
            <div className="recv-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={discardPending}>Discard</button>
              <button className="btn" onClick={resumePending}>Resume</button>
            </div>
          </div>
        )}

        {/* Friendly message when the payment can't start. payError is whatever
            friendlyError() produced — for SDK-classified failures (fraud-engine
            screening rejections, no-eligible-merchant routing, etc.) that's now
            the SDK's own specific reason, not a generic guess, so show it as the
            primary explanation instead of assuming "no merchant online". */}
        {payError && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Couldn’t start this payment</h2>
            <p className="muted" style={{ margin: "8px 0 14px" }}>{payError}</p>
            <button className="btn" style={{ width: "100%" }}
              onClick={() => { setPayError(""); }}>
              Try again
            </button>
          </div>
        )}

        {/* You received USDC — confirmation */}
        {done && (
          <div className="received">
            <div ref={captureRef}>
              <div className="tick-wrap"><Icon.Check /></div>
              <div className="recv-h">{t("qr.received")}<br />${done.usdc.toFixed(2)} USDC</div>
              <p className="muted recv-sub">
                Settled on-chain · paid by customer ({fmtFiat(done.country || country, done.fiat, { decimals: 2 })}).
                Withdraw to your bank or keep as USDC.
              </p>
              <div className="proofcard">
                <div className="prow"><span className="k">Order</span><span className="v">#{done.orderId}</span></div>
                <div className="prow"><span className="k">Received</span><span className="v">{done.usdc.toFixed(2)} USDC</span></div>
                <div className="prow">
                  <span className="k">Proof</span>
                  <a className="v link" target="_blank" rel="noopener noreferrer"
                     href={`${SCAN}/address/${INTEGRATOR}`}>Basescan ↗</a>
                </div>
              </div>
            </div>
            {done.token ? (
              <a className="recv-receipt-link" href={receiptUrl()} target="_blank" rel="noopener noreferrer">
                <Icon.Receipt width="15" height="15" /> {t("qr.showReceipt")}
              </a>
            ) : done.token === "" ? (
              <p className="muted tiny" style={{ margin: "6px 0" }}>Preparing receipt link…</p>
            ) : (
              <p className="muted tiny" style={{ margin: "6px 0" }}>
                Receipt link unavailable right now — use “{t("qr.sendReceipt")}” below to share proof.
              </p>
            )}
            <div className="recv-actions">
              <button className="btn ghost" onClick={shareReceipt} disabled={imgBusy}>
                <Icon.Share /> {imgBusy ? "Preparing image…" : t("qr.sendReceipt")}
              </button>
              <button className="btn" onClick={() => setDone(null)}><Icon.Plus /> {t("qr.next")}</button>
            </div>
          </div>
        )}

        {limitReached && !liveWidget && !done && !payError && !pendingSession && !pending && (
          <div className="panel">
            <h2>Daily limit reached ({String(used)}/{String(limit)})</h2>
            <p className="muted">All transactions used for today. Resets at midnight UTC.</p>
          </div>
        )}

        {/* Number-pad terminal */}
        {!limitReached && !liveWidget && !done && !payError && !pendingSession && !pending && (
          <div className="terminal">
            {/* Live exchange rate — shown up front so the merchant sees what
                1 USDC is worth in their charge currency before typing an
                amount, not just as a derived total after. */}
            {estRate && (
              <div className="rate-pill">
                1 USDC ≈ {fmtFiat(country, estRate)} {country.code}
              </div>
            )}
            {/* charge-currency picker — only shows currencies the protocol can
                settle (live circles). Lets a merchant accept in any supported
                currency, e.g. when travelling. Default = registered country. */}
            <div className="cur-pick-row">
              {/* Locked while a sale is being priced (`busy`): the on-chain price
                  read is keyed off `country.code` at the moment it started, so
                  switching currency mid-flight would size the USDC amount for
                  one currency while pricing it against another's rate. */}
              {payOpts.length > 1 && (
                <div className="cur-pick">
                  <button className={`cur-pick-btn ${pickOpen ? "on" : ""}`} disabled={busy}
                    onClick={() => setPickOpen((o) => !o)}>
                    <span className="cur-pick-label">{t("qr.chargeIn")}</span>
                    <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar"})[country.id] || "un"}.png`} alt="" />
                    <b>{country.code}</b><span className="cur-car">▾</span>
                  </button>
                  {pickOpen && (
                    <div className="cur-pick-pop">
                      {payOpts.map((c) => (
                        <button key={c.id} className={`cur-pick-item ${c.id === country.id ? "sel" : ""}`}
                          onClick={() => { setCountry(c); setAmt(""); setError(""); setPickOpen(false); }}>
                          <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar"})[c.id] || "un"}.png`} alt="" />
                          <span className="cur-pick-txt">{c.name}<small>{c.fiat} · {fmtSymbolCode(c)}</small></span>
                          {c.id === country.id && <span className="cur-chk">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* fiat / USDC input-mode toggle — switches what the keypad + quick
                  chips are denominated in. */}
              <div className="mode-toggle">
                <button className={`mode-toggle-opt ${inputMode === "fiat" ? "sel" : ""}`} disabled={busy}
                  onClick={() => { setInputMode("fiat"); setAmt(""); setError(""); }}>
                  {country.code}
                </button>
                <button className={`mode-toggle-opt ${inputMode === "usdc" ? "sel" : ""}`} disabled={busy}
                  onClick={() => { setInputMode("usdc"); setAmt(""); setError(""); }}>
                  USDC
                </button>
              </div>
            </div>
            <div className="t-amount">
              <div className="t-shop">{shopLabel || t("qr.newSale")}</div>
              {/* Show the RAW typed string (preserves "10." and decimals while
                  typing) with grouping on the integer part only — passing `amt`
                  through fmtFiat would round away the decimal being entered. */}
              <div className="t-value">
                {inputMode === "usdc" ? `${fmtTyped(amt)} USDC` : `${country.symbol}${fmtTyped(amt)}`}
              </div>
              <div className="t-sub">
                {estRate
                  ? amtNum > 0
                    ? inputMode === "usdc"
                      ? `≈ ${fmtFiat(country, fiatEquiv)} ${country.code}`
                      : `≈ ${usdcEquiv.toFixed(2)} USDC ${t("qr.youKeep")}`
                    : t("qr.enterAmount")
                  : t("qr.fetchingRate")}
              </div>
              {overCap && estRate && (
                <div className="t-warn">Max {fmtFiat(country, capUsdc * estRate)} per sale</div>
              )}
              <div className="t-fee-note">{t("qr.smallOrderFee")}</div>
            </div>

            {/* quick amounts + repeat */}
            <div className="quick-amts">
              {(inputMode === "usdc" ? QUICK_USDC : quick).map((q) => (
                <button key={q} className="qa-chip" onClick={() => { setAmt(String(q)); setError(""); }}>
                  {inputMode === "usdc" ? `${q} USDC` : `${country.symbol}${q}`}
                </button>
              ))}
              <button className="qa-chip repeat" disabled={!lastAmt}
                onClick={() => { setAmt(lastAmt); setError(""); }} title="Repeat last amount">
                <Icon.Repeat width="16" height="16" />
              </button>
            </div>

            <div className="keypad">
              {["1","2","3","4","5","6","7","8","9",".","0","del"].map((k) => (
                <button key={k} className="keypad-key" onClick={() => press(k)}>
                  {k === "del" ? "⌫" : k}
                </button>
              ))}
            </div>

            <button className="btn t-charge"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              disabled={!ready || !estRate || amtNum <= 0 || overCap || busy} onClick={generate}>
              <Icon.Qr /> {busy ? t("qr.fetchingRate") : amtNum > 0 ? `${t("common.acceptPayment")} · ${inputMode === "usdc" ? `${fmtTyped(amt)} USDC` : `${country.symbol}${fmtTyped(amt)}`}` : t("common.acceptPayment")}
            </button>
            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            {/* Always surface the per-sale cap (not just when exceeded) — the #1
                thing merchants ask about. Shown in the charge currency with the
                USDC cap in brackets, plus a support link to request a raise. */}
            <div className="t-limit">
              <span>
                {t("qr.perSaleLimit").replace(
                  "{max}",
                  estRate
                    ? `${fmtFiat(country, capUsdc * estRate)} (${capUsdc} USDC)`
                    : `${capUsdc} USDC`
                )}
              </span>
              <a href="https://t.me/PayQRdotPRO" target="_blank" rel="noopener noreferrer" className="t-limit-link">
                {t("qr.limitHelp")}
              </a>
            </div>
            <div className="t-foot">{String(used)} / {String(limit)} sales today</div>
          </div>
        )}
      </div>
    </>
  );
}
