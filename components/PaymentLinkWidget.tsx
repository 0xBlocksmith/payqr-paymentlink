"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Order } from "@p2pdotme/sdk/orders";
import {
  getStoredQrPayload,
  PAYMENT_ID_FIELDS,
  assignStoredPaymentIdToFieldValues,
  unpackPackedPaymentId,
} from "@p2pdotme/sdk/country";
import type { CurrencyCode } from "@p2pdotme/sdk/country";
import { getCustomerIdentity } from "../lib/customerRelayIdentity";
import { pixPayload } from "../lib/pixBrCode";
import { getCustomerOrder, decryptPayoutAddress, markOrderPaid, cancelCustomerOrder, isStillConfirming, verifyLinkOrder, deviceClockSkewMs } from "../lib/customerOrder";
import { currencyFromBytes32 } from "../lib/contract";
import { countryForCurrency, fmtPayerFiat } from "../lib/countries";
import { ACTIVE_CHAIN } from "../lib/chain";
import { fetchPriceConfig } from "../lib/pricing";
import type { PriceConfig } from "../lib/pricing";
import { PAYMENT_LINK_QR_STYLE } from "./PaymentLinkQR";
import { Logo } from "./Icons";
import { usePayerT, PAYER_DATE_LOCALE } from "../lib/payerI18n";
import type { Hex } from "viem";

/**
 * Customer-facing payment screen for a Payment Link — a NATIVE PayQR UI, not
 * the @p2pdotme/widgets <Checkout> component. Built on real data:
 *
 *   - encUpi (the LP's encrypted payout address) is read straight off the
 *     order via @p2pdotme/sdk/orders' getOrder, then decrypted client-side
 *     with decryptPaymentAddress — both PUBLIC SDK exports, reverse-engineered
 *     from how @p2pdotme/widgets' own checkout.js does the exact same thing
 *     internally (it has no prop/callback that exposes this data, so we read
 *     it ourselves via the same public SDK it's built on).
 *   - "I've paid" / "Cancel order" call the SDK's paidBuyOrder/cancelOrder
 *     .prepare(...) (no signer needed — just produces {to, data}), forwarded
 *     through the ALREADY-DEPLOYED, narrowly-scoped worker /api/relay-tx
 *     endpoint (see worker/src/relayTxHandler.ts) — the same endpoint this
 *     component used to forward <Checkout>'s internal signer calls to.
 *   - The relay identity is the CUSTOMER's own (lib/customerRelayIdentity.ts)
 *     — deliberately independent of thirdweb/useSmartAccount, which is the
 *     MERCHANT's identity mechanism and requires a connected wallet the
 *     customer never has (see PAYMENT-LINKS.md: "no auth, no wallet
 *     provider, the customer never sees a connect prompt").
 *
 * Rail-aware: India (UPI) gets a QR + "Open UPI app" deep link. Brazil (PIX)
 * gets a QR + "Copy Pix code" (PIX has no app-intent scheme — the real-world
 * pattern is Pix Copia e Cola). Any other currency (e.g. Argentina's
 * Transfers 3.0 / CBU-alias) gets a plain payment-details card — no QR/app
 * button, since none of those rails have a deep-link or QR standard.
 */

type UiPhase = "matching" | "accepted" | "paying" | "completed" | "cancelled" | "expired" | "error";

// The protocol's window to pay after a merchant accepts, before it auto-cancels
// the order — p2p.me's <Checkout> widget (AUTO_CANCEL_WINDOW_MS) and user-app
// both use 5 minutes, counted from the order's ON-CHAIN acceptance time. This
// used to be a fixed 9 minutes started whenever this page noticed the
// acceptance, so a customer could still see minutes left — and pay — after the
// order had already been cancelled. Everything about the countdown below is the
// widget's own behaviour, kept identical on purpose — same deadline, same
// rounding, same red threshold.
const AUTO_CANCEL_WINDOW_MS = 5 * 60 * 1000;
const POLL_MS = 4000;

type PaymentLinkWidgetProps = {
  linkId: Hex;
  merchantName?: string;
  /** What the payment is for, when the caller has it (the stored one is merchant-only). */
  description?: string;
  currencyBytes32: Hex;
  /** The fiat amount the payer was quoted when they placed the order. */
  quotedFiat?: number | null;
  onOrderId?: (orderId: string) => void;
  onComplete?: (orderId: string) => void;
  onCancel?: (orderId?: string) => void;
  /** The payment window ran out: the order is over from the customer's side. */
  onExpire?: (orderId: string) => void;
  onError?: (msg: string) => void;
  /** "New payment": the caller forgets this order and shows the pay form again. */
  onNewPayment?: () => void;
  /** The order to track — undefined until the caller has placed one. */
  orderId: string | null;
  /** Solves a fresh human-check challenge for mark-paid/cancel — the relayer
   *  gates both the same way it gates placement. Solved per call, never
   *  cached: a solution is spent once server-side. Optional, so this keeps
   *  working against a deployment with the gate switched off. */
  getHumanSolution?: () => Promise<{ challenge: string; nonce: string } | null>;
};

