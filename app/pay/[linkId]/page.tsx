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
  isLinkOwnerZero,
  makeRelayerPlaceOrder,
  fetchLink,
  decodeLinkId,
  PaymentPendingError,
  getPendingPayment,
  resolvePendingPayment,
  parseFixedAmount,
  verifyFixedAmount,
} from "../../../lib/paymentLinks";
import type { PaymentLink } from "../../../lib/paymentLinks";
import { getCustomerIdentity } from "../../../lib/customerRelayIdentity";
import { placeScreenedOrder } from "../../../lib/customerScreening";
import { resolveCircleId } from "../../../lib/p2p";
import { useHumanCheck } from "../../../components/HumanCheck";

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
        setState(isLinkOwnerZero(l) ? "notFound" : "verified");
      } catch (e) {
        if (!alive) return;
        if (!isDefinitiveError(e)) return setState("unverified");
        // Not on the current contract. Was it made on an earlier one?
        for (const prev of PREV_CONTRACT_ADDRESSES) {
          try {
            const old = await fetchLink(reader, safeLinkId, prev);
            if (!alive) return;
            if (!isLinkOwnerZero(old)) return setState("retired");
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

  // A fixed amount in the customer's own currency, carried in the URL and
  // signed by the merchant (see fixedAmountTypedData). Only for a link that is
  // open-amount on-chain; a USDC-fixed link ignores it. Present but not signed
  // by this link's owner means the URL was changed — the page refuses it rather
  // than falling back to an open amount the customer could type.
  const [fixed, setFixed] = useState<
    { status: "none" } | { status: "checking" } | { status: "valid"; amount: number } | { status: "invalid" }
  >({ status: "none" });
  useEffect(() => {
    if (state !== "verified" || !link || link.amount !== 0n) {
      setFixed({ status: "none" });
      return;
    }
    const parsed = parseFixedAmount(window.location.search);
    if (parsed === null) {
      setFixed({ status: "none" });
      return;
    }
    if (parsed === "malformed") {
      setFixed({ status: "invalid" });
      return;
    }
    let alive = true;
    setFixed({ status: "checking" });
    verifyFixedAmount(
      reader,
      ACTIVE_CHAIN.id,
      { linkId: safeLinkId as `0x${string}`, owner: link.owner, currency: link.currency },
      parsed
    ).then((ok) => {
      if (!alive) return;
      setFixed(ok ? { status: "valid", amount: Number(parsed.amount6) / 1e6 } : { status: "invalid" });
    });
    return () => { alive = false; };
  }, [state, link, safeLinkId]);

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
        setPrepareError(e?.message || "This payment could not be confirmed. Please try again.");
      });
    return () => { alive = false; };
  }, [confirming, safeLinkId]);

  if (!PAYMENT_LINKS_ENABLED) {
    return (
      <Centered>
        <p className="pl-notice">Payment Links isn't available on this deployment.</p>
      </Centered>
    );
  }

  if (state === null) {
    return (
      <Centered>
        <p className="pl-notice">Loading…</p>
      </Centered>
    );
  }

  if (state === "retired") {
    return (
      <Centered>
        <p className="pl-notice">
          This payment link was made on an earlier version of PayQR and no longer accepts
          payments. Please ask the merchant for a new link.
        </p>
      </Centered>
    );
  }

  if (state === "notFound") {
    return (
      <Centered>
        <p className="pl-notice">This payment link doesn't exist.</p>
      </Centered>
    );
  }

  if (state === "unverified") {
    return (
      <Centered>
        <p className="pl-notice">Couldn't verify this link right now.</p>
        <button className="pl-retry-btn" onClick={() => setRetry((r) => r + 1)}>Refresh</button>
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
        <p className="pl-notice">This payment link has been revoked by the merchant.</p>
      </Centered>
    );
  }
  if (isExpired && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">This payment link has expired.</p>
      </Centered>
    );
  }
  if (isExhausted && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">This payment link has already been used the maximum number of times.</p>
      </Centered>
    );
  }

  if (fixed.status === "invalid" && !inProgress) {
    return (
      <Centered>
        <p className="pl-notice">
          This payment link has been changed or isn't valid. Please ask the merchant for a new link.
        </p>
      </Centered>
    );
  }

  const isVariable = l.amount === 0n;
  // Open-amount on-chain, but the merchant fixed the local amount in the URL.
  const fixedLocal = isVariable && fixed.status === "valid" ? fixed.amount : null;
  const checkingFixed = isVariable && fixed.status === "checking";
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
        if (!fiat || fiat <= 0) throw new Error("Enter a valid amount.");
        // Priced NOW, not at page load: the protocol charges the customer at the
        // price in force when the order is placed, so pricing with a stale rate
        // would miss the amount they were shown.
        const cfg = (country ? await fetchPriceConfig(country.code).catch(() => null) : null) ?? priceCfg;
        if (!cfg) throw new Error("Could not price this amount right now. Try again shortly.");
        // Below p2p.me's small-order fee the fee alone would cost more than the
        // amount, and the customer would be charged it on top.
        const floor = minimumFiat(cfg);
        if (fiat < floor) {
          throw new Error(
            `That amount is too small to pay — the minimum is ${country ? fmtPayerFiat(country, Math.ceil(floor * 100) / 100) : Math.ceil(floor * 100) / 100}.`
          );
        }
        quantity = usdcForFiat(fiat, cfg);
        if (quantity <= 0n) throw new Error("That amount is too small.");
      }

      // The offramp circle for this link's currency, resolved from the
      // subgraph exactly like the merchant /qr flow does. The worker takes
      // circleId from the request body and defaults it to 0 — which is not a
      // real circle, so leaving it unset places every link order against a
      // circle the protocol has no liquidity for.
      // Prefer the value warmed while the customer was reading the page; fall
      // back to resolving it here so a slow or failed prefetch costs latency,
      // never the payment.
      const linkCurrency = currencyFromBytes32(l.currency);
      const circle = circleId ?? (linkCurrency ? await resolveCircleId(linkCurrency) : null);
      if (circle === null) throw new Error("This currency isn't available for payment right now.");

      const identity = await getCustomerIdentity();
      const placeOrder = makeRelayerPlaceOrder({
        linkId: safeLinkId as `0x${string}`,
        publicClient: reader,
        quantity,
        circleId: Number(circle),
        getIdentity: async () => identity,
        getHumanSolution,
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
      const newOrderId = await placeScreenedOrder({
        place: async () => (await placeOrder()).orderId,
        fiatAmount: amountNum,
        usdcAmount: Number(quantity) / 1e6,
        currency: linkCurrency,
        merchant: l.owner,
      });
      // Set together with the order id so the saved order carries the quote.
      setQuotedFiat(amountNum > 0 ? amountNum : null);
      setOrderId(newOrderId);
    } catch (e: any) {
      if (e instanceof PaymentPendingError) {
        if (e.resumable) {
          // Keep the Pay button off and follow it up; the effect above
          // resolves the order and mounts the payment widget. The order id
          // arrives later, so record the quote now.
          setQuotedFiat(amountNum > 0 ? amountNum : null);
          setConfirming(true);
        } else {
          setStuckReference(e.reference);
          setPrepareError(
            `${e.message} Please don't pay again. If it doesn't complete, contact support with this reference: ${e.reference}`
          );
        }
        return;
      }
      setPrepareError(e?.message || "Could not prepare this payment. Please try again.");
    } finally {
      setPreparing(false);
    }
  }

  return (
    <div className="pl-page">
      <div className="pl-scene" aria-hidden="true">
        <PalmCorner className="pl-palm pl-palm-tl" flip={false} />
        <PalmCorner className="pl-palm pl-palm-tr" flip={true} />
        <Bird className="pl-bird pl-bird-1" />
        <Bird className="pl-bird pl-bird-2" />
        <Bird className="pl-bird pl-bird-3" />
        <div className="pl-clouds" />
        <div className="pl-wave pl-wave-1" />
        <div className="pl-wave pl-wave-2" />
        <div className="pl-sand-shadow pl-sand-shadow-l" />
        <div className="pl-sand-shadow pl-sand-shadow-r" />
      </div>

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
          <div className="pl-avatar-glow">
            <div className="pl-avatar">{merchantInitials}</div>
          </div>
          <div className={shopName ? "pl-hero-name" : "pl-hero-name pl-hero-name-addr"}>{merchantLabel}</div>

          {customerTypes ? (
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
                value={fmtTyped(amountInput)}
                onChange={(e) => {
                  const digits = e.target.value.replace(/,/g, "");
                  if (/^\d*\.?\d{0,2}$/.test(digits)) setAmountInput(digits);
                }}
                autoFocus
              />
            </div>
          ) : checkingFixed ? (
            <div className="pl-hero-amount">…</div>
          ) : (
            <div className="pl-hero-amount">{country && fmtPayerFiat(country, amountNum)}</div>
          )}

          {overCap && country && capFiat !== null && (
            <p className="pl-error">
              This shop can accept up to {fmtPayerFiat(country, capFiat)} in one payment.
            </p>
          )}

          {prepareError && <p className="pl-error">{prepareError}</p>}
          {confirming && (
            <p className="pl-notice">
              Your payment was sent and is being confirmed. Please keep this page open and don't pay again.
            </p>
          )}
          <button className="pl-pay-btn" onClick={handlePay} disabled={preparing || !canPay}>
            {confirming ? (
              <span className="pl-btn-loading">
                <span className="pl-spinner" aria-hidden="true" />
                Confirming your payment…
              </span>
            ) : preparing ? (
              <span className="pl-btn-loading">
                <span className="pl-spinner" aria-hidden="true" />
                Preparing your payment…
              </span>
            ) : checkingFixed ? (
              "Checking link…"
            ) : isVariable ? (
              overCap ? (
                "Amount too high"
              ) : amountNum > 0 && country ? (
                `Pay ${fmtPayerFiat(country, amountNum)}`
              ) : (
                "Enter an amount"
              )
            ) : (
              country ? `Pay ${fmtPayerFiat(country, amountNum)}` : "Pay"
            )}
          </button>
          <p className="pl-privacy">
            To help keep payments safe, we check basic device details (like browser and screen size) when you pay.
          </p>
        </div>
      )}

      <style jsx global>{`
        .pl-privacy { margin: 14px 0 0; font-size: 11.5px; line-height: 1.4; color: rgba(255,255,255,0.75); text-align: center; max-width: 30ch; }
      `}</style>

      <style jsx global>{`
        .pl-page {
          position: relative;
          min-height: 100vh;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(
            180deg,
            #0a5fd6 0%,
            #1279e8 22%,
            #2fa3ee 42%,
            #4fc7ea 58%,
            #7fe0d8 70%,
            #cdeecb 82%,
            #f2e6b8 92%,
            #e8c98a 100%
          );
        }

        .pl-scene { position: absolute; inset: 0; z-index: 0; pointer-events: none; }

        .pl-clouds {
          position: absolute; left: 0; right: 0; top: 58%; height: 14%;
          background:
            radial-gradient(ellipse 70px 20px at 15% 50%, rgba(255,255,255,.75), transparent 70%),
            radial-gradient(ellipse 100px 26px at 40% 40%, rgba(255,255,255,.65), transparent 70%),
            radial-gradient(ellipse 80px 22px at 68% 55%, rgba(255,255,255,.7), transparent 70%),
            radial-gradient(ellipse 60px 18px at 88% 45%, rgba(255,255,255,.55), transparent 70%);
          filter: blur(1px);
        }

        .pl-wave {
          position: absolute; left: -10%; right: -10%; height: 40px;
          border-radius: 50%;
          background: rgba(255,255,255,0.5);
          filter: blur(2px);
        }
        .pl-wave-1 { top: 74%; opacity: .8; }
        .pl-wave-2 { top: 79%; opacity: .55; height: 30px; }

        .pl-sand-shadow {
          position: absolute; bottom: 0; width: 46%; height: 22%;
          background: radial-gradient(ellipse at center, rgba(20,20,30,0.22), transparent 70%);
          filter: blur(6px);
        }
        .pl-sand-shadow-l { left: -6%; transform: rotate(8deg); }
        .pl-sand-shadow-r { right: -6%; transform: rotate(-8deg) scaleX(-1); }

        .pl-palm { position: absolute; width: 46vw; max-width: 260px; height: auto; opacity: 0.96; filter: drop-shadow(0 12px 18px rgba(0,30,20,0.25)); }
        .pl-palm-tl { top: -6%; left: -8%; }
        .pl-palm-tr { top: -6%; right: -8%; }

        .pl-bird { position: absolute; width: 30px; height: auto; opacity: 0.9; animation: plBirdBob 4s ease-in-out infinite; }
        .pl-bird-1 { top: 32%; left: 10%; width: 34px; animation-delay: 0s; }
        .pl-bird-2 { top: 36%; right: 14%; width: 22px; animation-delay: .6s; }
        .pl-bird-3 { top: 40%; right: 9%; width: 16px; animation-delay: 1.1s; }
        @keyframes plBirdBob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @media (prefers-reduced-motion: reduce) { .pl-bird { animation: none; } }

        .pl-hero {
          position: relative; z-index: 1;
          width: 100%; max-width: 460px;
          flex: 1;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          text-align: center;
          padding: 40px 28px 90px;
        }

        .pl-avatar-glow {
          width: 108px; height: 108px; border-radius: 50%;
          background: radial-gradient(circle, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 70%);
          display: flex; align-items: center; justify-content: center;
        }
        .pl-avatar {
          width: 84px; height: 84px; border-radius: 50%;
          background: #ffffff; color: #453deb;
          font-weight: 800; font-size: 22px; letter-spacing: -0.02em;
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 10px 30px -8px rgba(10, 30, 60, 0.35);
        }

        .pl-hero-name {
          margin-top: 18px; font-size: 17px; font-weight: 700; color: #ffffff;
          letter-spacing: -0.01em; text-shadow: 0 2px 10px rgba(0,20,50,0.25);
        }
        .pl-hero-name-addr {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
        }

        .pl-hero-amount {
          margin-top: 14px; font-size: 58px; font-weight: 800; letter-spacing: -0.03em;
          line-height: 1; color: #ffffff; font-variant-numeric: tabular-nums;
          text-shadow: 0 4px 22px rgba(0,20,50,0.28);
        }

        .pl-amount-input-wrap {
          margin-top: 14px; display: flex; align-items: baseline; justify-content: center; gap: 4px;
        }
        .pl-amount-cur {
          font-size: 40px; font-weight: 800; color: rgba(255,255,255,0.75);
          text-shadow: 0 4px 22px rgba(0,20,50,0.28);
        }
        .pl-amount-input {
          border: none; background: none; font-family: inherit;
          font-size: 58px; font-weight: 800; letter-spacing: -0.03em;
          color: #ffffff; width: 220px; text-align: center;
          font-variant-numeric: tabular-nums;
          text-shadow: 0 4px 22px rgba(0,20,50,0.28);
        }
        .pl-amount-input:focus { outline: none; }
        .pl-amount-input::placeholder { color: rgba(255,255,255,0.6); }

        .pl-error {
          margin-top: 16px; font-size: 13px; color: #ffe1de;
          text-shadow: 0 1px 6px rgba(0,20,50,0.25); text-align: center;
        }

        .pl-pay-btn {
          margin-top: 30px; width: 100%; max-width: 340px; border: none; cursor: pointer;
          background: #ffffff; color: #453deb;
          font-family: inherit; font-size: 17px; font-weight: 800; letter-spacing: -0.01em;
          padding: 19px 20px; border-radius: 999px;
          box-shadow: 0 18px 40px -14px rgba(0, 20, 60, 0.35);
          transition: transform 0.1s ease, box-shadow 0.15s ease, opacity .15s ease;
        }
        .pl-pay-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 22px 46px -14px rgba(0, 20, 60, 0.4); }
        .pl-pay-btn:active:not(:disabled) { transform: translateY(1px); }
        .pl-pay-btn:disabled { cursor: default; opacity: 0.7; }

        .pl-btn-loading { display: inline-flex; align-items: center; justify-content: center; gap: 10px; }
        .pl-spinner {
          width: 16px; height: 16px; border-radius: 50%;
          border: 2px solid rgba(69,61,235,0.25); border-top-color: #453deb;
          animation: plSpin 0.7s linear infinite;
        }
        @keyframes plSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .pl-spinner { animation-duration: 1.4s; } }

        .pl-notice {
          position: relative; z-index: 1; color: #ffffff; font-size: 15px; font-weight: 600;
          text-align: center; text-shadow: 0 2px 10px rgba(0,20,50,0.25); max-width: 320px; padding: 0 20px;
        }
        .pl-retry-btn {
          position: relative; z-index: 1; margin-top: 16px; border: none; cursor: pointer;
          background: #ffffff; color: #453deb; font-family: inherit; font-size: 14px; font-weight: 700;
          padding: 12px 24px; border-radius: 999px;
        }

        @media (max-width: 380px) {
          .pl-hero-amount, .pl-amount-input { font-size: 48px; }
          .pl-avatar-glow { width: 92px; height: 92px; }
          .pl-avatar { width: 72px; height: 72px; font-size: 20px; }
        }
      `}</style>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="pl-page">
      <div className="pl-scene" aria-hidden="true">
        <PalmCorner className="pl-palm pl-palm-tl" flip={false} />
        <PalmCorner className="pl-palm pl-palm-tr" flip={true} />
      </div>
      <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        {children}
      </div>
      <style jsx global>{`
        .pl-page {
          position: relative; min-height: 100vh; overflow-x: hidden;
          display: flex; align-items: center; justify-content: center;
          font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          background: linear-gradient(180deg, #0a5fd6 0%, #1279e8 22%, #2fa3ee 42%, #4fc7ea 58%, #7fe0d8 70%, #cdeecb 82%, #f2e6b8 92%, #e8c98a 100%);
        }
        .pl-scene { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
        .pl-palm { position: absolute; width: 46vw; max-width: 260px; height: auto; opacity: 0.96; }
        .pl-palm-tl { top: -6%; left: -8%; }
        .pl-palm-tr { top: -6%; right: -8%; }
        .pl-notice { color: #ffffff; font-size: 15px; font-weight: 600; text-align: center; text-shadow: 0 2px 10px rgba(0,20,50,0.25); max-width: 320px; padding: 0 20px; }
        .pl-retry-btn { border: none; cursor: pointer; background: #ffffff; color: #453deb; font-family: inherit; font-size: 14px; font-weight: 700; padding: 12px 24px; border-radius: 999px; }
      `}</style>
    </div>
  );
}

