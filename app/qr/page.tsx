"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
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
import { loadPendingOrder, savePendingOrder, clearPendingOrder, fetchSupportedCurrencies } from "../../lib/p2p";
import { fetchOrder, fetchHistory, receiptToken } from "../../lib/history";
import { fill, fmtDay } from "../../lib/format";
import type { UserError } from "../../lib/errors";
import { useGuardedSend } from "../../components/useGuardedSend";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { ErrorPanel } from "../../components/ui/ErrorPanel";
import { LoadingState } from "../../components/ui/LoadingState";
import { SettlementNote } from "../../components/ui/SettlementNote";
import type { PendingOrder } from "../../lib/p2p";
import { useT } from "../../lib/i18n";
import { EXPLORER_URL } from "../../lib/chain";
import dynamic from "next/dynamic";

const INTEGRATOR = CONTRACT_ADDRESS;
const SCAN = EXPLORER_URL;

const CheckoutWidget = dynamic(
  () => import("../../components/CheckoutWidget").then((m) => m.CheckoutWidget),
  { ssr: false }
);

// Quick-amount presets per country (local fiat).
const QUICK = { INR: [10, 20, 50], BRL: [5, 10, 20], ARS: [500, 1000, 2000], VEN: [100, 200, 500] };
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
  const { t, lang } = useT();
  // Synchronous lock: two taps on Accept in the same tick start ONE sale.
  const sale = useGuardedSend();
  const [discardOpen, setDiscardOpen] = useState(false);

  const [country, setCountry] = useState(null);   // the currency THIS sale charges in
  const [payOpts, setPayOpts] = useState([]);     // countries the protocol can settle
  const [currenciesChecked, setCurrenciesChecked] = useState(false);
  const [pickOpen, setPickOpen] = useState(false);
  const [amt, setAmt] = useState("");        // local fiat the merchant types
  const [lastAmt, setLastAmt] = useState(""); // for "repeat"
  const [inputMode, setInputMode] = useState<"fiat" | "usdc">("fiat"); // what `amt` is denominated in
  const [rate, setRate] = useState(null);           // p2p rate (on-chain price via rates.ts); used until priceCfg loads
  const [priceCfg, setPriceCfg] = useState(null);   // live on-chain price for `country` — the REAL charge price
  const [error, setError] = useState("");
  const [liveWidget, setLiveWidget] = useState(null);
  const [done, setDone] = useState(null);
  const [doneAt, setDoneAt] = useState(0);   // unix s when the last sale completed
  const [payError, setPayError] = useState<UserError | string>("");
  const [busy, setBusy] = useState(false); // pricing the sale (reading on-chain buyPrice)
  const [imgBusy, setImgBusy] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  // A payment session that was started but not finished (widget closed / left)
  // BEFORE the order landed on-chain. Persisted so the merchant can RESUME it
  // instead of losing the sale, and can CANCEL a stuck one. Cleared on
  // complete/cancel. (Bug: closing the p2p dialog used to orphan the session
  // forever.)
  const [pendingSession, setPendingSession] = useState(null);
  // Scoped per wallet so another account on this device never sees (or resumes) it.
  const SESSION_KEY = `payqr.pendingSession.${(address || "").toLowerCase()}`;
  const SESSION_TTL_MS = 15 * 60 * 1000; // 15 min — a stale session auto-expires
  const [pending, setPending] = useState<PendingOrder | null>(null); // order placed on-chain but never finished

  // Default the sale currency to the merchant's registered country.
  useEffect(() => { setCountry(loadCountry()); }, []);

  // On load, restore a recent unfinished session (drop it if older than the TTL).
  useEffect(() => {
    if (!address) return;
    try {
      try { localStorage.removeItem("payqr.pendingSession"); } catch {} // legacy un-scoped key: never trusted
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s?.startedAt || Date.now() - s.startedAt > SESSION_TTL_MS) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      setPendingSession(s);
    } catch { localStorage.removeItem(SESSION_KEY); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SESSION_KEY, address]);

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
  useEffect(() => { setPending(loadPendingOrder(address)); }, [address]);

  // Every configured country is selectable as the accept currency. The widget
  // resolves the circle for the picked currency at order time; if the protocol
  // adds a circle, nothing here changes.
  // Only offer currencies the protocol can ACTUALLY settle right now — the same
  // live-circle ∩ displayable-countries rule the payment-link form uses. (This
  // used to list every country unconditionally and fail only at order time with
  // a misleading INR error.) If the live list can't be read, fall back to the
  // merchant's own registered currency rather than offering anything unproven.
  useEffect(() => {
    let on = true;
    fetchSupportedCurrencies()
      .then((rows) => {
        if (!on) return;
        const live = new Set(rows.map((r) => r.code));
        const opts = COUNTRIES.filter((c) => live.has(c.code));
        setPayOpts(opts);
        setCurrenciesChecked(true);
        // If the currently selected currency isn't live, move to one that is.
        setCountry((cur) => (cur && opts.length && !opts.some((c) => c.code === cur.code) ? opts[0] : cur));
      })
      .catch(() => { if (on) { setPayOpts([]); setCurrenciesChecked(true); } });
    return () => { on = false; };
  }, []);

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

  // After a sale, read the REAL unlock time from the newest on-chain bucket (the
  // sale's funds enter a bucket when the order completes). Polled gently only
  // while the success card is showing.
  const { data: bucketsAfter } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBuckets",
    args: [address], query: { enabled: !!address && !!done, refetchInterval: done ? 6000 : false },
  });
  const saleUnlock = (() => {
    if (!done || !bucketsAfter) return 0;
    let max = 0;
    for (const b of bucketsAfter as any[]) {
      if (b.amount > 0n) max = Math.max(max, Number(b.unlockTimestamp));
    }
    return max > doneAt ? max : 0;
  })();

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
    // Read ONCE per currency. fetchUsdcRate sources the same on-chain price the
    // priceCfg effect below reads, so the old 60 s interval here was a duplicate
    // read; the single refresh now lives on priceCfg.
    fetchUsdcRate(country).then((r) => alive && setRate(r)).catch(() => {});
    return () => { alive = false; };
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
    const load = () => fetchPriceConfig(country.code)
      .then((cfg) => { if (alive) setPriceCfg(cfg ? { code: country.code, ...cfg } : { code: country.code, missing: true }); })
      .catch(() => { if (alive) setPriceCfg((cur) => cur && !cur.missing && cur.code === country.code ? cur : { code: country.code, missing: true }); });
    load();
    // Keep the shown price fresh while the terminal is open (and visible). A
    // refresh that fails keeps the last good price instead of blanking it.
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => { alive = false; clearInterval(id); };
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

  function generate() { return sale.run(generateSale, { skipStepUp: true, fallbackKey: "err.order" }); }

  async function generateSale() {
    setError("");
    if (!estRate) return;
    if (amtNum <= 0) return setError(inputMode === "usdc" ? t("qr.enterUsdc") : fill(t("qr.enterFiat"), { code: country.code }));
    if (overCap) {
      return setError(
        fill(t("qr.maxPerSaleUsdc"), { usdc: capUsdc, max: fmtFiat(country, capUsdc * estRate) })
      );
    }
    // Reject a fiat quote too small to cover its own offramp fee (audit LOW: else
    // the customer's total is fee-dominated and reads as a wrong charge).
    if (underMin) {
      return setError(
        fill(t("qr.minPerSale"), { min: fmtFiat(country, minFiat) })
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
    if (quantity === 0n) return setError(t("qr.tooSmall"));

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
        fill(t("qr.maxPerSaleMoved"), { usdc: capUsdc, max: fmtFiat(country, capUsdc * estRate) })
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
    clearPendingOrder(address);
    setPending(null);
    setDiscardOpen(false);
  }

  // An UNCERTAIN order is one whose tx was submitted but whose result we could
  // not read. Resolve it from the index when possible (match by tx hash), so the
  // merchant is never asked to re-place a sale that already exists.
  const uncertain = !!pending?.uncertain && !pending.orderId;
  async function resolveUncertain() {
    if (!address || !pending?.txHash) return;
    try {
      const rows = await fetchHistory(address);
      const hit = rows.find((r: any) => String(r.txHash || "").toLowerCase() === String(pending.txHash).toLowerCase());
      if (hit) {
        const resolved: PendingOrder = {
          ...pending, orderId: String(hit.orderId), uncertain: false,
          countryId: (COUNTRIES.find((c) => c.code === pending.currency)?.id) || pending.countryId,
          usdc: Number(hit.amount) / 1e6,
        };
        savePendingOrder(resolved, address);
        setPending(resolved);
      }
    } catch { /* index unreachable - stay in the safe "checking" state */ }
  }
  useEffect(() => {
    if (!uncertain) return;
    resolveUncertain();
    const id = setInterval(() => { if (document.visibilityState === "visible") resolveUncertain(); }, 10_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uncertain, address, pending?.txHash]);

  // Public receipt link the CUSTOMER opens to verify their payment. The token
  // stops casual enumeration of sequential order ids in a browser, but it is
  // NOT a cryptographic secret — it's derived from public on-chain data (see
  // receiptToken() in lib/history.ts), so treat the receipt contents (amount,
  // payer address, timestamp) as on-chain-public, not confidential.
  function receiptUrl() {
    if (typeof window === "undefined" || !done || !done.token) return "";
    // Order id + access token only. The receipt shows nothing from its URL —
    // amount, currency and shop all come from the chain (review H1) — so the
    // display hints this used to add (shop, fiat, cur, upi) are gone.
    const q = new URLSearchParams({
      token: done.token,
      kind: "buy", // which table the receipt looks in first
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
    } catch (e: any) {
      // Closing the share sheet is not a failure. Anything else is reported — it
      // used to fail silently, so the button just appeared to do nothing.
      if (e?.name !== "AbortError") setError(t("qr.imageFailed"));
    } finally {
      setImgBusy(false);
    }
  }

  // Auth gate: never flash the terminal for a logged-out deep-link/refresh.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <><Nav back /><div className="screen"><LoadingState label={t("ui.loading")} /></div></>;

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
                // The order now EXISTS on-chain. Record it, mirror it into state,
                // and retire the pre-chain session in the same breath. Leaving the
                // session alive (the old behaviour) meant closing the dialog
                // showed "Resume payment", which places a SECOND order.
                const rec: PendingOrder = {
                  orderId: String(orderId), fiat: liveWidget.fiat, usdc: liveWidget.usdc,
                  countryId: liveWidget.country.id, shopLabel, savedAt: Date.now(),
                };
                savePendingOrder(rec, address);
                setPending(rec);
                clearSession();
              }}
              onComplete={(orderId) => {
                paymentFeedback();
                clearPendingOrder(address); setPending(null);
                setDoneAt(Math.floor(Date.now() / 1000));
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
                clearPendingOrder(address); setPending(null);
                setLiveWidget(null); clearSession(); refetchDaily();
              }}
              onClose={() => {
                // Closing is never destructive: if an order was placed it stays
                // tracked in the "Unfinished payment" panel below.
                setLiveWidget(null);
                setPending(loadPendingOrder(address));
              }}
              onError={(m, ue) => {
                // Do NOT discard the on-chain order record here. onError can fire
                // on a transient RPC/subgraph error AFTER the order was placed
                // (onPlaced) — the customer may already be mid-payment. Wiping the
                // record while keeping the pre-chain session alive steered the
                // merchant into "Resume payment", which RE-PLACES a second order
                // for the same sale (double charge). Instead: drop the pre-chain
                // session (so nothing can re-place) and surface the placed order
                // (if any) via the resume-tracking panel.
                const placed = loadPendingOrder(address);
                setLiveWidget(null); clearSession();
                setPending(placed);
                // An uncertain order gets its own panel (never a "try again").
                if (!placed?.uncertain) setPayError(ue ?? m);
              }}
            />
          </>
        )}

        {/* A sale that was STARTED but never reached the chain (dialog closed or
            app left before the order was placed). Nothing exists on-chain yet, so
            Cancel is safe. */}
        {pendingSession && !pending && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>{t("qr.inProgress")}</h2>
            <p className="muted" style={{ margin: "6px 0 12px" }}>
              {fill(t("qr.unfinishedSale"), {
                amount: fmtFiat(
                  (pendingSession.countryId != null ? getCountry(pendingSession.countryId) : null) ||
                    COUNTRIES.find((c) => c.code === pendingSession.currency) || country,
                  pendingSession.fiat
                ),
                currency: pendingSession.currency,
              })}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={resumeSession}>{t("qr.resumePayment")}</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={clearSession}>{t("ui.cancel")}</button>
            </div>
          </div>
        )}

        {/* UNCERTAIN: the order tx was submitted but we could not confirm it. The
            order may exist and a customer may be paying it, so this screen offers
            NO way to start another sale until it is resolved or dismissed. */}
        {pending && uncertain && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>{t("qr.checkingTitle")}</h2>
            <LoadingState inline label={t("qr.checkingLabel")} slowAfterMs={30000} timeoutMs={600000} />
            <p className="muted" style={{ margin: "8px 0 4px" }}>{t("err.uncertainOrder")}</p>
            {pending.txHash && (
              <p className="muted tiny"><a href={`${SCAN}/tx/${pending.txHash}`} target="_blank" rel="noopener noreferrer">{t("wd.viewOnExplorer")} ↗</a></p>
            )}
            <div className="recv-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setDiscardOpen(true)}>{t("ui.dismiss")}</button>
              <Link className="btn" href="/transactions">{t("wd.viewTx")}</Link>
            </div>
          </div>
        )}

        {/* A payment WAS placed on-chain but the dialog closed before it finished
            - pick it back up (tracking only; this never places a new order). */}
        {pending && !uncertain && !liveWidget && !done && !payError && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>{t("qr.unfinishedTitle")}</h2>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              {fill(t("qr.unfinishedBody"), { amount: fmtFiat(getCountry(pending.countryId), pending.fiat), id: pending.orderId })}
            </p>
            <div className="recv-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setDiscardOpen(true)}>{t("qr.discard")}</button>
              <button className="btn" onClick={resumePending}>{t("qr.resume")}</button>
            </div>
          </div>
        )}

        <ConfirmDialog
          open={discardOpen}
          tone="danger"
          title={t("qr.discardTitle")}
          confirmLabel={t("qr.discard")}
          onCancel={() => setDiscardOpen(false)}
          onConfirm={discardPending}
        >
          <p>{t("qr.discardBody")}</p>
        </ConfirmDialog>

        {/* Couldn't start: ErrorPanel never shows raw SDK/RPC text. */}
        {payError && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>{t("qr.couldntStart")}</h2>
            <ErrorPanel error={payError} />
            <button className="btn" style={{ width: "100%" }} onClick={() => setPayError("")}>{t("ui.retry")}</button>
          </div>
        )}

        {/* Payment received - what arrived, WHERE it is, and WHEN it is withdrawable. */}
        {done && (
          <div className="received">
            <div ref={captureRef}>
              <div className="tick-wrap"><Icon.Check /></div>
              <div className="recv-h">{t("qr.receivedHeadline")}</div>
              <p className="recv-sub" style={{ fontWeight: 600 }}>
                {fill(t("qr.receivedBody"), { usdc: done.usdc.toFixed(2) })}
              </p>
              <p className="muted recv-sub">
                {t("qr.paidBy")} {fmtFiat(done.country || country, done.fiat, { decimals: 2 })}.
              </p>
              {/* Prefer the REAL unlock time of the newest on-chain bucket; until it
                  appears, fall back to completion + the on-chain lock (estimate). */}
              <div className="ui-ok" style={{ textAlign: "left" }}>
                {saleUnlock
                  ? <div>{fill(t("sn.availableOn"), { date: fmtDay(saleUnlock, lang, saleUnlock - doneAt < 3 * 86400) })}</div>
                  : <SettlementNote currency={registeredCode || country?.code} completedAt={doneAt} />}
                <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{t("qr.settlingNow")}</div>
              </div>
              <div className="proofcard">
                <div className="prow"><span className="k">{t("qr.order")}</span><span className="v">#{done.orderId}</span></div>
                <div className="prow"><span className="k">{t("qr.amount")}</span><span className="v">{done.usdc.toFixed(2)} USDC</span></div>
                <div className="prow">
                  <span className="k">{t("qr.proof")}</span>
                  <a className="v link" target="_blank" rel="noopener noreferrer"
                     href={`${SCAN}/address/${INTEGRATOR}`}>{t("wd.viewOnExplorer")} ↗</a>
                </div>
              </div>
            </div>
            <div className="recv-actions" style={{ marginBottom: 8 }}>
              <Link className="btn ghost" href="/dashboard">{t("qr.viewBalance")}</Link>
              <Link className="btn ghost" href="/transactions">{t("qr.viewTransaction")}</Link>
            </div>
            {done.token ? (
              <a className="recv-receipt-link" href={receiptUrl()} target="_blank" rel="noopener noreferrer">
                <Icon.Receipt width="15" height="15" /> {t("qr.showReceipt")}
              </a>
            ) : done.token === "" ? (
              <p className="muted tiny" style={{ margin: "6px 0" }}>{t("qr.preparingReceipt")}</p>
            ) : (
              <p className="muted tiny" style={{ margin: "6px 0" }}>
                {fill(t("qr.receiptUnavailable"), { share: t("qr.sendReceipt") })}
              </p>
            )}
            <div className="recv-actions">
              <button className="btn ghost" onClick={shareReceipt} disabled={imgBusy}>
                <Icon.Share /> {imgBusy ? t("qr.preparingImage") : t("qr.sendReceipt")}
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
                    aria-haspopup="listbox" aria-expanded={pickOpen}
                    onKeyDown={(e) => { if (e.key === "Escape") setPickOpen(false); }}
                    onClick={() => setPickOpen((o) => !o)}>
                    <span className="cur-pick-label">{t("qr.chargeIn")}</span>
                    <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar",venezuela:"ve"})[country.id] || "un"}.png`} alt="" />
                    <b>{country.code}</b><span className="cur-car">▾</span>
                  </button>
                  {pickOpen && (
                    <div className="cur-pick-pop" role="listbox" onKeyDown={(e) => { if (e.key === "Escape") setPickOpen(false); }}>
                      {payOpts.map((c) => (
                        <button key={c.id} role="option" aria-selected={c.id === country.id} className={`cur-pick-item ${c.id === country.id ? "sel" : ""}`}
                          onClick={() => { setCountry(c); setAmt(""); setError(""); setPickOpen(false); }}>
                          <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar",venezuela:"ve"})[c.id] || "un"}.png`} alt="" />
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
                <button className={`mode-toggle-opt ${inputMode === "fiat" ? "sel" : ""}`} disabled={busy} aria-pressed={inputMode === "fiat"}
                  onClick={() => { setInputMode("fiat"); setAmt(""); setError(""); }}>
                  {country.code}
                </button>
                <button className={`mode-toggle-opt ${inputMode === "usdc" ? "sel" : ""}`} disabled={busy} aria-pressed={inputMode === "usdc"}
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
                  : <LoadingState inline label={t("qr.fetchingRate")} slowAfterMs={6000} timeoutMs={15000} />}
              </div>
              {overCap && estRate && (
                <div className="t-warn">{fill(t("qr.maxPerSale"), { max: fmtFiat(country, capUsdc * estRate) })}</div>
              )}
              {underMin && !overCap && (
                <div className="t-warn">{fill(t("qr.minPerSale"), { min: fmtFiat(country, minFiat) })}</div>
              )}
              <div className="t-fee-note">{t("qr.smallOrderFee")}</div>
              {/* Settlement BEFORE acceptance: what happens to the money. */}
              <SettlementNote currency={registeredCode || country?.code} className="t-settle" />
            </div>

            {/* quick amounts + repeat */}
            <div className="quick-amts">
              {(inputMode === "usdc" ? QUICK_USDC : quick).map((q) => (
                <button key={q} className="qa-chip" onClick={() => { setAmt(String(q)); setError(""); }}>
                  {inputMode === "usdc" ? `${q} USDC` : `${country.symbol}${q}`}
                </button>
              ))}
              <button className="qa-chip repeat" disabled={!lastAmt}
                onClick={() => { setAmt(lastAmt); setError(""); }} title={t("qr.repeat")} aria-label={t("qr.repeat")}>
                <Icon.Repeat width="16" height="16" aria-hidden="true" />
              </button>
            </div>

            <div className="keypad">
              {["1","2","3","4","5","6","7","8","9",".","0","del"].map((k) => (
                <button key={k} className="keypad-key" onClick={() => press(k)}
                  aria-label={k === "del" ? t("qr.delete") : k === "." ? t("qr.decimal") : k}>
                  {k === "del" ? "⌫" : k}
                </button>
              ))}
            </div>

            <button className="btn t-charge"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              disabled={!ready || !estRate || amtNum <= 0 || overCap || underMin || busy || sale.busy} onClick={generate}>
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
            <div className="t-foot">{fill(t("qr.salesToday"), { used: String(used), limit: String(limit) })}</div>
          </div>
        )}
      </div>
    </>
  );
}
