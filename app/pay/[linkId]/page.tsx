"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { createPublicClient, http } from "viem";
import dynamic from "next/dynamic";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, PREV_CONTRACT_ADDRESSES, currencyFromBytes32 } from "../../../lib/contract";
import { fetchPriceConfig, usdcForFiat, fiatForUsdc, minimumFiat } from "../../../lib/pricing";
import { ACTIVE_CHAIN, RPC_URL } from "../../../lib/chain";
import { countryForCurrency, fmtPayerFiat } from "../../../lib/countries";
import {
  PAYMENT_LINKS_ENABLED,
  LinkStatus,
  makeRelayerPlaceOrder,
  fetchLink,
  decodeLinkId,
  PaymentPendingError,
  getPendingPayment,
  resolvePendingPayment,
  fetchLinkPrice,
  attemptKeyFor,
  attemptScreening,
  rememberAttemptScreening,
  clearAttempt,
} from "../../../lib/paymentLinks";
import type { PaymentLink } from "../../../lib/paymentLinks";
import { getCustomerIdentity } from "../../../lib/customerRelayIdentity";
import { routeLinkCircle } from "../../../lib/customerOrder";
import { placeScreenedOrder } from "../../../lib/customerScreening";
import { resolveCircleId } from "../../../lib/p2p";
import { useHumanCheck } from "../../../components/HumanCheck";
import { usePayerT } from "../../../lib/payerI18n";

// PUBLIC, no-auth page — own module-scope reader, same as /receipt/[orderId].
// Uses the CONFIGURED RPC (not viem's default), for the same reason: the
// default endpoint is 429-prone and would trip the fail-open path.
const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

const PaymentLinkWidget = dynamic(
  () => import("../../../components/PaymentLinkWidget").then((m) => m.PaymentLinkWidget),
  { ssr: false }
);

/** Same transient-vs-definitive classification as /receipt/[orderId] — a
 *  flaky RPC must fail OPEN (retryable "unverified"), a genuine contract-shape
 *  error must fail CLOSED ("not found"), never the other way around. */
function isDefinitiveError(e: any): boolean {
  let root = e;
  if (e && typeof e.walk === "function") root = e.walk() || e;
  const rootName = String(root?.name || "");
  const outerName = String(e?.name || "");
  const msg = String(e?.shortMessage || e?.message || e || "");
  if (
    /HttpRequestError|TimeoutError|RpcRequestError|RpcError|WebSocketRequestError|HttpRequest|Timeout/i.test(rootName) ||
    /HTTP request failed|took too long|timed out|rate limit|429|network|fetch failed|Failed to fetch/i.test(msg)
  ) {
    return false;
  }
  return (
    /AbiFunctionNotFound|AbiDecoding|AbiEncoding|ContractFunctionRevert|ContractFunctionZeroData|AbiErrorSignatureNotFound|InvalidAddress/i.test(rootName) ||
    /AbiFunctionNotFound|AbiDecoding|ContractFunctionRevert|ContractFunctionZeroData/i.test(outerName) ||
    /reverted|not found on ABI|does not exist|cannot decode|returned no data|zero data/i.test(msg)
  );
}

// "retired": the link exists, but on a PREVIOUS integrator — made before a
// contract upgrade. It can no longer be paid, and saying "doesn't exist" would
// make a genuine merchant look like a scam to their own customer.
type LinkState = null | "verified" | "notFound" | "unverified" | "retired";

