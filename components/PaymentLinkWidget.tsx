"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Order } from "@p2pdotme/sdk/orders";
import { getCustomerIdentity } from "../lib/customerRelayIdentity";
import { getCustomerOrder, decryptPayoutAddress, markOrderPaid, cancelCustomerOrder, isStillConfirming } from "../lib/customerOrder";
import { currencyFromBytes32 } from "../lib/contract";
import { countryForCurrency, fmtFiat } from "../lib/countries";
import { ACTIVE_CHAIN } from "../lib/chain";
import { PAYMENT_LINK_QR_STYLE } from "./PaymentLinkQR";
import { Logo } from "./Icons";
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
  currencyBytes32: Hex;
  onOrderId?: (orderId: string) => void;
  onComplete?: (orderId: string) => void;
  onCancel?: (orderId?: string) => void;
  /** The payment window ran out: the order is over from the customer's side. */
  onExpire?: (orderId: string) => void;
  onError?: (msg: string) => void;
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
  return fmtFiat(countryForCurrency(currencyCode), Number(usdc6) / 1e6);
}

function upiUri(params: { upiId: string; merchantName: string; amountInr: string; orderId: string }) {
  const q = new URLSearchParams({
    pa: params.upiId,
    pn: params.merchantName,
    am: String(params.amountInr),
    cu: "INR",
    tr: params.orderId,
  });
  return `upi://pay?${q.toString()}`;
}