function PalmCorner({ className, flip }: { className: string; flip: boolean }) {
  return (
    <svg
      className={className}
      viewBox="0 0 200 180"
      style={flip ? { transform: "scaleX(-1)" } : undefined}
    >
      <g fill="#1f4d2c" opacity="0.92">
        <path d="M4 6 C40 20 80 50 96 100 C82 66 46 34 4 22 Z" />
        <path d="M2 -4 C46 2 92 22 118 64 C96 34 52 10 2 6 Z" />
        <path d="M8 20 C50 40 84 76 96 120 C76 82 42 52 8 34 Z" />
        <path d="M0 34 C36 58 60 92 68 130 C48 98 22 70 0 50 Z" />
        <path d="M10 -10 C56 -8 104 6 134 40 C108 14 60 -2 10 2 Z" />
      </g>
      <g fill="#173d22" opacity="0.85">
        <path d="M0 0 C34 8 66 30 84 66 C68 40 36 16 0 12 Z" />
        <path d="M6 16 C42 30 72 60 82 96 C64 66 36 40 6 30 Z" />
      </g>
    </svg>
  );
}

function Bird({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 32 14" fill="none">
      <path d="M1 8 C6 2 10 2 16 7 C22 2 26 2 31 8" stroke="rgba(255,255,255,0.92)" strokeWidth="2" strokeLinecap="round" fill="none" />
    </svg>
  );
}