function fmtTyped(raw: string): string {
  if (!raw) return "";
  const [intPart, decPart] = raw.split(".");
  const grouped = (intPart || "0").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

// The order this browser placed on a link, kept so a reload resumes the SAME
// payment screen (matching, pay, verifying, receipt) instead of starting over,
// and, worse, offering Pay again while the first order is still live. Cleared
// when the order is cancelled. A completed order is kept only briefly, so the
// receipt is still there after a reload.
const ORDER_KEY_PREFIX = "payqr.linkOrder:";
const ORDER_LIVE_TTL_MS = 30 * 60 * 1000; // matching wait + the 5-minute pay window, with slack
// A finished payment's receipt is only kept briefly (enough to survive a reload
// right after paying). Beyond that, reopening the link shows the pay page again;
// the receipt itself is still reachable from the merchant's shared receipt link.
const ORDER_DONE_TTL_MS = 5 * 60 * 1000;
// `fiat` is the amount the payer was quoted ("Pay ₹10.02") when the order was
// placed, so the cancelled/expired screens can show exactly that after a reload.
type StoredOrder = { orderId: string; at: number; done?: boolean; fiat?: number };

function orderKey(linkId: string) { return `${ORDER_KEY_PREFIX}${linkId.toLowerCase()}`; }
function saveStoredOrder(linkId: string, o: StoredOrder) {
  try { localStorage.setItem(orderKey(linkId), JSON.stringify(o)); } catch { /* best-effort */ }
}
function clearStoredOrder(linkId: string) {
  try { localStorage.removeItem(orderKey(linkId)); } catch { /* nothing to clear */ }
}
function loadStoredOrder(linkId: string): StoredOrder | null {
  try {
    const raw = localStorage.getItem(orderKey(linkId));
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<StoredOrder>;
    if (typeof o?.orderId !== "string" || !/^\d+$/.test(o.orderId) || typeof o?.at !== "number") {
      clearStoredOrder(linkId);
      return null;
    }
    if (Date.now() - o.at > (o.done ? ORDER_DONE_TTL_MS : ORDER_LIVE_TTL_MS)) {
      clearStoredOrder(linkId);
      return null;
    }
    return o as StoredOrder;
  } catch { return null; }
}

function shortAddr(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

export default function PayLink() {
  // Reached as EITHER /pay/<0x hex> or the shorter /p/<base64url>, so read
  // whichever param the route supplied and let decodeLinkId normalise it.
  // Anything that is not a well-formed id decodes to "" and the page renders
  // "this payment link doesn't exist" — a mistyped or tampered URL fails closed
  // rather than being half-read.
  const { t } = usePayerT();
  const routeParams = useParams();
  const rawParam = (routeParams as any)?.linkId ?? (routeParams as any)?.code;
  const provided = Array.isArray(rawParam) ? rawParam[0] : rawParam;
  const safeLinkId = typeof provided === "string" ? decodeLinkId(provided) : "";

  const [link, setLink] = useState<PaymentLink | null>(null);
  const [shopName, setShopName] = useState("");
  const [state, setState] = useState<LinkState>(null);
  const [retry, setRetry] = useState(0);
  const [amountInput, setAmountInput] = useState("");
  const [priceCfg, setPriceCfg] = useState<any>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState("");
  const [orderId, setOrderId] = useState<string | null>(null);
  // The fiat amount the payer was shown when they tapped Pay (null if unknown,
  // e.g. an order placed before this was recorded).
  const [quotedFiat, setQuotedFiat] = useState<number | null>(null);
  // A payment sent but still confirming (see resolvePendingPayment). While
  // set, the Pay button stays off: paying again would place a second order.
  const [confirming, setConfirming] = useState(false);
  // Still confirming, but with no claim to follow it up with: the customer
  // must not pay again, and support needs the reference.
  const [stuckReference, setStuckReference] = useState<string | null>(null);
  // The merchant's REGISTERED currency — the contract keys the per-sale cap on
  // it, not on the link's currency.
  const [merchantCurrency, setMerchantCurrency] = useState<`0x${string}` | null>(null);
  // No widget to render any more: the gate is a puzzle solved in JS, not a
  // third-party iframe that had to be mounted somewhere in the DOM.
  const { getSolution: getHumanSolution } = useHumanCheck();

  useEffect(() => {
    if (!safeLinkId) {
      setState("notFound");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const l = await fetchLink(reader, safeLinkId);
        if (!alive) return;
        setLink(l);
        // A link that does not exist reverts LinkNotFound (handled below) — it
        // never comes back with an empty owner.
        setState("verified");
      } catch (e) {
        if (!alive) return;
        if (!isDefinitiveError(e)) return setState("unverified");
        // Not on the current contract. Was it made on an earlier one?
        for (const prev of PREV_CONTRACT_ADDRESSES) {
          try {
            await fetchLink(reader, safeLinkId, prev);
            if (!alive) return;
            return setState("retired");
          } catch {
            // Not there either — keep looking.
          }
        }
        if (alive) setState("notFound");
      }
    })();
    return () => { alive = false; };
  }, [safeLinkId, retry]);

  // Any currency the protocol can settle, not only the ones lib/countries.ts
  // lists — an unlisted one used to fall back to India and print ₹ next to an
  // amount in a different currency. See countryForCurrency.
  const country = link ? countryForCurrency(currencyFromBytes32(link.currency)) : null;

  // Show the merchant's shop name instead of their raw wallet address —
  // cosmetic only, so a read failure or an unregistered/blank name just
  // falls back to the shortened address (merchantLabel below) rather than
  // blocking the page.
  useEffect(() => {
    if (!link?.owner) return;
    let alive = true;
    reader
      .readContract({
        address: CONTRACT_ADDRESS,
        abi: INTEGRATOR_ABI,
        functionName: "getMerchantInfo",
        args: [link.owner],
      } as any)
      .then((result: any) => {
        if (!alive) return;
        const name = String(result?.[1] || "").trim();
        if (name) setShopName(name);
        const cur = result?.[2];
        if (typeof cur === "string" && /^0x[0-9a-fA-F]{64}$/.test(cur)) setMerchantCurrency(cur as `0x${string}`);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [link?.owner]);

  useEffect(() => {
    // Needed for a variable link (to price what the customer types) AND for a
    // FIXED link's own display: `amount` on chain is 6-dec USDC-equivalent
    // (usdcForFiat's output at creation time), not fiat — showing it directly
    // as fiat understates the real charge by roughly the buyPrice factor
    // (e.g. an INR link created for ₹100 stores ~1.10 USDC-equiv, which read
    // back as fiat shows "₹1.10" instead of ₹100).
    if (!link || !country) return;
    fetchPriceConfig(country.code).then(setPriceCfg);
  }, [link, country]);

  // A fixed amount in the customer's own currency, which the RELAYER keeps and
  // charges (see fixedAmountTypedData) — so this page only shows it; editing
  // the URL or the request changes nothing (review H2). Only for a link that is
  // open-amount on-chain; a USDC-fixed link has its amount on-chain. When the
  // price can't be read the page waits and offers a retry: showing an open
  // amount instead would take an amount the relayer then would not charge.
  const [fixed, setFixed] = useState<
    | { status: "none" }
    | { status: "loading" }
    | { status: "fixed"; amount6: bigint }
    | { status: "error"; message: string }
    | { status: "outdated" }
  >({ status: "none" });
  const [priceRetry, setPriceRetry] = useState(0);
  useEffect(() => {
    if (state !== "verified" || !link || link.amount !== 0n) {
      setFixed({ status: "none" });
      return;
    }
    let alive = true;
    setFixed({ status: "loading" });
    fetchLinkPrice(safeLinkId as `0x${string}`)
      .then((p) => {
        if (!alive) return;
        // A link from the short-lived version that carried its price in the
        // URL (?fa=&fs=): the relayer never stored that price, so without this
        // it would open as pay-anything. Ask for a new link instead.
        if (!p && new URLSearchParams(window.location.search).has("fa")) setFixed({ status: "outdated" });
        else if (!p) setFixed({ status: "none" });
        // The relayer refuses a price in another currency at payment time; say
        // so now rather than let the customer tap Pay into that refusal.
        else if (p.currency.toLowerCase() !== link.currency.toLowerCase()) {
          setFixed({ status: "error", message: "This payment link's price could not be verified. Please ask the merchant for a new link." });
        } else setFixed({ status: "fixed", amount6: p.amount6 });
      })
      .catch((e: any) => {
        if (alive) setFixed({ status: "error", message: e?.message || "Could not load this link's price. Please try again." });
      });
    return () => { alive = false; };
  }, [state, link, safeLinkId, priceRetry]);

  // Warm the customer's own (thirdweb-free) relay identity as soon as the
  // page is viable, so it's ready before they tap Pay.
  useEffect(() => {
    if (state === "verified") getCustomerIdentity().catch(() => {});
  }, [state]);

  // Warm the offramp circle the same way, and for the same reason.
  //
  // handlePay used to resolve this on the tap, which put a subgraph round trip
  // between the customer pressing Pay and anything happening — on a phone, on
  // mobile data, standing at a counter. It is knowable the moment the link is
  // read (it depends only on the link's currency), so resolve it while they are
  // still reading the amount.
  //
  // This is a CACHE, not a gate: handlePay still resolves on demand if this
  // has not landed yet, so a slow or failed prefetch delays nothing and breaks
  // nothing. resolveCircleId keeps its own 60s cache, so the second call is
  // free anyway.
  const [circleId, setCircleId] = useState<bigint | null>(null);
  useEffect(() => {
    if (state !== "verified" || !link) return;
    const code = currencyFromBytes32(link.currency);
    if (!code) return;
    let alive = true;
    resolveCircleId(code)
      .then((id) => { if (alive && id !== null) setCircleId(id); })
      .catch(() => {});
    // Warm the SDK's routing too (routeLinkCircle in handlePay): its first call
    // loads the partner data and took ~15 s on mainnet, later ones under 1 s.
    // The answer is discarded — the real route is taken for the real amount.
    reader
      .readContract({ address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "proxyAddress", args: [link.owner] } as any)
      .then((proxy) =>
        routeLinkCircle({ currency: code, usdcAmount: 1_000000n, fiatAmount: 0n, user: proxy as `0x${string}` })
      )
      .catch(() => {});
    return () => { alive = false; };
  }, [state, link]);

  // The merchant's live per-transaction ceiling for this link's currency.
  //
  // Only a variable link needs it, and it needs it badly: on a counter QR the
  // CUSTOMER types the amount, so nothing else stands between them and a number
  // the contract will refuse. Without this they type it, tap Pay, wait through
  // a relayer round-trip, and are told "This amount is above the limit for this
  // merchant" — after the worker has already spent a simulation on it. A fixed
  // link was priced by the merchant at creation and cannot drift into this.
  //
  // Read live rather than using the compiled-in default (50 USDC for INR, 100
  // otherwise), because an admin can raise a merchant's cap with setPerTxCap
  // and no redeploy — the same reason the /qr terminal reads it live.
  const [perTxCapUsdc6, setPerTxCapUsdc6] = useState<bigint | null>(null);
  useEffect(() => {
    // Keyed on the merchant's REGISTERED currency, exactly as the contract's
    // validateOrder and the relayer do. Using the link's currency blocked valid
    // payments (or let through ones the contract then refused) whenever a
    // merchant's link was in a different currency from their registration.
    if (state !== "verified" || !link || link.amount !== 0n || !merchantCurrency) return;
    let alive = true;
    reader
      .readContract({
        address: CONTRACT_ADDRESS,
        abi: INTEGRATOR_ABI,
        functionName: "perTxCap",
        args: [merchantCurrency],
      } as any)
      .then((cap: any) => {
        if (alive && typeof cap === "bigint" && cap > 0n) setPerTxCapUsdc6(cap);
      })
      // Unreadable: leave the cap unknown and let the contract be the judge,
      // exactly as the worker does. A failed read must not block a payment that
      // would have been fine.
      .catch(() => {});
    return () => { alive = false; };
  }, [state, link, merchantCurrency]);

  // Resume the order this browser already placed on this link (see
  // loadStoredOrder): same screen, same countdown (the widget derives it from
  // the chain's acceptance time), until it completes, is cancelled or times out.
  useEffect(() => {
    if (!safeLinkId) return;
    const stored = loadStoredOrder(safeLinkId);
    if (stored) {
      setOrderId(stored.orderId);
      setQuotedFiat(typeof stored.fiat === "number" && stored.fiat > 0 ? stored.fiat : null);
    }
  }, [safeLinkId]);

  // Remember a freshly placed (or freshly resolved) order. `at` is only set the
  // first time, so a reload never extends the window.
  useEffect(() => {
    if (!safeLinkId || !orderId) return;
    if (loadStoredOrder(safeLinkId)?.orderId === orderId) return;
    saveStoredOrder(safeLinkId, { orderId, at: Date.now(), ...(quotedFiat ? { fiat: quotedFiat } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeLinkId, orderId]);

  // Resume a payment that was still confirming when the page was left or
  // reloaded, instead of offering the Pay button again.
  useEffect(() => {
    if (!safeLinkId || orderId) return;
    if (getPendingPayment(safeLinkId)) setConfirming(true);
  }, [safeLinkId, orderId]);

  useEffect(() => {
    if (!confirming || !safeLinkId) return;
    let alive = true;
    resolvePendingPayment(safeLinkId, { isCancelled: () => !alive })
      .then((id) => {
        if (!alive) return;
        setOrderId(id);
        setConfirming(false);
      })
      .catch((e: any) => {
        if (!alive) return;
        setConfirming(false);
        setPrepareError(e?.message || t("pl.errPrepare"));
      });
    return () => { alive = false; };
  }, [confirming, safeLinkId]);

  if (!PAYMENT_LINKS_ENABLED) {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.unavailable")}</p>
      </Centered>
    );
  }

  if (state === null) {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.loading")}</p>
      </Centered>
    );
  }

  if (state === "retired") {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.retired")}</p>
      </Centered>
    );
  }

  if (state === "notFound") {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.notFound")}</p>
      </Centered>
    );
  }

  if (state === "unverified") {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.unverified")}</p>
        <button className="pl-retry-btn" onClick={() => setRetry((r) => r + 1)}>{t("pl.refresh")}</button>
      </Centered>
    );
  }

  // state === "verified" past this point
  const l = link!;
  const isRevoked = l.status !== LinkStatus.ACTIVE;
  const isExpired = l.expiresAt !== 0n && BigInt(Math.floor(Date.now() / 1000)) > l.expiresAt;
  const isExhausted = l.maxUses !== 0 && l.uses >= l.maxUses;

  // A payment already in progress on this page takes priority over the
  // link's own state: on a single-use link, the customer's OWN order is what
  // used it up, and a reload must show that order, not "already used".
  const inProgress = Boolean(orderId) || confirming;

  if (isRevoked && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.revoked")}</p>
      </Centered>
    );
  }
  if (isExpired && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.expired")}</p>
      </Centered>
    );
  }
  if (isExhausted && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.exhausted")}</p>
      </Centered>
    );
  }

  if (fixed.status === "outdated" && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">{t("pl.outdated")}</p>
      </Centered>
    );
  }
  if (fixed.status === "error" && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">{fixed.message}</p>
        <button className="pl-retry-btn" onClick={() => setPriceRetry((r) => r + 1)}>{t("pl.tryAgain")}</button>
      </Centered>
    );
  }

  const isVariable = l.amount === 0n;
  // Open-amount on-chain, with a local price the relayer keeps and charges.
  const fixedLocal6 = isVariable && fixed.status === "fixed" ? fixed.amount6 : null;
  const fixedLocal = fixedLocal6 !== null ? Number(fixedLocal6) / 1e6 : null;
  const checkingFixed = isVariable && fixed.status === "loading";
  const customerTypes = isVariable && fixedLocal === null && !checkingFixed;
  // USDC-fixed link: `l.amount` is 6-dec USDC-equivalent, not fiat — convert
  // back through the live price so the displayed number matches what the widget
  // will actually charge (see the priceCfg effect above). Falls back to the
  // raw units while priceCfg is still loading rather than showing nothing.
  const amountNum =
    fixedLocal !== null
      ? fixedLocal
      : checkingFixed
        ? 0
        : isVariable
          ? Number(amountInput) || 0
          : priceCfg
            ? fiatForUsdc(l.amount, priceCfg)
            : Number(l.amount) / 1e6;
  // The cap expressed in the customer's own currency, so the message names a
  // number they recognise rather than a USDC figure they have no way to relate
  // to what they just typed. Unknown until both reads land — and "unknown"
  // means "do not block", since the contract still enforces it either way.
  const capFiat =
    isVariable && perTxCapUsdc6 && priceCfg ? fiatForUsdc(perTxCapUsdc6, priceCfg) : null;
  const overCap = capFiat !== null && amountNum > capFiat;
  const canPay = (isVariable ? amountNum > 0 && !overCap : true) && !confirming && !stuckReference;
  const merchantLabel = shopName || shortAddr(l.owner);
  const merchantInitials = (shopName ? shopName.replace(/[^a-zA-Z0-9]/g, "") : merchantLabel).slice(0, 2).toUpperCase();

  async function handlePay() {
    if (!canPay || preparing) return;
    setPreparing(true);
    setPrepareError("");
    try {
      let quantity = l.amount;
      if (isVariable) {
        const fiat = fixedLocal !== null ? fixedLocal : Number(amountInput);
        if (!fiat || fiat <= 0) throw new Error(t("pl.errEnterAmount"));
        // Priced NOW, not at page load: the protocol charges the customer at the
        // price in force when the order is placed, so pricing with a stale rate
        // would miss the amount they were shown.
        const cfg = (country ? await fetchPriceConfig(country.code).catch(() => null) : null) ?? priceCfg;
        if (!cfg) throw new Error(t("pl.errNoPrice"));
        // Below p2p.me's small-order fee the fee alone would cost more than the
        // amount, and the customer would be charged it on top.
        const floor = minimumFiat(cfg);
        if (fiat < floor) {
          throw new Error(
            t("pl.errTooSmallMin", { min: country ? fmtPayerFiat(country, Math.ceil(floor * 100) / 100) : Math.ceil(floor * 100) / 100 })
          );
        }
        quantity = usdcForFiat(fiat, cfg);
        if (quantity <= 0n) throw new Error(t("pl.errTooSmall"));
      }
      // What the relayer charges, in the customer's currency: on an open-amount
      // link it prices this at placement (a fixed-price link charges its own,
      // whatever is sent). `quantity` above is only for a relayer that predates
      // pricing, which ignores this.
      const fiatAmount6 = isVariable
        ? fixedLocal6 ?? BigInt(Math.round(Number(amountInput) * 1e6))
        : undefined;
      // The same attempt across a lost answer or a reload, so tapping Pay again
      // cannot place a second order (review: duplicate orders).
      const idempotencyKey = attemptKeyFor(safeLinkId, fiatAmount6 ?? l.amount);

      // The offramp circle. The relayer takes circleId from the request and
      // defaults it to 0 — not a real circle — so it must be chosen here. It is
      // ROUTED, as p2p.me's widget routes: to a circle with partners eligible
      // for this amount (review M5), not simply the first one listed. Only when
      // routing itself fails does it fall back to the currency's circle — warmed
      // while the customer was reading the page, or resolved now.
      const linkCurrency = currencyFromBytes32(l.currency);
      let circle: bigint | null = null;
      if (linkCurrency) {
        const proxy = (await reader
          .readContract({ address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "proxyAddress", args: [l.owner] } as any)
          .catch(() => null)) as `0x${string}` | null;
        const routed = proxy
          ? await routeLinkCircle({
              currency: linkCurrency,
              usdcAmount: quantity,
              fiatAmount: BigInt(Math.round(amountNum * 1e6)),
              user: proxy,
            })
          : null;
        if (routed === "none") {
          throw new Error(t("pl.errBusy"));
        }
        circle = routed ?? circleId ?? (await resolveCircleId(linkCurrency));
      }
      if (circle === null) throw new Error(t("pl.errNoCurrency"));

      const identity = await getCustomerIdentity();
      const placeOrder = makeRelayerPlaceOrder({
        linkId: safeLinkId as `0x${string}`,
        publicClient: reader,
        quantity,
        circleId: Number(circle),
        getIdentity: async () => identity,
        getHumanSolution,
        fiatAmount6,
        idempotencyKey,
      });
      // Screening runs BEFORE the order is placed, and places it itself on
      // approval — the fraud engine links its activity log to the order id, so
      // the two must happen together rather than as two independent steps.
      //
      // Without this an INR order is placed but never picked up: the merchant
      // app only accepts an order with an approved screening record, and INR
      // buy orders are not auto-approved. The customer waited on "Finding a
      // payment provider…" until the order expired, with nothing anywhere
      // saying why. When screening is unconfigured this is a passthrough.
      const attemptFiat6 = fiatAmount6 ?? l.amount;
      const newOrderId = await placeScreenedOrder({
        place: async () => (await placeOrder()).orderId,
        fiatAmount: amountNum,
        usdcAmount: Number(quantity) / 1e6,
        currency: linkCurrency,
        merchant: l.owner,
        // One screening per attempt, not per tap: /api/pay replays this
        // attempt's first answer, so a second activity log would hit the fraud
        // engine's one-order-in-flight rule and refuse a payment that already
        // exists (review item 4).
        alreadyScreened: attemptScreening(safeLinkId, attemptFiat6, idempotencyKey),
        onScreened: (activityLogId) =>
          rememberAttemptScreening(safeLinkId, attemptFiat6, idempotencyKey, activityLogId),
      });
      clearAttempt(safeLinkId);
      // Set together with the order id so the saved order carries the quote.
      setQuotedFiat(amountNum > 0 ? amountNum : null);
      setOrderId(newOrderId);
    } catch (e: any) {
      if (e instanceof PaymentPendingError) {
        // Settled as far as this page goes: the pending follow-up owns it now.
        clearAttempt(safeLinkId);
        if (e.resumable) {
          // Keep the Pay button off and follow it up; the effect above
          // resolves the order and mounts the payment widget. The order id
          // arrives later, so record the quote now.
          setQuotedFiat(amountNum > 0 ? amountNum : null);
          setConfirming(true);
        } else {
          setStuckReference(e.reference);
          setPrepareError(t("pl.errStuck", { msg: e.message, ref: e.reference }));
        }
        return;
      }
      setPrepareError(e?.message || t("pl.errPrepare"));
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="pl-page">
      {orderId ? (
        <PaymentLinkWidget
          linkId={safeLinkId as `0x${string}`}
          merchantName={merchantLabel}
          currencyBytes32={l.currency}
          quotedFiat={quotedFiat}
          orderId={orderId}
          onError={() => {}}
          onComplete={(id) => {
            if (!loadStoredOrder(safeLinkId)?.done) saveStoredOrder(safeLinkId, { orderId: id, at: Date.now(), done: true });
          }}
          onCancel={() => clearStoredOrder(safeLinkId)}
          // Expiry is NOT cancellation: the order can still be live on-chain
          // (a customer may have paid late), so it stays stored until the chain
          // says cancelled/completed or its TTL passes.
          onNewPayment={() => {
            clearStoredOrder(safeLinkId);
            setQuotedFiat(null);
            setOrderId(null);
            setPrepareError("");
          }}
          getHumanSolution={getHumanSolution}
        />
      ) : (
        <div className="pl-hero">
          <NoPageScroll />
          <header className="pl-top">
            <img className="pl-logo pl-logo-payqr" src="/payqr-mark-sm.png" alt="PayQR" width={44} height={28} />
            <span className="pl-top-line" aria-hidden="true" />
            <img className="pl-logo pl-logo-p2p" src="/p2pdotme-sm.png" alt="p2p.me" width={28} height={34} />
          </header>

          <div className="pl-hero-main">
            <div className="pl-card">
              <div className="pl-avatar" aria-hidden="true">{merchantInitials || "•"}</div>
              <div className="pl-hero-name">{merchantLabel}</div>

              {customerTypes ? (
                <>
                  <div className="pl-amount-label">{t("pl.amount")}</div>
                  <div className="pl-amount-input-wrap">
                    {/* `country` is non-null whenever a link has loaded, and this
                        input only renders past that point — but guard rather than
                        assert, and guard with nothing rather than with a rupee sign:
                        an empty symbol is honest, a wrong one is not. */}
                    <span className="pl-amount-cur">{country?.symbol ?? ""}</span>
                    <input
                      className="pl-amount-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="0"
                      // Sized to what is typed so the currency sign sits right
                      // against the number instead of at the far edge.
                      style={{ width: `${Math.max(1, fmtTyped(amountInput).length)}ch` }}
                      value={fmtTyped(amountInput)}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/,/g, "");
                        if (/^\d*\.?\d{0,2}$/.test(digits)) setAmountInput(digits);
                      }}
                      autoFocus
                    />
                  </div>
                </>
              ) : checkingFixed ? (
                <div className="pl-hero-amount">…</div>
              ) : (
                <div className="pl-hero-amount">{country && fmtPayerFiat(country, amountNum)}</div>
              )}

              {overCap && country && capFiat !== null && (
                <p className="pl-error">{t("pl.overCap", { max: fmtPayerFiat(country, capFiat) })}</p>
              )}
              {prepareError && <p className="pl-error">{prepareError}</p>}
              {confirming && <p className="pl-notice">{t("pl.sentConfirming")}</p>}
            </div>
          </div>

          <div className="pl-hero-foot">
            <button className="pl-pay-btn" onClick={handlePay} disabled={preparing || !canPay}>
              {confirming ? (
                <span className="pl-btn-loading">
                  <span className="pl-spinner" aria-hidden="true" />
                  {t("pl.btnConfirming")}
                </span>
              ) : preparing ? (
                <span className="pl-btn-loading">
                  <span className="pl-spinner" aria-hidden="true" />
                  {t("pl.btnPreparing")}
                </span>
              ) : checkingFixed ? (
                t("pl.btnChecking")
              ) : isVariable ? (
                overCap ? (
                  t("pl.btnTooHigh")
                ) : amountNum > 0 && country ? (
                  t("pl.btnContinue")
                ) : (
                  t("pl.btnEnter")
                )
              ) : (
                t("pl.btnContinue")
              )}
            </button>
            <p className="pl-powered">{t("pl.poweredBy")}</p>
          </div>
        </div>
      )}

      <style jsx global>{`
        :root {
          --pq-blue: #1d5be0;
          --pq-blue-dark: #1646b8;
          --pq-blue-soft: #eef4ff;
          --pq-ink: #0f1b3d;
          --pq-muted: #5b6b8c;
          --pq-faint: #8a97b3;
          --pq-line: #e1e8f5;
          --pq-bg: #f6f8ff;
          --pq-danger: #d92d20;
          --pq-danger-soft: #fdecea;
        }

        .pl-page {
          position: relative;
          min-height: 100vh;
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-family: "Inter", "Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          background:
            radial-gradient(120% 55% at 50% -10%, #dfe8ff 0%, rgba(223,232,255,0) 70%),
            linear-gradient(180deg, #f6f8ff 0%, #ffffff 100%);
          color: var(--pq-ink);
          -webkit-font-smoothing: antialiased;
        }

        /* Step 1 is one fixed screen — logos on top, the payment card in the
           middle, the button at the bottom — and never scrolls. */
        .pl-hero {
          width: 100%; max-width: 440px;
          height: 100vh; height: 100dvh; overflow: hidden;
          display: flex; flex-direction: column;
          padding: 18px 20px calc(22px + env(safe-area-inset-bottom));
          box-sizing: border-box;
        }

        /* The app's body is min-height: 100vh, which on a phone is taller than
           the visible screen (the address bar), so the page could still be
           scrolled. While step 1 shows, the page itself is pinned to the screen. */
        html.pl-noscroll, html.pl-noscroll body { height: 100dvh; min-height: 0; overflow: hidden; overscroll-behavior: none; }

        .pl-top { position: relative; display: flex; align-items: center; justify-content: space-between; height: 40px; flex: none; }
        .pl-logo { display: block; object-fit: contain; mix-blend-mode: multiply; }
        .pl-logo-payqr { height: 28px; width: auto; }
        .pl-logo-p2p { height: 34px; width: auto; }
        .pl-top-line { position: absolute; left: 50%; top: 50%; width: 1.5px; height: 22px; transform: translate(-50%, -50%); background: var(--pq-line); border-radius: 2px; }

        .pl-hero-main { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .pl-hero-foot { flex: none; display: flex; flex-direction: column; align-items: center; }

        .pl-card {
          width: 100%; box-sizing: border-box;
          display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px;
          padding: 30px 20px 28px;
          background: #fff; border: 1px solid var(--pq-line); border-radius: 28px;
          box-shadow: 0 24px 48px -28px rgba(29,60,140,0.28), 0 2px 6px rgba(29,60,140,0.04);
        }
        .pl-avatar {
          width: 52px; height: 52px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: var(--pq-blue-soft); color: var(--pq-blue);
          font-size: 17px; font-weight: 700; letter-spacing: 0.02em;
        }
        .pl-hero-name {
          font-size: 16px; font-weight: 600; letter-spacing: -0.01em; color: var(--pq-muted);
          max-width: 100%; overflow-wrap: anywhere;
        }
        .pl-hero-amount {
          margin-top: 6px;
          font-size: 52px; font-weight: 800; letter-spacing: -0.035em; line-height: 1.05;
          color: var(--pq-ink); font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
        }

        .pl-amount-label { margin-top: 8px; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--pq-faint); }
        .pl-amount-input-wrap { display: flex; align-items: baseline; justify-content: center; gap: 6px; max-width: 100%; }
        .pl-amount-cur { font-size: 34px; font-weight: 700; color: var(--pq-faint); }
        .pl-amount-input {
          border: none; background: none; font-family: inherit;
          font-size: 52px; font-weight: 800; letter-spacing: -0.035em;
          color: var(--pq-ink); min-width: 1ch; max-width: 62vw; text-align: left;
          font-variant-numeric: tabular-nums; padding: 0;
        }
        .pl-amount-input:focus { outline: none; }
        .pl-amount-input::placeholder { color: #c3cce0; }

        .pl-error { margin: 0; font-size: 13.5px; color: var(--pq-danger); text-align: center; max-width: 34ch; }
        .pl-notice { margin: 0; font-size: 14.5px; font-weight: 500; line-height: 1.5; color: var(--pq-muted); text-align: center; max-width: 34ch; padding: 0 20px; }

        /* Soft, pill-shaped primary action. */
        .pl-pay-btn {
          width: 100%; border: none; cursor: pointer;
          background: linear-gradient(180deg, #4b78ee 0%, #3a64dc 100%); color: #ffffff;
          font-family: inherit; font-size: 16px; font-weight: 600; letter-spacing: 0.005em;
          padding: 17px 24px; border-radius: 999px;
          box-shadow: 0 10px 22px -12px rgba(58,100,220,0.55);
          transition: filter .15s ease, transform .08s ease, opacity .15s ease;
        }
        .pl-pay-btn:hover:not(:disabled) { filter: brightness(1.04); }
        .pl-pay-btn:active:not(:disabled) { transform: translateY(1px); }
        .pl-pay-btn:disabled { cursor: default; opacity: 0.5; box-shadow: none; }
        .pl-pay-btn:focus-visible, .pl-retry-btn:focus-visible { outline: 3px solid rgba(58,100,220,0.3); outline-offset: 2px; }

        .pl-btn-loading { display: inline-flex; align-items: center; justify-content: center; gap: 10px; }
        .pl-spinner {
          width: 16px; height: 16px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff;
          animation: plSpin 0.7s linear infinite;
        }
        @keyframes plSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .pl-spinner { animation-duration: 1.4s; } }

        .pl-powered { margin: 14px 0 0; font-size: 12px; line-height: 1.45; color: var(--pq-faint); text-align: center; max-width: 34ch; }

        .pl-retry-btn {
          margin-top: 16px; border: none; cursor: pointer;
          background: linear-gradient(180deg, #4b78ee 0%, #3a64dc 100%); color: #fff; font-family: inherit; font-size: 15px; font-weight: 600;
          padding: 13px 30px; border-radius: 999px;
        }
        .pl-retry-btn:hover { filter: brightness(1.04); }

        @media (min-width: 640px) {
          .pl-hero { height: auto; min-height: 0; max-height: 100dvh; padding: 32px; }
          .pl-hero-main { flex: none; padding: 28px 0 32px; }
          .pl-hero-foot { width: 100%; max-width: 360px; align-self: center; }
        }
        @media (max-width: 380px) {
          .pl-hero-amount, .pl-amount-input { font-size: 44px; }
          .pl-amount-cur { font-size: 28px; }
        }
        @media (max-height: 620px) {
          .pl-avatar { display: none; }
          .pl-card { padding: 20px 16px; }
        }
      `}</style>
    </div>
  );
}

/** Pins the page to the screen (no scrolling) for as long as it is mounted. */
function NoPageScroll() {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("pl-noscroll");
    return () => root.classList.remove("pl-noscroll");
  }, []);
  return null;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="pl-page">
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "0 20px" }}>
        {children}
      </div>
      <style jsx global>{`
        .pl-page {
          position: relative; min-height: 100vh; min-height: 100dvh;
          display: flex; align-items: center; justify-content: center;
          font-family: "Inter", "Manrope", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          background: #f6f8ff; color: #0f1b3d;
        }
        .pl-notice { margin: 0; font-size: 14.5px; font-weight: 500; line-height: 1.5; color: #5b6b8c; text-align: center; max-width: 34ch; }
        .pl-retry-btn { border: none; cursor: pointer; background: linear-gradient(180deg, #4b78ee 0%, #3a64dc 100%); color: #fff; font-family: inherit; font-size: 15px; font-weight: 600; padding: 13px 30px; border-radius: 999px; }
      `}</style>
    </div>
  );
}