function fmtTimer(totalSeconds: number) {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function fmtAmount(usdc6: bigint, currencyCode: string): string {
  // The amount itself always comes from the order (actualFiatAmount /
  // fiatAmount); this only decides how it is spelled.
  //
  // It used to hardcode `en-IN` for EVERY currency, so a Brazilian customer saw
  // Indian lakh grouping on their own money — R$ 1,00,000 rather than
  // R$ 100.000. countryForCurrency resolves the right symbol and locale for any
  // currency the protocol settles, and degrades to the ISO code with neutral
  // grouping for one this app has no entry for, rather than to India's.
  return fmtPayerFiat(countryForCurrency(currencyCode), Number(usdc6) / 1e6);
}

/** PayQR's support thread, opened with the order number filled in. */
function supportHref(orderId: string): string {
  return `https://t.me/PayQRdotPRO/1819?text=${encodeURIComponent(`Hi, I need help with payment #${orderId}.`)}`;
}

function upiUri(params:{ upiId: string; merchantName: string; amountInr: string; orderId: string }) {
  const q = new URLSearchParams({
    pa: params.upiId,
    pn: params.merchantName,
    am: String(params.amountInr),
    cu: "INR",
    tr: params.orderId,
  });
  return `upi://pay?${q.toString()}`;
}

/** The QR the SELLER stored with their payout id (e.g. a Pago Móvil bank QR), for
 *  rails where the payer scans a QR the seller uploaded rather than one we can
 *  build ourselves (INR/BRL are built from the handle). null when there is none. */
function sellerQrFor(currency: string, payoutId: string | null): string | null {
  if (!payoutId || currency === "INR" || currency === "BRL") return null;
  try { return getStoredQrPayload(currency as CurrencyCode, payoutId); } catch { return null; }
}

/** A multi-field payout id ("phone|Cédula/RIF|bank") split into labelled rows, the
 *  way p2p.me's own checkout shows it. null for a single-field rail. */
function compoundRowsFor(currency: string, payoutId: string | null): { key: string; label: string; value: string }[] | null {
  if (!payoutId) return null;
  try {
    const fields = PAYMENT_ID_FIELDS[currency as CurrencyCode] ?? [];
    if (fields.length < 2) return null;
    const values = assignStoredPaymentIdToFieldValues(currency as CurrencyCode, payoutId);
    const rows = fields
      .map((f) => ({ key: f.key, label: f.displayLabel ?? f.label, value: values[f.key] ?? "" }))
      .filter((r) => r.value !== "");
    return rows.length ? rows : null;
  } catch { return null; }
}

export function PaymentLinkWidget({
  linkId,
  merchantName = "the merchant",
  description,
  currencyBytes32,
  quotedFiat,
  orderId,
  onOrderId,
  onComplete,
  onCancel,
  onExpire,
  onError,
  onNewPayment,
  getHumanSolution,
}: PaymentLinkWidgetProps) {
  const { t } = usePayerT();
  const [order, setOrder] = useState<Order | null>(null);
  const [decryptedUpi, setDecryptedUpi] = useState<string | null>(null);
  const [phase, setPhase] = useState<UiPhase>("matching");
  const [secondsLeft, setSecondsLeft] = useState(AUTO_CANCEL_WINDOW_MS / 1000);
  // When the payment window closes (ms). From the chain's acceptedAt, so a
  // reload shows the true time left rather than restarting the clock. Set once,
  // as the widget sets its acceptedTimestamp once.
  const deadlineRef = useRef<number | null>(null);
  // Chain time minus this device's time, when the device clock is badly off
  // (deviceClockSkewMs); 0 on a correctly set phone.
  const clockSkewRef = useRef(0);
  useEffect(() => {
    deviceClockSkewMs().then((skew) => { clockSkewRef.current = skew; });
  }, []);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [warningMsg, setWarningMsg] = useState("");
  // Fee schedule, only read once an order has ended (see payerTotal6 below).
  const [feeCfg, setFeeCfg] = useState<PriceConfig | null>(null);
  const pollRef = useRef<any>(null);
  const tickRef = useRef<any>(null);
  // Mirrors decryptedUpi for the poll's tick() closure below — tick() is
  // created once per orderId and reused by setInterval for the whole polling
  // lifetime, so a plain read of decryptedUpi from that closure would always
  // see the value from the render that created it (always null), causing
  // decryptPayoutAddress to be re-invoked every poll instead of once.
  const decryptedUpiRef = useRef<string | null>(null);
  // The final outcome already reported to the caller, so polling on through an
  // open dispute does not report it again on every tick.
  const reportedRef = useRef<"cancelled" | "completed" | null>(null);
  // Whether this order is really on THIS link and placed with THIS browser's
  // key (verifyLinkOrder). Payment details are shown only once it is "ok".
  const [ownership, setOwnership] = useState<"checking" | "ok" | "mismatch">("checking");
  const ownershipRef = useRef<"checking" | "ok" | "mismatch">("checking");
  // The payment details could not be decrypted on this device.
  const [decryptFailed, setDecryptFailed] = useState(false);

  const currency = currencyFromBytes32(currencyBytes32) || "INR";

  // Ensure the customer's relay identity exists (pure, local, no wallet) so
  // decryptPayoutAddress has a key to decrypt with once the order accepts.
  useEffect(() => {
    getCustomerIdentity().catch(() => {});
  }, []);

  // Poll the order straight off the Diamond contract — no subgraph lag.
  useEffect(() => {
    if (!orderId) return;
    let alive = true;

    async function tick() {
      try {
        const o = await getCustomerOrder(orderId!);
        if (!alive) return;
        setOrder(o);

        // Finished — but a dispute open on it can still change the outcome, so
        // keep watching until it is resolved (the page says it will update).
        const settledForGood = o.disputeStatus !== "open";
        if (o.status === "cancelled") {
          setPhase("cancelled");
          if (reportedRef.current !== "cancelled") {
            reportedRef.current = "cancelled";
            onCancel?.(orderId!);
          }
          if (settledForGood && pollRef.current) clearInterval(pollRef.current);
          return;
        }
        if (o.status === "completed") {
          setPhase("completed");
          if (reportedRef.current !== "completed") {
            reportedRef.current = "completed";
            onComplete?.(orderId!);
          }
          if (settledForGood && pollRef.current) clearInterval(pollRef.current);
          return;
        }
        if (o.status === "paid") {
          setPhase("paying");
          return;
        }
        if (o.status === "accepted") {
          // Before the phase changes, so the countdown starts from the right
          // deadline. As the widget: the first read decides it, and if
          // acceptedAt still reads 0 then, it counts from now.
          if (deadlineRef.current === null) {
            const acceptedMs = o.acceptedAt > 0n ? Number(o.acceptedAt) * 1000 : Date.now() + clockSkewRef.current;
            deadlineRef.current = acceptedMs + AUTO_CANCEL_WINDOW_MS;
          }
          // Once the LOCAL countdown has already declared this expired, the
          // chain read is stale (or the order simply hasn't been closed out
          // server-side yet) — reverting to "accepted" here restarted the
          // countdown effect below, which immediately re-expired it, looping
          // expired -> accepted -> expired forever. "expired" is terminal from
          // the customer's point of view; only cancelled/completed (handled
          // above) should ever move past it.
          setPhase((p) => (p === "cancelled" || p === "completed" || p === "expired" ? p : "accepted"));
          // Before ANY payment details: is this order ours (review M1)? Checked
          // once; a read failure just waits for the next tick.
          if (ownershipRef.current !== "ok") {
            const v = await verifyLinkOrder(orderId!, linkId);
            if (!alive) return;
            if (v === "mismatch") {
              ownershipRef.current = "mismatch";
              setOwnership("mismatch");
              if (pollRef.current) clearInterval(pollRef.current);
              return;
            }
            if (v === "unknown") return;
            ownershipRef.current = "ok";
            setOwnership("ok");
          }
          if (o.encUpi && decryptedUpiRef.current === null) {
            decryptPayoutAddress(o.encUpi).then((upi) => {
              if (!alive) return;
              if (upi === null) {
                setDecryptFailed(true);
                return;
              }
              decryptedUpiRef.current = upi;
              setDecryptedUpi(upi);
            });
          }
          return;
        }
        // still "placed" — keep showing "Setting up your payment…"
      } catch {
        // transient read failure — keep polling, don't flip to an error state
        // on a single blip (mirrors the app's fail-open RPC discipline).
      }
    }

    tick();
    pollRef.current = setInterval(tick, POLL_MS);
    return () => { alive = false; if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // Countdown only while actively waiting for the customer to pay.
  // Recomputed from the deadline each second rather than decremented, so a
  // throttled background tab can't drift behind the real window.
  useEffect(() => {
    if (phase !== "accepted") return;
    const update = () => {
      if (deadlineRef.current === null) return;
      // The widget's CountdownRing: remaining ms, floored for display, expired
      // at exactly 0.
      const remaining = Math.max(0, deadlineRef.current - (Date.now() + clockSkewRef.current));
      if (remaining === 0) {
        clearInterval(tickRef.current);
        setSecondsLeft(0);
        setPhase("expired");
        if (orderId) onExpire?.(orderId);
        return;
      }
      setSecondsLeft(Math.floor(remaining / 1000));
    };
    update();
    tickRef.current = setInterval(update, 1000);
    return () => clearInterval(tickRef.current);
  }, [phase]);

  useEffect(() => {
    if (phase !== "expired" && phase !== "cancelled") return;
    let alive = true;
    fetchPriceConfig(currency).then((c) => { if (alive) setFeeCfg(c); }).catch(() => {});
    return () => { alive = false; };
  }, [phase, currency]);

  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  function copy(label: string, value: string) {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(label);
  }

  async function handleMarkPaid() {
    if (!orderId || busy) return;
    setBusy(true);
    setErrorMsg("");
    try {
      const human = await getHumanSolution?.();
      const res = await markOrderPaid({ orderId, linkId, chainId: ACTIVE_CHAIN.id, human });
      if (res.warning) setWarningMsg(res.warning);
      setPhase("paying");
    } catch (e: any) {
      // Sent, but the relayer stopped waiting for the outcome. Not a failure:
      // a retry would only collide with the first. Show "verifying" and let
      // the order's own status (polled above) decide.
      if (isStillConfirming(e)) {
        setPhase("paying");
        return;
      }
      const m = e?.message || t("pl.errMarkPaid");
      setErrorMsg(m);
      onError?.(m);
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!orderId || busy) return;
    setBusy(true);
    setConfirmCancel(false);
    setErrorMsg("");
    try {
      const human = await getHumanSolution?.();
      await cancelCustomerOrder({ orderId, linkId, chainId: ACTIVE_CHAIN.id, human });
      setPhase("cancelled");
      onCancel?.(orderId);
    } catch (e: any) {
      const m = e?.message || t("pl.errCancel");
      setErrorMsg(m);
      onError?.(m);
    } finally {
      setBusy(false);
    }
  }

  const fiat6 = order?.actualFiatAmount && order.actualFiatAmount > 0n ? order.actualFiatAmount : order?.fiatAmount ?? 0n;
  const fiatDisplay = fmtAmount(fiat6, currency);

  // FALLBACK for the cancelled/expired screens, used only when the amount the
  // payer was quoted wasn't recorded (see quotedFiat). The order's fiatAmount is
  // the USDC leg at the buy price; the small-order fee is added on top of it
  // (lib/pricing.ts: total = (usdc + fee) × price). Uses the fee the order
  // recorded, else the on-chain schedule; never the settled amount, which is the
  // merchant's side. Not guaranteed to equal the quote (e.g. a partial fill).
  const payerTotal6 = (() => {
    const fiat = order?.fiatAmount ?? 0n;
    const usdc = order?.usdcAmount ?? 0n;
    if (fiat <= 0n) return 0n;
    if (usdc <= 0n) return fiat;
    const recorded = order?.fixedFeePaid ?? 0n;
    const fee = recorded > 0n ? recorded : feeCfg && usdc <= feeCfg.smallOrderThreshold ? feeCfg.smallOrderFixedFee : 0n;
    return fiat + (fee * fiat) / usdc;
  })();
  // Paise included, as p2p.me's widget writes it (`am=${fiatDisplay}`, two
  // decimals). This was rounded to whole rupees, so a ₹99.99 order put ₹100 in
  // the UPI QR — the customer paid a different amount from the one owed.
  const fiatUpi = (Number(fiat6) / 1e6).toFixed(2);

  const qrValue =
    currency === "INR" && decryptedUpi
      ? upiUri({ upiId: decryptedUpi, merchantName, amountInr: fiatUpi, orderId: orderId || "" })
      : decryptedUpi || "";
  // Brazil: a real Pix BR Code with the amount and order id in it (review M2) —
  // null when the key can't be made into one, and the key is shown to copy.
  const pixCode =
    currency === "BRL" && decryptedUpi
      ? pixPayload(decryptedUpi, { amount: Number(fiat6) / 1e6, orderId: orderId || undefined, merchantName })
      : null;
  // A dispute is open on this order: support is reviewing it.
  const underReview = order?.disputeStatus === "open";

  const railQr = sellerQrFor(currency, decryptedUpi);
  const compoundRows = compoundRowsFor(currency, decryptedUpi);
  // A payout id that IS just the QR has no typed part worth showing as a row.
  const singlePayout = (() => {
    if (!decryptedUpi || compoundRows) return null;
    if (!railQr) return decryptedUpi;
    if (decryptedUpi.trim() === railQr) return null;
    try { return unpackPackedPaymentId(decryptedUpi.trim()).rest.trim() || null; } catch { return decryptedUpi; }
  })();

  // The widget's `remaining < 60_000`.
  const urgent = phase === "accepted" && secondsLeft < 60;

  return (
    <div className="pc-content">
      <div className="pc-card">
        {/* Not while setting up or verifying: those screens are just a spinner
            and a message, with no shop name or amount above them. */}
        {phase !== "matching" && phase !== "paying" && (
          <div className="pc-head">
            <div className="pc-head-merchant">{merchantName}</div>
            <div className="pc-head-right">
              <div className="pc-head-amount">{fiatDisplay}</div>
              {description && <div className="pc-head-desc">{description}</div>}
            </div>
          </div>
        )}
        {phase === "accepted" && <StatusStrip secondsLeft={secondsLeft} urgent={urgent} />}

        {phase === "matching" && (
          <div className="pc-matching">
            <span className="pc-spinner" aria-hidden="true" />
            <div className="pc-matching-h">{t("pl.settingUp")}</div>
            <div className="pc-matching-sub">{t("pl.fewSeconds")}</div>
          </div>
        )}

        {ownership === "mismatch" && (
          <div className="pc-expired">
            <div className="pc-expired-h">{t("pl.dontPay")}</div>
            <div className="pc-expired-sub">
              {t("pl.mismatchSub")}
            </div>
            <a
              className="pc-expired-sub"
              href={supportHref(orderId || "")}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("pl.contactSupport")}
            </a>
          </div>
        )}

        {phase === "accepted" && ownership !== "mismatch" && (
          <>
            {decryptFailed ? (
              <div className="pc-expired">
                <div className="pc-expired-h">{t("pl.detailsUnavailable")}</div>
                <div className="pc-expired-sub">
                  {t("pl.detailsUnavailableSub")}
                </div>
                <a
                  className="pc-expired-sub"
                  href={supportHref(orderId || "")}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t("pl.contactSupport")}
                </a>
              </div>
            ) : !decryptedUpi || ownership !== "ok" ? (
              <div className="pc-matching">
                <span className="pc-spinner" aria-hidden="true" />
                <div className="pc-matching-sub">{t("pl.gettingDetails")}</div>
              </div>
            ) : (
              <>
                {currency === "INR" ? (
                  <IndiaPayMethods qrValue={qrValue} />
                ) : currency === "BRL" ? (
                  <BrazilPayMethod pixCode={pixCode} copied={copied} onCopy={copy} />
                ) : railQr ? (
                  <RailQrCard qrValue={railQr} />
                ) : (
                  <OtherRailNote currency={currency} />
                )}

                <div className="pc-details">
                  <div className="pc-details-h">{t("pl.paymentDetails")}</div>
                  {compoundRows?.map((r) => (
                    <DetailRow
                      key={r.key}
                      label={r.label}
                      value={r.value}
                      onCopy={() => copy(r.key, r.value)}
                      copied={copied === r.key}
                      mono
                    />
                  ))}
                  {singlePayout && (
                    <DetailRow
                      // The rail's own name for this field — "UPI ID", "PIX key",
                      // "CBU / alias" — from the country registry rather than two
                      // hardcoded cases, so a currency added there is labelled
                      // correctly here with no change to this file. Anything
                      // unlisted degrades to a plain "Payment address".
                      label={countryForCurrency(currency).payoutLabel}
                      value={singlePayout}
                      onCopy={() => copy("payout", singlePayout)}
                      copied={copied === "payout"}
                      mono
                    />
                  )}
                  <DetailRow label={t("pl.amount")} value={fiatDisplay} />
                </div>

                {errorMsg && <p className="pc-error">{errorMsg}</p>}

                <div className="pc-paid-note" role="note">
                  <div className="pc-paid-note-h">{t("pl.paidNoteH")}</div>
                  <div className="pc-paid-note-sub">{t("pl.paidNoteSub")}</div>
                </div>

                <button className="pc-paid-btn" onClick={handleMarkPaid} disabled={busy}>
                  {busy ? t("pl.confirming") : t("pl.ivePaid")}
                </button>

                <button className="pc-cancel-btn" onClick={() => setConfirmCancel(true)} disabled={busy}>
                  {t("pl.cancel")}
                </button>
              </>
            )}
          </>
        )}

        {phase === "paying" && (
          <div className="pc-matching">
            <span className="pc-spinner" aria-hidden="true" />
            <div className="pc-matching-h">{t("pl.verifying")}</div>
            <div className="pc-matching-sub">{t("pl.verifyingSub")}</div>
            {warningMsg && <p className="pc-error">{warningMsg}</p>}
          </div>
        )}

        {phase === "completed" && (
          <ReceiptPanel
            amount={fiatDisplay}
            merchantName={merchantName}
            currency={currency}
            orderId={orderId || ""}
            usdc6={order?.actualUsdcAmount && order.actualUsdcAmount > 0n ? order.actualUsdcAmount : order?.usdcAmount ?? 0n}
            feeUsdc6={order?.fixedFeePaid ?? 0n}
            whenSecs={Number(order?.completedAt || order?.paidAt || order?.placedAt || 0n)}
            payoutHandle={decryptedUpi}
            onNewPayment={onNewPayment}
            underReview={underReview}
          />
        )}

        {(phase === "expired" || phase === "cancelled") && (
          <EndedReceipt
            expired={phase === "expired"}
            details={{
              // What the payer was quoted ("Pay ₹10.02"), which already covers any
              // fee — not the settled amount. Falls back to the chain figure plus
              // fee only when the quote wasn't recorded.
              amount: quotedFiat && quotedFiat > 0
                ? fmtPayerFiat(countryForCurrency(currency), quotedFiat)
                : payerTotal6 > 0n ? fmtAmount(payerTotal6, currency) : fiatDisplay,
              merchantName,
              currency,
              orderId: orderId || "",
              linkId,
              whenSecs: Number(order?.placedAt || 0n),
              status: phase === "expired" ? "Payment window ended" : "Cancelled",
            }}
            onPaid={handleMarkPaid}
            onCancel={handleCancel}
            busy={busy}
            onNewPayment={onNewPayment}
            underReview={underReview}
          />
        )}

        {/* Under review by support (a dispute is open on this order) while the
            payment is still being verified. The finished screens below are
            full-screen and show the same notice inside their own card. */}
        {underReview && phase === "paying" && (
          <div className="pc-expired-sub" style={{ marginTop: 12 }}>
            {t("pl.reviewNote")}{" "}
            <a href={supportHref(orderId || "")} target="_blank" rel="noopener noreferrer">
              {t("pl.contactSupport")}
            </a>
          </div>
        )}

        {/* Errors outside the "accepted" panel (which shows its own): a cancel
            refused on the expired screen — busy, rate-limited, network — used
            to look like nothing happened at all. */}
        {errorMsg && phase !== "accepted" && <p className="pc-error">{errorMsg}</p>}

        {confirmCancel && (
          <div className="pc-confirm-overlay" role="dialog" aria-modal="true">
            <div className="pc-confirm-card">
              <div className="pc-confirm-h">{t("pl.cancelQ")}</div>
              <div className="pc-confirm-sub">{t("pl.cancelQSub")}</div>
              <div className="pc-confirm-actions">
                <button className="pc-confirm-keep" onClick={() => setConfirmCancel(false)}>{t("pl.keepOrder")}</button>
                <button className="pc-confirm-yes" onClick={handleCancel} disabled={busy}>{t("pl.yesCancel")}</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        .pc-content {
          --pq-blue: #1d5be0;
          --pq-blue-dark: #1646b8;
          --pq-blue-soft: #eef4ff;
          --pq-ink: #0f1b3d;
          --pq-muted: #5b6b8c;
          --pq-faint: #8a97b3;
          --pq-line: #e1e8f5;
          --pq-success: #0f9d6f;
          --pq-warn: #b45f06;
          --pq-warn-soft: #fff4e5;
          --pq-danger: #d92d20;
          --pq-danger-soft: #fdecea;
          position: relative;
          width: 100%; max-width: 440px;
          padding: 28px 20px calc(28px + env(safe-area-inset-bottom));
          margin: 0 auto; box-sizing: border-box;
          color: var(--pq-ink);
        }
        @media (min-width: 640px) { .pc-content { padding-top: 56px; } }

        .pc-card { display: flex; flex-direction: column; }

        /* Header: shop on the left, amount (and what it is for) on the right. */
        .pc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
        .pc-head-merchant { font-size: 15px; font-weight: 700; letter-spacing: -0.01em; color: var(--pq-ink); min-width: 0; overflow-wrap: anywhere; padding-top: 4px; }
        .pc-head-right { text-align: right; flex: none; max-width: 60%; }
        .pc-head-amount { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; line-height: 1.1; color: var(--pq-ink); font-variant-numeric: tabular-nums; }
        .pc-head-desc { margin-top: 3px; font-size: 13px; font-weight: 500; color: var(--pq-muted); overflow-wrap: anywhere; }

        .pc-status { display: flex; align-items: center; gap: 8px; margin: 14px 0 0; padding: 9px 12px; background: var(--pq-blue-soft); border-radius: 10px; }
        .pc-status.urgent { background: var(--pq-warn-soft); }
        .pc-status-text { font-size: 12.5px; font-weight: 600; color: var(--pq-blue-dark); }
        .pc-status.urgent .pc-status-text { color: var(--pq-warn); }
        .pc-status-timer { font-variant-numeric: tabular-nums; font-weight: 700; }
        .pc-pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--pq-blue); flex: none; animation: pcPulse 1.3s ease-in-out infinite; }
        .pc-status.urgent .pc-pulse { background: var(--pq-warn); }
        @keyframes pcPulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .pc-pulse { animation: none; opacity: .8; } }

        .pc-matching { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 56px 16px; }
        .pc-matching-h { font-size: 17px; font-weight: 700; color: var(--pq-ink); }
        .pc-matching-sub { font-size: 13.5px; color: var(--pq-muted); }
        .pc-spinner {
          width: 28px; height: 28px; border-radius: 50%;
          border: 3px solid var(--pq-line); border-top-color: var(--pq-blue);
          animation: pcSpin .8s linear infinite;
        }
        @keyframes pcSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .pc-spinner { animation-duration: 1.6s; } }

        /* QR: centred, a plain white tile — no card behind it. */
        .pc-qr-card { margin: 28px 0 8px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
        .pc-qr-label { display: none; }
        .pc-qr-box { padding: 14px; background: #fff; border: 1px solid var(--pq-line); border-radius: 14px; line-height: 0; }
        .pc-qr-hint { font-size: 12.5px; color: var(--pq-muted); text-align: center; max-width: 30ch; }

        .pc-apps { margin: 14px 0 0; }
        .pc-apps-h { font-size: 12.5px; font-weight: 600; color: var(--pq-muted); margin-bottom: 8px; text-align: center; }
        .pc-copy-code-btn {
          width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
          border: 1px solid #0b2a6f; background: #0b2a6f; color: #fff; border-radius: 14px; padding: 14px 10px;
          font-family: inherit; font-size: 15px; font-weight: 700; cursor: pointer; transition: background .12s ease;
        }
        .pc-copy-code-btn:hover { background: #081f55; }
        .pc-copy-code-btn.copied { background: var(--pq-success); border-color: var(--pq-success); color: #fff; }

        .pc-bank-card { margin: 28px 0 8px; text-align: center; }
        .pc-bank-h { font-size: 15px; font-weight: 700; color: var(--pq-ink); margin-bottom: 4px; }
        .pc-bank-sub { font-size: 13.5px; color: var(--pq-muted); line-height: 1.5; }

        /* Payment details: hairlines, no box. */
        .pc-details { margin: 20px 0 0; border-top: 1px solid var(--pq-line); }
        .pc-details-h { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pq-faint); padding: 14px 0 2px; }
        .pc-drow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0; border-top: 1px solid var(--pq-line); }
        .pc-drow:first-of-type { border-top: none; }
        .pc-drow-k { font-size: 13px; color: var(--pq-muted); font-weight: 500; flex: none; }
        .pc-drow-v { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .pc-drow-val { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pq-ink); }
        .pc-drow-val.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
        .pc-copy-btn { flex: none; border: none; background: var(--pq-blue-soft); color: var(--pq-blue); width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .12s ease; }
        .pc-copy-btn:hover { background: var(--pq-blue); color: #fff; }
        .pc-copy-btn.copied { background: var(--pq-success); color: #fff; }

        .pc-error { color: var(--pq-danger); font-size: 13.5px; text-align: center; margin: 14px 0 0; }

        /* The "press I Paid only after paying" notice. Noticeable, not alarming. */
        .pc-paid-note { margin: 22px 0 14px; padding: 12px 14px; border-radius: 10px; background: var(--pq-blue-soft); border-left: 3px solid var(--pq-blue); }
        .pc-paid-note-h { font-size: 14px; font-weight: 700; color: var(--pq-ink); line-height: 1.4; }
        .pc-paid-note-sub { margin-top: 4px; font-size: 12.5px; color: var(--pq-muted); line-height: 1.5; }

        .pc-paid-btn {
          width: 100%; border: none; cursor: pointer;
          background: #0b2a6f; color: #fff;
          font-family: inherit; font-size: 17px; font-weight: 700; letter-spacing: 0.01em;
          padding: 17px 20px; border-radius: 16px;
          box-shadow: 0 8px 20px -8px rgba(11,42,111,0.6);
          transition: background .12s ease, transform .08s ease, opacity .12s ease;
        }
        .pc-paid-btn:hover:not(:disabled) { background: #081f55; }
        .pc-paid-btn:active:not(:disabled) { transform: translateY(1px); }
        .pc-paid-btn:disabled { opacity: 0.55; cursor: default; }
        .pc-paid-btn:focus-visible, .pc-cancel-btn:focus-visible { outline: 3px solid rgba(29,91,224,0.35); outline-offset: 2px; }

        /* Cancel is a quiet text action so it never competes with I Paid. */
        .pc-cancel-btn {
          display: block; margin: 8px auto 0; padding: 12px 20px; cursor: pointer;
          background: none; border: none; color: var(--pq-muted);
          font-family: inherit; font-size: 14px; font-weight: 600; border-radius: 8px;
        }
        .pc-cancel-btn:hover:not(:disabled) { color: var(--pq-danger); }
        .pc-cancel-btn:disabled { opacity: 0.5; cursor: default; }

        .pc-confirm-overlay {
          position: fixed; inset: 0; z-index: 50;
          background: rgba(15,27,61,0.45);
          display: flex; align-items: flex-end; justify-content: center;
          padding: 20px; animation: pcFadeIn .18s ease;
        }
        @media (min-width: 640px) { .pc-confirm-overlay { align-items: center; } }
        @keyframes pcFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .pc-confirm-card { width: 100%; max-width: 380px; background: #fff; border-radius: 16px; padding: 22px 20px; box-shadow: 0 20px 50px -20px rgba(15,27,61,0.4); }
        @media (prefers-reduced-motion: reduce) { .pc-confirm-overlay { animation: none; } }
        .pc-confirm-h { font-size: 17px; font-weight: 700; color: var(--pq-ink); }
        .pc-confirm-sub { font-size: 13.5px; color: var(--pq-muted); margin-top: 6px; line-height: 1.5; }
        .pc-confirm-actions { display: flex; gap: 10px; margin-top: 18px; }
        .pc-confirm-keep, .pc-confirm-yes { flex: 1; border: none; cursor: pointer; font-family: inherit; font-size: 15px; font-weight: 700; padding: 14px; border-radius: 14px; }
        .pc-confirm-keep { background: #0b2a6f; color: #fff; }
        .pc-confirm-keep:hover { background: #081f55; }
        .pc-confirm-yes { background: #fff; color: var(--pq-danger); border: 1px solid var(--pq-line); }
        .pc-confirm-yes:hover:not(:disabled) { background: var(--pq-danger-soft); }
        .pc-confirm-yes:disabled { opacity: 0.6; cursor: default; }

        .pc-expired { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 40px 8px; gap: 8px; }
        .pc-expired-h { font-size: 19px; font-weight: 700; color: var(--pq-ink); }
        .pc-expired-sub { font-size: 13.5px; color: var(--pq-muted); max-width: 32ch; line-height: 1.5; }
        .pc-expired-sub a { color: var(--pq-blue); font-weight: 600; }

        /* Finished / ended receipts (full screen, light, using the app's receipt card). */
        .pc-rcpt-full { position: fixed; inset: 0; z-index: 60; overflow-y: auto; background: #fbfcff; }
        .pc-rcpt-share { width: 100%; margin-top: 16px; border-radius: 16px; font-weight: 700; }
        .pc-rcpt-share:not(.ghost), .pc-help-btn { background: #0b2a6f; color: #fff; border-color: #0b2a6f; }
        .pc-rcpt-share:not(.ghost):hover:not(:disabled), .pc-help-btn:hover { background: #081f55; }
        .pc-help-btn { border-radius: 16px; font-weight: 700; }
        .pc-rcpt-full .rcpt-help { margin: 12px 0 0; }
        .pc-review-note { margin-top: 12px; padding: 10px 12px; border-radius: 10px; text-align: center; background: var(--pq-warn-soft); color: var(--pq-warn); font-size: 13px; line-height: 1.45; }
        .pc-help-box { margin-top: 18px; padding: 14px; border-radius: 12px; background: var(--pq-blue-soft); text-align: center; }
        .pc-help-h { font-size: 14px; font-weight: 700; color: var(--pq-ink); }
        .pc-help-sub { font-size: 12px; color: var(--pq-muted); margin: 4px 0 12px; line-height: 1.45; }
        .pc-help-btn { display: block; width: 100%; text-align: center; text-decoration: none; box-sizing: border-box; }
      `}</style>
    </div>
  );
}

function IndiaPayMethods({ qrValue }: { qrValue: string }) {
  const { t } = usePayerT();
  return (
    <>
      <div className="pc-qr-card">
        <div className="pc-qr-label">{t("pl.scanToPay")}</div>
        <div className="pc-qr-box">
          <QRCodeSVG value={qrValue} size={196} {...PAYMENT_LINK_QR_STYLE} />
        </div>
        <div className="pc-qr-hint">{t("pl.scanHintApp")}</div>
      </div>
    </>
  );
}

function BrazilPayMethod({
  pixCode,
  copied,
  onCopy,
}: {
  /** A payable BR Code, or null when the key couldn't be made into one. */
  pixCode: string | null;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  const { t } = usePayerT();
  // No payable code: send the customer to the Pix key below, named as a key —
  // never a raw key passed off as "Pix Copia e Cola".
  if (!pixCode) {
    return (
      <div className="pc-bank-card">
        <div className="pc-bank-h">{t("pl.payPix")}</div>
        <div className="pc-bank-sub">{t("pl.pixSub")}</div>
      </div>
    );
  }
  return (
    <>
      <div className="pc-qr-card">
        <div className="pc-qr-label">{t("pl.scanToPay")}</div>
        <div className="pc-qr-box">
          <QRCodeSVG value={pixCode} size={196} {...PAYMENT_LINK_QR_STYLE} />
        </div>
        <div className="pc-qr-hint">{t("pl.pixScanHint")}</div>
      </div>
      <div className="pc-apps">
        <div className="pc-apps-h">{t("pl.pixCopia")}</div>
        <button
          className={`pc-copy-code-btn${copied === "pix-code" ? " copied" : ""}`}
          onClick={() => onCopy("pix-code", pixCode)}
        >
          {copied === "pix-code" ? <CheckIcon /> : <CopyIcon />}
          {copied === "pix-code" ? t("pl.codeCopied") : t("pl.copyPix")}
        </button>
      </div>
    </>
  );
}

// A QR the seller stored for this rail (e.g. Venezuela's Pago Móvil bank QR),
// scanned from the payer's own banking app.
function RailQrCard({ qrValue }: { qrValue: string }) {
  const { t } = usePayerT();
  return (
    <div className="pc-qr-card">
      <div className="pc-qr-label">{t("pl.scanToPay")}</div>
      <div className="pc-qr-box">
        <QRCodeSVG value={qrValue} size={196} {...PAYMENT_LINK_QR_STYLE} />
      </div>
      <div className="pc-qr-hint">{t("pl.scanHintBank")}</div>
    </div>
  );
}

function OtherRailNote({ currency }: { currency: string }) {
  const { t } = usePayerT();
  return (
    <div className="pc-bank-card">
      <div className="pc-bank-h">{t("pl.bankTransfer")}</div>
      <div className="pc-bank-sub">{t("pl.bankTransferSub", { currency })}</div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  onCopy,
  copied,
  mono,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  copied?: boolean;
  mono?: boolean;
}) {
  const { t } = usePayerT();
  return (
    <div className="pc-drow">
      <div className="pc-drow-k">{label}</div>
      <div className="pc-drow-v">
        <span className={`pc-drow-val${mono ? " mono" : ""}`}>{value}</span>
        {onCopy && (
          <button className={`pc-copy-btn${copied ? " copied" : ""}`} onClick={onCopy} aria-label={t("pl.copy", { label })}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusStrip({ secondsLeft, urgent }: { secondsLeft: number; urgent: boolean }) {
  const { t } = usePayerT();
  return (
    <div className={`pc-status${urgent ? " urgent" : ""}`}>
      <span className="pc-pulse" />
      <span className="pc-status-text">
        {t("pl.waiting")} · <span className="pc-status-timer">{fmtTimer(secondsLeft)}</span>
      </span>
    </div>
  );
}

// The PayQR receipt (the same card the customer receipt uses at
// /receipt/[orderId]) told from the PAYER's side: what you paid, to whom, and
// how. Built from the order the widget already polls, so it needs no token, no
// subgraph and no login, and it survives a reload the same way.
function maskHandle(h: string): string {
  if (!h) return "";
  if (h.length <= 4) return h;
  const at = h.indexOf("@");
  return `${h.slice(0, 2)}•••${h.slice(at > 0 ? at : h.length - 2)}`;
}

function ReceiptPanel({
  amount, merchantName, currency, orderId, usdc6, feeUsdc6, whenSecs, payoutHandle, onNewPayment, underReview,
}: {
  amount: string; merchantName: string; currency: string; orderId: string;
  usdc6: bigint; feeUsdc6: bigint; whenSecs: number; payoutHandle: string | null;
  onNewPayment?: () => void;
  /** A dispute is open on this order. */
  underReview?: boolean;
}) {
  const { t, lang } = usePayerT();
  const country = countryForCurrency(currency);
  const captureRef = useRef<HTMLDivElement>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const when = whenSecs
    ? new Date(whenSecs * 1000).toLocaleString(PAYER_DATE_LOCALE[lang], {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  const handle = payoutHandle ? maskHandle(payoutHandle) : "";
  const usdc = (n: bigint) => (Number(n) / 1e6).toFixed(2);

  async function shareAsImage() {
    if (!captureRef.current || imgBusy) return;
    setImgBusy(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: "#ffffff",
        scale: Math.min(window.devicePixelRatio || 2, 3),
      });
      const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/png"));
      if (!blob) return;
      const file = new File([blob], `payqr-receipt-${orderId}.png`, { type: "image/png" });
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
      // best-effort: the on-screen receipt is still there
    } finally {
      setImgBusy(false);
    }
  }

  return (
    <div className="pc-rcpt-full">
      <div className="rcpt-screen">
        <div className="rcpt-card" ref={captureRef}>
          <div className="brand rcpt-brand"><Logo size={24} className="brand-mark" /> PayQR</div>
          <div className="rcpt-tick ok"><CheckIconLg /></div>
          <div className="rcpt-status">{t("pl.rcptSuccess")}</div>
          <div className="rcpt-shop">{t("pl.paidToShop", { name: merchantName })}</div>
          <div className="rcpt-amount">{amount}</div>
          <div className="rcpt-amount-sub">{t("pl.youPaid")}</div>
          {underReview && <div className="pc-review-note">{t("pl.reviewNote")}</div>}

          <div className="rcpt-rows">
            <div className="rcpt-row"><span>{t("pl.paidTo")}</span><b>{merchantName}</b></div>
            {handle && (
              <div className="rcpt-row"><span>{country.payoutLabel}</span><b className="mono">{handle}</b></div>
            )}
            <div className="rcpt-row"><span>{t("pl.via")}</span><b>{country.flag} {country.name} · {country.code}</b></div>
            {/* No USDC rows: the payer paid in their own currency (the amount
                above), and settlement detail is the merchant's, not theirs. */}
            {when && <div className="rcpt-row"><span>{t("pl.when")}</span><b>{when}</b></div>}
            <div className="rcpt-row"><span>{t("pl.receiptNo")}</span><b>#{orderId}</b></div>
            <div className="rcpt-row"><span>{t("pl.status")}</span>{underReview ? <b className="w">{t("pl.underReview")}</b> : <b className="g">{t("pl.completed")}</b>}</div>
          </div>
          <p className="rcpt-foot">{t("pl.saveReceipt")}</p>

          {/* Inside the card, but left out of the saved image. */}
          <button className="btn ghost pc-rcpt-share" data-html2canvas-ignore="true" onClick={shareAsImage} disabled={imgBusy}>
            {imgBusy ? t("pl.preparingImage") : t("pl.shareImage")}
          </button>
          {onNewPayment && (
            <button className="btn pc-rcpt-share" data-html2canvas-ignore="true" onClick={onNewPayment}>
              {t("pl.newPayment")}
            </button>
          )}
          <a
            className="rcpt-help"
            data-html2canvas-ignore="true"
            href={`https://t.me/PayQRdotPRO?text=${encodeURIComponent(`Hi, I need help with payment #${orderId}.`)}`}
            target="_blank" rel="noopener noreferrer"
          >
            {t("pl.reportIssue")}
          </a>
        </div>
      </div>
    </div>
  );
}

type EndedDetails = {
  amount: string; merchantName: string; currency: string; orderId: string;
  linkId: string; whenSecs: number; status: "Cancelled" | "Payment window ended";
};

// The support chat opens with everything the team needs to find this order, so
// the customer doesn't have to type it out: order, amount, shop, rail, status
// and the payment link it came from.
function supportMessage(d: EndedDetails): { href: string; text: string } {
  const when = d.whenSecs ? new Date(d.whenSecs * 1000).toLocaleString() : "";
  const details = [
    `Amount: ${d.amount}`,
    `Paid to: ${d.merchantName}`,
    `Currency: ${d.currency}`,
    `Order status: ${d.status}`,
    ...(when ? [`Placed: ${when}`] : []),
    `Payment link: ${d.linkId}`,
  ];
  const text = `Hi, I need help with my payment #${d.orderId}.\n\n${details.join("\n")}`;
  return { href: `https://t.me/PayQRdotPRO/1819?text=${encodeURIComponent(text)}`, text };
}

// Full-screen receipt for an order that did not complete — the customer-side
// twin of the merchant's cancelled receipt at /receipt/[orderId], with the same
// card as the success receipt and no beach scene behind it.
function EndedReceipt({
  details, expired, onPaid, onCancel, busy, onNewPayment, underReview,
}: {
  details: EndedDetails; expired: boolean; busy: boolean;
  onPaid?: () => void; onCancel?: () => void; onNewPayment?: () => void;
  /** A dispute is open on this order: the outcome may still change. */
  underReview?: boolean;
}) {
  const { t, lang } = usePayerT();
  const country = countryForCurrency(details.currency);
  const support = supportMessage(details);
  const when = details.whenSecs
    ? new Date(details.whenSecs * 1000).toLocaleString(PAYER_DATE_LOCALE[lang], {
        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "";
  return (
    <div className="pc-rcpt-full">
      <div className="rcpt-screen">
        <div className="rcpt-card">
          <div className="brand rcpt-brand"><Logo size={24} className="brand-mark" /> PayQR</div>
          <div className={`rcpt-tick ${expired ? "wait" : "bad"}`}>{expired ? <ClockIcon /> : <XIcon />}</div>
          <div className="rcpt-status">{expired ? t("pl.windowEnded") : t("pl.payCancelled")}</div>
          <div className="rcpt-shop">{t("pl.paidToShop", { name: details.merchantName })}</div>
          <div className="rcpt-amount">{details.amount}</div>
          <div className="rcpt-amount-sub">
            {underReview
              ? t("pl.noPayAgain")
              : expired
                // We can't know whether the customer paid after the window closed,
                // so this never claims that no money moved.
                ? t("pl.ifAlreadyPaid")
                : t("pl.didNotGoThrough")}
          </div>
          {underReview && <div className="pc-review-note">{t("pl.reviewNote")}</div>}

          <div className="rcpt-rows">
            <div className="rcpt-row"><span>{t("pl.paidTo")}</span><b>{details.merchantName}</b></div>
            <div className="rcpt-row"><span>{t("pl.via")}</span><b>{country.flag} {country.name} · {country.code}</b></div>
            {when && <div className="rcpt-row"><span>{t("pl.when")}</span><b>{when}</b></div>}
            <div className="rcpt-row"><span>{t("pl.receiptNo")}</span><b>#{details.orderId}</b></div>
            <div className="rcpt-row"><span>{t("pl.status")}</span>{underReview ? <b className="w">{t("pl.underReview")}</b> : <b className={expired ? "w" : "r"}>{details.status === "Cancelled" ? t("pl.cancelledStatus") : t("pl.windowEnded")}</b>}</div>
          </div>

          <div className="pc-help-box" data-html2canvas-ignore="true">
            <div className="pc-help-h">{t("pl.needHelp")}</div>
            <div className="pc-help-sub">
              {t("pl.helpSub")}
            </div>
            {/* The link carries the message as ?text=, but Telegram doesn't always
                honour that on a group/thread link, so the details are also copied
                to the clipboard on tap, ready to paste into the chat. */}
            <a
              className="btn pc-help-btn"
              href={support.href}
              target="_blank" rel="noopener noreferrer"
              onClick={() => { navigator.clipboard?.writeText(support.text).catch(() => {}); }}
            >
              {t("pl.getHelp")}
            </a>
          </div>

          {expired && onPaid && (
            <button className="btn pc-rcpt-share" data-html2canvas-ignore="true" onClick={onPaid} disabled={busy}>
              {busy ? t("pl.working") : t("pl.alreadyPaid")}
            </button>
          )}
          {expired && onCancel && (
            <button className="btn ghost pc-rcpt-share" data-html2canvas-ignore="true" onClick={onCancel} disabled={busy}>
              {t("pl.cancelOrder")}
            </button>
          )}
          {!expired && onNewPayment && (
            <button className="btn ghost pc-rcpt-share" data-html2canvas-ignore="true" onClick={onNewPayment}>
              {t("pl.newPayment")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function CheckIconLg() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