export function PaymentLinkWidget({
  linkId,
  merchantName = "the merchant",
  currencyBytes32,
  orderId,
  onOrderId,
  onComplete,
  onCancel,
  onExpire,
  onError,
  getHumanSolution,
}: PaymentLinkWidgetProps) {
  const [order, setOrder] = useState<Order | null>(null);
  const [decryptedUpi, setDecryptedUpi] = useState<string | null>(null);
  const [phase, setPhase] = useState<UiPhase>("matching");
  const [secondsLeft, setSecondsLeft] = useState(AUTO_CANCEL_WINDOW_MS / 1000);
  // When the payment window closes (ms). From the chain's acceptedAt, so a
  // reload shows the true time left rather than restarting the clock. Set once,
  // as the widget sets its acceptedTimestamp once.
  const deadlineRef = useRef<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [warningMsg, setWarningMsg] = useState("");
  const pollRef = useRef<any>(null);
  const tickRef = useRef<any>(null);
  // Mirrors decryptedUpi for the poll's tick() closure below — tick() is
  // created once per orderId and reused by setInterval for the whole polling
  // lifetime, so a plain read of decryptedUpi from that closure would always
  // see the value from the render that created it (always null), causing
  // decryptPayoutAddress to be re-invoked every poll instead of once.
  const decryptedUpiRef = useRef<string | null>(null);

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

        if (o.status === "cancelled") {
          setPhase("cancelled");
          onCancel?.(orderId!);
          if (pollRef.current) clearInterval(pollRef.current);
          return;
        }
        if (o.status === "completed") {
          setPhase("completed");
          onComplete?.(orderId!);
          if (pollRef.current) clearInterval(pollRef.current);
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
            const acceptedMs = o.acceptedAt > 0n ? Number(o.acceptedAt) * 1000 : Date.now();
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
          if (o.encUpi && decryptedUpiRef.current === null) {
            decryptPayoutAddress(o.encUpi).then((upi) => {
              if (!alive) return;
              decryptedUpiRef.current = upi;
              setDecryptedUpi(upi);
            });
          }
          return;
        }
        // still "placed" — keep showing "Finding a payment provider…"
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
      const remaining = Math.max(0, deadlineRef.current - Date.now());
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
      const m = e?.message || "Couldn't confirm this payment. Please try again.";
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
      const m = e?.message || "Couldn't cancel this order. Please try again.";
      setErrorMsg(m);
      onError?.(m);
    } finally {
      setBusy(false);
    }
  }

  const fiat6 = order?.actualFiatAmount && order.actualFiatAmount > 0n ? order.actualFiatAmount : order?.fiatAmount ?? 0n;
  const fiatDisplay = fmtAmount(fiat6, currency);
  // Paise included, as p2p.me's widget writes it (`am=${fiatDisplay}`, two
  // decimals). This was rounded to whole rupees, so a ₹99.99 order put ₹100 in
  // the UPI QR — the customer paid a different amount from the one owed.
  const fiatUpi = (Number(fiat6) / 1e6).toFixed(2);

  const qrValue =
    currency === "INR" && decryptedUpi
      ? upiUri({ upiId: decryptedUpi, merchantName, amountInr: fiatUpi, orderId: orderId || "" })
      : decryptedUpi || "";

  // The widget's `remaining < 60_000`.
  const urgent = phase === "accepted" && secondsLeft < 60;

  return (
    <div className="pc-content">
      <div className="pc-card">
        <div className="pc-head">
          <div className="pc-head-amount">{fiatDisplay}</div>
          {phase === "accepted" && <StatusStrip secondsLeft={secondsLeft} urgent={urgent} />}
        </div>

        {phase === "matching" && (
          <div className="pc-matching">
            <span className="pc-spinner" aria-hidden="true" />
            <div className="pc-matching-h">Finding a payment provider…</div>
            <div className="pc-matching-sub">This usually takes a few seconds.</div>
          </div>
        )}

        {phase === "accepted" && (
          <>
            {!decryptedUpi ? (
              <div className="pc-matching">
                <span className="pc-spinner" aria-hidden="true" />
                <div className="pc-matching-sub">Decrypting payment details…</div>
              </div>
            ) : (
              <>
                {currency === "INR" ? (
                  <IndiaPayMethods qrValue={qrValue} />
                ) : currency === "BRL" ? (
                  <BrazilPayMethod qrValue={qrValue} copied={copied} onCopy={copy} />
                ) : (
                  <OtherRailNote currency={currency} />
                )}

                <div className="pc-details">
                  <div className="pc-details-h">Payment details</div>
                  <DetailRow
                    // The rail's own name for this field — "UPI ID", "PIX key",
                    // "CBU / alias" — from the country registry rather than two
                    // hardcoded cases, so a currency added there is labelled
                    // correctly here with no change to this file. Anything
                    // unlisted degrades to a plain "Payment address".
                    label={countryForCurrency(currency).payoutLabel}
                    value={decryptedUpi}
                    onCopy={() => copy("payout", decryptedUpi)}
                    copied={copied === "payout"}
                    mono
                  />
                  <DetailRow label="Amount" value={fiatDisplay} />
                </div>

                {errorMsg && <p className="pc-error">{errorMsg}</p>}

                <button className="pc-paid-btn" onClick={handleMarkPaid} disabled={busy}>
                  {busy ? "Confirming…" : "I've paid"}
                </button>

                <button className="pc-cancel-btn" onClick={() => setConfirmCancel(true)} disabled={busy}>
                  Cancel order
                </button>
              </>
            )}
          </>
        )}

        {phase === "paying" && (
          <div className="pc-matching">
            <span className="pc-spinner" aria-hidden="true" />
            <div className="pc-matching-h">Verifying your payment</div>
            <div className="pc-matching-sub">Confirming receipt. Usually under a minute.</div>
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
          />
        )}

        {phase === "expired" && (
          <ExpiredPanel onCancel={handleCancel} busy={busy} />
        )}

        {phase === "cancelled" && <CancelledPanel />}

        {/* Errors outside the "accepted" panel (which shows its own): a cancel
            refused on the expired screen — busy, rate-limited, network — used
            to look like nothing happened at all. */}
        {errorMsg && phase !== "accepted" && <p className="pc-error">{errorMsg}</p>}

        {confirmCancel && (
          <div className="pc-confirm-overlay" role="dialog" aria-modal="true">
            <div className="pc-confirm-card">
              <div className="pc-confirm-h">Cancel this order?</div>
              <div className="pc-confirm-sub">If you've already paid, don't cancel — wait for confirmation instead.</div>
              <div className="pc-confirm-actions">
                <button className="pc-confirm-keep" onClick={() => setConfirmCancel(false)}>Keep order</button>
                <button className="pc-confirm-yes" onClick={handleCancel} disabled={busy}>Yes, cancel</button>
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx global>{`
        :root {
          --pq-accent: #453deb;
          --pq-accent-dark: #362fc4;
          --pq-accent-soft: #eeedfd;
          --pq-panel-2: rgba(255,255,255,0.82);
          --pq-border: #ecebf5;
          --pq-text: #14132b;
          --pq-muted: #6b6a7d;
          --pq-faint: #a2a1b5;
          --pq-success: #0f9d6f;
          --pq-success-soft: #e5f7ef;
          --pq-warn: #c9791a;
          --pq-warn-soft: #fdf0de;
          --pq-danger: #d8433a;
          --pq-danger-soft: #fce9e7;
        }

        .pc-content {
          position: relative; z-index: 1;
          width: 100%; max-width: 420px;
          padding: 44px 18px 48px;
          margin: 0 auto;
        }

        .pc-card { background: transparent; display: flex; flex-direction: column; }

        .pc-head { display: flex; flex-direction: column; align-items: center; text-align: center; margin-bottom: 22px; }
        .pc-head-amount {
          font-size: 44px; font-weight: 800; letter-spacing: -0.03em;
          color: #ffffff; font-variant-numeric: tabular-nums;
          text-shadow: 0 4px 22px rgba(0,20,50,0.28);
        }

        .pc-matching {
          display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px;
          padding: 36px 24px;
        }
        .pc-matching-h { font-size: 17px; font-weight: 800; color: #ffffff; text-shadow: 0 2px 10px rgba(0,20,50,0.25); }
        .pc-matching-sub { font-size: 13px; color: rgba(255,255,255,0.85); text-shadow: 0 1px 6px rgba(0,20,50,0.2); }
        .pc-spinner {
          width: 30px; height: 30px; border-radius: 50%;
          border: 3px solid rgba(255,255,255,0.35); border-top-color: #fff;
          animation: pcSpin .8s linear infinite;
        }
        @keyframes pcSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .pc-spinner { animation-duration: 1.6s; } }

        .pc-qr-card { margin: 0 0 16px; padding: 22px; border: 1px solid rgba(255,255,255,0.7); border-radius: 20px; background: var(--pq-panel-2); backdrop-filter: blur(12px); display: flex; flex-direction: column; align-items: center; gap: 12px; box-shadow: 0 18px 40px -20px rgba(0,20,60,0.35); }
        .pc-qr-label { font-size: 12.5px; font-weight: 700; color: var(--pq-muted); text-transform: uppercase; letter-spacing: 0.05em; }
        .pc-qr-box { padding: 12px; background: #fff; border-radius: 16px; box-shadow: 0 1px 2px rgba(20,18,60,.06); }
        .pc-qr-hint { font-size: 12px; color: var(--pq-muted); text-align: center; max-width: 26ch; }

        .pc-details { margin: 0 0 16px; padding: 6px 18px; border: 1px solid rgba(255,255,255,0.7); border-radius: 16px; background: var(--pq-panel-2); backdrop-filter: blur(12px); box-shadow: 0 18px 40px -20px rgba(0,20,60,0.35); }
        .pc-details-h { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pq-faint); padding: 12px 0 4px; }
        .pc-drow { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-top: 1px dashed var(--pq-border); }
        .pc-drow:first-of-type { border-top: none; }
        .pc-drow-k { font-size: 12.5px; color: var(--pq-muted); font-weight: 600; flex: none; }
        .pc-drow-v { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .pc-drow-val { font-size: 13.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pq-text); }
        .pc-drow-val.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12.5px; }
        .pc-copy-btn { flex: none; border: none; background: var(--pq-accent-soft); color: var(--pq-accent); width: 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background .12s ease; }
        .pc-copy-btn:hover { background: var(--pq-accent); color: #fff; }
        .pc-copy-btn.copied { background: var(--pq-success); color: #fff; }

        .pc-apps { margin: 0 0 16px; }
        .pc-apps-h { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #ffffff; margin-bottom: 10px; text-align: center; text-shadow: 0 1px 6px rgba(0,20,50,0.25); }
        .pc-app-btn {
          display: flex; align-items: center; justify-content: center; gap: 8px;
          border: 1px solid rgba(255,255,255,0.7); background: var(--pq-panel-2); color: var(--pq-text);
          backdrop-filter: blur(12px);
          border-radius: 14px; padding: 13px 10px; font-size: 13.5px; font-weight: 700;
          text-decoration: none; cursor: pointer; transition: border-color .12s ease, background .12s ease;
          box-shadow: 0 12px 26px -18px rgba(0,20,60,0.35);
        }
        .pc-app-btn:hover { border-color: var(--pq-accent); background: #ffffff; }
        .pc-app-btn-wide { width: 100%; }

        .pc-copy-code-btn {
          margin-top: 4px; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
          border: none; background: var(--pq-accent); color: #fff; border-radius: 14px; padding: 14px 10px;
          font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer;
          transition: background .12s ease;
        }
        .pc-copy-code-btn:hover { background: var(--pq-accent-dark); }
        .pc-copy-code-btn.copied { background: var(--pq-success); }

        .pc-bank-card { margin: 0 0 16px; padding: 20px; border: 1px solid rgba(255,255,255,0.7); border-radius: 20px; background: var(--pq-panel-2); backdrop-filter: blur(12px); box-shadow: 0 18px 40px -20px rgba(0,20,60,0.35); }
        .pc-bank-h { font-size: 12.5px; font-weight: 700; color: var(--pq-muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
        .pc-bank-sub { font-size: 12.5px; color: var(--pq-muted); }

        .pc-error { color: #ffe1de; font-size: 13px; text-align: center; margin: 0 0 12px; text-shadow: 0 1px 6px rgba(0,20,50,0.25); }

        .pc-paid-btn {
          width: 100%; border: none; cursor: pointer;
          background: #ffffff; color: #453deb;
          font-family: inherit; font-size: 15px; font-weight: 800; letter-spacing: -0.01em;
          padding: 15px 20px; border-radius: 14px;
          transition: opacity .12s ease, transform .08s ease;
          box-shadow: 0 18px 40px -20px rgba(0,20,60,0.4);
        }
        .pc-paid-btn:hover:not(:disabled) { opacity: 0.9; }
        .pc-paid-btn:active:not(:disabled) { transform: translateY(1px); }
        .pc-paid-btn:disabled { opacity: 0.6; cursor: default; }

        .pc-cancel-btn {
          margin-top: 10px; width: 100%; cursor: pointer;
          background: var(--pq-panel-2); backdrop-filter: blur(12px);
          border: 1px solid rgba(255,255,255,0.7); color: var(--pq-danger);
          font-family: inherit; font-size: 14px; font-weight: 700; letter-spacing: -0.01em;
          padding: 13px; border-radius: 14px; transition: background .12s ease;
          box-shadow: 0 12px 26px -18px rgba(0,20,60,0.3);
        }
        .pc-cancel-btn:hover:not(:disabled) { background: var(--pq-danger-soft); }
        .pc-cancel-btn:disabled { opacity: 0.6; cursor: default; }

        .pc-confirm-overlay {
          position: fixed; inset: 0; z-index: 50;
          background: rgba(10,15,30,0.5); backdrop-filter: blur(2px);
          display: flex; align-items: flex-end; justify-content: center;
          padding: 20px; animation: pcFadeIn .18s ease;
        }
        @keyframes pcFadeIn { from { opacity: 0; } to { opacity: 1; } }
        .pc-confirm-card {
          width: 100%; max-width: 380px; background: #ffffff; border-radius: 22px;
          padding: 22px 20px; box-shadow: 0 30px 60px -20px rgba(0,20,60,0.4);
          animation: pcSlideUp .22s cubic-bezier(.2,1,.4,1);
        }
        @keyframes pcSlideUp { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .pc-confirm-overlay, .pc-confirm-card { animation: none; } }
        .pc-confirm-h { font-size: 17px; font-weight: 800; color: var(--pq-text); letter-spacing: -0.01em; }
        .pc-confirm-sub { font-size: 13px; color: var(--pq-muted); margin-top: 6px; line-height: 1.5; }
        .pc-confirm-actions { display: flex; gap: 10px; margin-top: 18px; }
        .pc-confirm-keep, .pc-confirm-yes {
          flex: 1; border: none; cursor: pointer; font-family: inherit; font-size: 14px; font-weight: 700;
          padding: 12px; border-radius: 12px;
        }
        .pc-confirm-keep { background: var(--pq-accent-soft); color: var(--pq-accent-dark); }
        .pc-confirm-keep:hover { background: var(--pq-accent); color: #fff; }
        .pc-confirm-yes { background: var(--pq-danger-soft); color: var(--pq-danger); }
        .pc-confirm-yes:hover:not(:disabled) { background: var(--pq-danger); color: #fff; }
        .pc-confirm-yes:disabled { opacity: 0.6; cursor: default; }

        .pc-status { display: flex; align-items: center; justify-content: center; gap: 10px; margin-top: 16px; padding: 13px 16px; background: var(--pq-panel-2); backdrop-filter: blur(12px); border-radius: 999px; border: 1px solid rgba(255,255,255,0.7); }
        .pc-status.urgent { background: var(--pq-warn-soft); }
        .pc-status-text { font-size: 12.5px; font-weight: 700; color: var(--pq-accent-dark); }
        .pc-status.urgent .pc-status-text { color: var(--pq-warn); }
        .pc-status-timer { font-variant-numeric: tabular-nums; font-weight: 800; }
        .pc-pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--pq-accent); flex: none; animation: pcPulse 1.3s ease-in-out infinite; }
        .pc-status.urgent .pc-pulse { background: var(--pq-warn); }
        @keyframes pcPulse { 0%,100% { opacity: .35; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
        @media (prefers-reduced-motion: reduce) { .pc-pulse { animation: none; opacity: .8; } }

        .pc-success, .pc-expired {
          display: flex; flex-direction: column; align-items: center; text-align: center; padding: 32px 24px; gap: 8px;
          background: var(--pq-panel-2); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.7);
          border-radius: 24px; box-shadow: 0 18px 40px -20px rgba(0,20,60,0.35);
        }
        .pc-success-ico {
          width: 76px; height: 76px; border-radius: 50%; background: var(--pq-success-soft); color: var(--pq-success);
          display: flex; align-items: center; justify-content: center; margin-bottom: 6px;
          animation: pcPop .4s cubic-bezier(.2,1.2,.4,1) both;
        }
        @keyframes pcPop { from { transform: scale(.55); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .pc-success-ico { animation: none; } }
        .pc-success-h { font-size: 21px; font-weight: 800; letter-spacing: -0.02em; color: var(--pq-text); }
        .pc-success-amt { font-size: 40px; font-weight: 800; letter-spacing: -0.03em; color: var(--pq-text); font-variant-numeric: tabular-nums; }
        .pc-success-sub { font-size: 13.5px; color: var(--pq-muted); }

        .pc-rcpt-full { position: fixed; inset: 0; z-index: 60; overflow-y: auto; background: var(--bg, #fff); }
        .pc-rcpt-share { width: 100%; margin-top: 16px; }
        .pc-rcpt-full .rcpt-help { margin: 12px 0 0; }

        .pc-expired-ico {
          width: 76px; height: 76px; border-radius: 50%; background: var(--pq-danger-soft); color: var(--pq-danger);
          display: flex; align-items: center; justify-content: center; margin-bottom: 6px;
        }
        .pc-expired-h { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; color: var(--pq-text); }
        .pc-expired-sub { font-size: 13.5px; color: var(--pq-muted); max-width: 30ch; }
        .pc-retry-btn {
          margin-top: 10px; border: none; cursor: pointer; background: var(--pq-accent); color: #fff;
          font-family: inherit; font-size: 14.5px; font-weight: 700; padding: 13px 26px; border-radius: 999px;
        }
        .pc-retry-btn:hover:not(:disabled) { background: var(--pq-accent-dark); }
        .pc-retry-btn:disabled { opacity: 0.6; cursor: default; }
      `}</style>
    </div>
  );
}

function IndiaPayMethods({ qrValue }: { qrValue: string }) {
  return (
    <>
      <div className="pc-qr-card">
        <div className="pc-qr-label">Scan to pay</div>
        <div className="pc-qr-box">
          <QRCodeSVG value={qrValue} size={196} {...PAYMENT_LINK_QR_STYLE} />
        </div>
        <div className="pc-qr-hint">Scan this QR with your banking or payment app</div>
      </div>
      <div className="pc-apps">
        <div className="pc-apps-h">Pay with UPI</div>
        <a className="pc-app-btn pc-app-btn-wide" href={qrValue}>
          Open UPI app
        </a>
      </div>
    </>
  );
}

function BrazilPayMethod({
  qrValue,
  copied,
  onCopy,
}: {
  qrValue: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <>
      <div className="pc-qr-card">
        <div className="pc-qr-label">Scan to pay</div>
        <div className="pc-qr-box">
          <QRCodeSVG value={qrValue} size={196} {...PAYMENT_LINK_QR_STYLE} />
        </div>
        <div className="pc-qr-hint">Scan this Pix QR in your bank app</div>
      </div>
      <div className="pc-apps">
        <div className="pc-apps-h">Or pay with Pix Copia e Cola</div>
        <button
          className={`pc-copy-code-btn${copied === "pix-code" ? " copied" : ""}`}
          onClick={() => onCopy("pix-code", qrValue)}
        >
          {copied === "pix-code" ? <CheckIcon /> : <CopyIcon />}
          {copied === "pix-code" ? "Code copied" : "Copy Pix code"}
        </button>
      </div>
    </>
  );
}

function OtherRailNote({ currency }: { currency: string }) {
  return (
    <div className="pc-bank-card">
      <div className="pc-bank-h">Bank transfer</div>
      <div className="pc-bank-sub">Send the {currency} amount below using your banking app.</div>
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
  return (
    <div className="pc-drow">
      <div className="pc-drow-k">{label}</div>
      <div className="pc-drow-v">
        <span className={`pc-drow-val${mono ? " mono" : ""}`}>{value}</span>
        {onCopy && (
          <button className={`pc-copy-btn${copied ? " copied" : ""}`} onClick={onCopy} aria-label={`Copy ${label}`}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </button>
        )}
      </div>
    </div>
  );
}

function StatusStrip({ secondsLeft, urgent }: { secondsLeft: number; urgent: boolean }) {
  return (
    <div className={`pc-status${urgent ? " urgent" : ""}`}>
      <span className="pc-pulse" />
      <span className="pc-status-text">
        Waiting for payment · <span className="pc-status-timer">{fmtTimer(secondsLeft)}</span>
      </span>
    </div>
  );
}

// The PayQR receipt (the same card the customer receipt uses at
// /receipt/[orderId]) told from the PAYER's side: what you paid, to whom, and
// how. Built from the order the widget already polls, so it needs no token, no
// subgraph and no login, and it survives a reload the same way.
function maskHandle(h: string): string {
  if (!h || h === "Session changed") return "";
  if (h.length <= 4) return h;
  const at = h.indexOf("@");
  return `${h.slice(0, 2)}•••${h.slice(at > 0 ? at : h.length - 2)}`;
}

function ReceiptPanel({
  amount, merchantName, currency, orderId, usdc6, feeUsdc6, whenSecs, payoutHandle,
}: {
  amount: string; merchantName: string; currency: string; orderId: string;
  usdc6: bigint; feeUsdc6: bigint; whenSecs: number; payoutHandle: string | null;
}) {
  const country = countryForCurrency(currency);
  const captureRef = useRef<HTMLDivElement>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const when = whenSecs
    ? new Date(whenSecs * 1000).toLocaleString(undefined, {
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
          <div className="rcpt-status">Payment successful</div>
          <div className="rcpt-shop">Paid to {merchantName}</div>
          <div className="rcpt-amount">{amount}</div>
          <div className="rcpt-amount-sub">You paid</div>

          <div className="rcpt-rows">
            <div className="rcpt-row"><span>Paid to</span><b>{merchantName}</b></div>
            {handle && (
              <div className="rcpt-row"><span>{country.payoutLabel}</span><b className="mono">{handle}</b></div>
            )}
            <div className="rcpt-row"><span>Via</span><b>{country.flag} {country.name} · {country.code}</b></div>
            {usdc6 > 0n && <div className="rcpt-row"><span>Settled as</span><b>{usdc(usdc6)} USDC</b></div>}
            {feeUsdc6 > 0n && <div className="rcpt-row"><span>Transaction fee</span><b>{usdc(feeUsdc6)} USDC</b></div>}
            {when && <div className="rcpt-row"><span>When</span><b>{when}</b></div>}
            <div className="rcpt-row"><span>Receipt no.</span><b>#{orderId}</b></div>
            <div className="rcpt-row"><span>Status</span><b className="g">Completed</b></div>
          </div>
          <p className="rcpt-foot">Save this receipt as proof of your payment.</p>

          {/* Inside the card, but left out of the saved image. */}
          <button className="btn ghost pc-rcpt-share" data-html2canvas-ignore="true" onClick={shareAsImage} disabled={imgBusy}>
            {imgBusy ? "Preparing image…" : "Share as image"}
          </button>
          <a
            className="rcpt-help"
            data-html2canvas-ignore="true"
            href={`https://t.me/PayQRdotPRO?text=${encodeURIComponent(`Hi, I need help with payment #${orderId}.`)}`}
            target="_blank" rel="noopener noreferrer"
          >
            Something wrong with this payment? Report an issue ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function ExpiredPanel({ onCancel, busy }: { onCancel: () => void; busy: boolean }) {
  return (
    <div className="pc-expired">
      <div className="pc-expired-ico"><ClockIcon /></div>
      <div className="pc-expired-h">Payment window expired</div>
      <div className="pc-expired-sub">This payment session timed out. No funds were moved.</div>
      <button className="pc-retry-btn" onClick={onCancel} disabled={busy}>{busy ? "Cancelling…" : "Cancel order"}</button>
    </div>
  );
}

function CancelledPanel() {
  return (
    <div className="pc-expired">
      <div className="pc-expired-ico"><XIcon /></div>
      <div className="pc-expired-h">Order cancelled</div>
      <div className="pc-expired-sub">No funds were moved.</div>
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
