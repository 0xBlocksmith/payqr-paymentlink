"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { createPublicClient, http } from "viem";
import { fetchOrder, fetchWithdrawalOrder, receiptToken } from "../../../lib/history";
import { fmtUsdc, CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../../lib/contract";
import { ACTIVE_CHAIN, RPC_URL } from "../../../lib/chain";
import { Icon, Logo } from "../../../components/Icons";

// Read-only chain client (public receipt has no wallet — just reads). Use the
// CONFIGURED RPC, not the default public endpoint (which the app documents as
// 429-prone) — otherwise routine rate-limiting trips the ownership check's
// fail-open path and strips the "✓ verified" badge from legit receipts.
const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

// Currency code → its off-chain payment RAIL + country, so the receipt can say
// "via UPI · India". Keep in sync with lib/countries.ts. Unknown codes fall back
// to a generic "Bank transfer" so a future currency still renders sensibly.
const RAIL: Record<string, { rail: string; country: string; flag: string }> = {
  INR: { rail: "UPI", country: "India", flag: "🇮🇳" },
  BRL: { rail: "PIX", country: "Brazil", flag: "🇧🇷" },
  ARS: { rail: "Transfers 3.0", country: "Argentina", flag: "🇦🇷" },
};
function railFor(code: string) {
  return RAIL[code] || (code ? { rail: "Bank transfer", country: code, flag: "🏦" } : null);
}
/** Short 0x address for display: 0x1234…abcd. */
function shortAddr(a?: string | null): string {
  if (!a || !/^0x[0-9a-fA-F]{6,}$/.test(a)) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
/** Human date+time from a unix seconds timestamp, in the viewer's locale. */
function fmtWhen(secs?: number | null): string {
  if (!secs) return "";
  try {
    return new Date(secs * 1000).toLocaleString(undefined, {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}

/** True for a DEFINITIVE contract-shape error (missing ABI function, decode
 *  mismatch, revert, or zero-data) — as opposed to a transient network/RPC error.
 *  A definitive error means our read is genuinely wrong/rejected, so the ownership
 *  check must fail CLOSED (treat as NOT ours). Transient errors fail OPEN so a
 *  flaky RPC doesn't block a real customer.
 *
 *  IMPORTANT: viem's readContract wraps EVERY failure — including a plain HTTP 429
 *  or timeout — in an outer ContractFunctionExecutionError, so classifying on the
 *  OUTER error name would mark every transient failure as "definitive" and fail
 *  closed on a flaky RPC. We instead WALK to the root cause (BaseError.walk) and
 *  use a positive allow-list of TRANSIENT roots; anything else (abi/revert/
 *  zero-data) is definitive. Default to transient (fail open) when unsure. */
function isDefinitiveError(e: any): boolean {
  // Unwrap viem's error chain to the innermost cause, if available.
  let root = e;
  if (e && typeof e.walk === "function") {
    root = e.walk() || e;
  }
  const rootName = String(root?.name || "");
  const outerName = String(e?.name || "");
  const msg = String(e?.shortMessage || e?.message || e || "");

  // Transient (network / RPC) → NOT definitive → fail open.
  if (
    /HttpRequestError|TimeoutError|RpcRequestError|RpcError|WebSocketRequestError|HttpRequest|Timeout/i.test(rootName) ||
    /HTTP request failed|took too long|timed out|rate limit|429|network|fetch failed|Failed to fetch/i.test(msg)
  ) {
    return false;
  }

  // Definitive contract-shape roots → fail closed.
  return (
    /AbiFunctionNotFound|AbiDecoding|AbiEncoding|ContractFunctionRevert|ContractFunctionZeroData|AbiErrorSignatureNotFound|InvalidAddress/i.test(rootName) ||
    /AbiFunctionNotFound|AbiDecoding|ContractFunctionRevert|ContractFunctionZeroData/i.test(outerName) ||
    /reverted|not found on ABI|does not exist|cannot decode|returned no data|zero data/i.test(msg)
  );
}

/** getMerchantInfo(addr) → { registered, shopName }. Returns registered=false on
 *  a definitive not-registered/contract error (fail CLOSED), or null ONLY on a
 *  transient RPC error (caller may fail open for a real customer on a flaky RPC). */
async function readMerchant(
  addr: string
): Promise<{ registered: boolean; shopName: string } | null> {
  try {
    // getMerchantInfo(address) returns (v12: payout is encrypted bytes, not a string)
    //   (bytes encPayoutId, string shopName, bytes32 currency, bool isRegistered, bool isFrozen)
    const info: any = await reader.readContract({
      address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI,
      functionName: "getMerchantInfo", args: [addr as `0x${string}`],
    } as any);
    return { registered: info?.[3] === true, shopName: (info?.[1] as string) || "" };
  } catch (e) {
    // Definitive contract error → treat as NOT registered (fail closed).
    if (isDefinitiveError(e)) return { registered: false, shopName: "" };
    return null; // transient only
  }
}

// Result of the ownership check. Three states so the page never renders a
// foreign order as a valid "successful payment" on a fail-open:
//   "verified"   — chain-confirmed to belong to a registered PayQR merchant
//   "notOurs"    — definitively NOT a PayQR order (random/foreign) → "not found"
//   "unverified" — couldn't check (transient RPC) → "couldn't verify, refresh"
type OwnerCheck = { state: "verified" | "notOurs" | "unverified"; shopName: string };

/** Verify on-chain that an order belongs to one of OUR OWN registered PayQR
 *  merchants. Handles BUY (placer = merchant EOA) and SELL (placer = proxy).
 *  SECURITY: on a transient RPC failure we return "unverified" (NOT a pass) so a
 *  foreign order can never be shown as a valid receipt by inducing an RPC error;
 *  the customer just refreshes. Only a chain-confirmed registered merchant yields
 *  "verified"; a definitive non-match yields "notOurs". */
async function verifyOrderOwner(placer: string): Promise<OwnerCheck> {
  // 1) BUY case: the placer itself is the merchant EOA.
  const direct = await readMerchant(placer);
  if (direct === null) return { state: "unverified", shopName: "" }; // transient
  if (direct.registered) return { state: "verified", shopName: direct.shopName };

  // 2) SELL case: the placer is a per-merchant proxy → resolve to the merchant.
  let merchant: string;
  try {
    merchant = (await reader.readContract({
      address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI,
      functionName: "proxyMerchant", args: [placer as `0x${string}`],
    } as any)) as string;
  } catch (e) {
    // Definitive contract error → definitively not ours; transient → unverified.
    if (isDefinitiveError(e)) return { state: "notOurs", shopName: "" };
    return { state: "unverified", shopName: "" };
  }
  // Not a registered EOA AND not one of our proxies → definitively not ours.
  if (!merchant || /^0x0+$/i.test(merchant)) return { state: "notOurs", shopName: "" };

  const viaProxy = await readMerchant(merchant);
  if (viaProxy === null) return { state: "unverified", shopName: "" }; // transient
  return { state: viaProxy.registered ? "verified" : "notOurs", shopName: viaProxy.shopName };
}

const SCAN = "https://sepolia.basescan.org";

/**
 * PUBLIC customer receipt — no login. The merchant shares this link (or shows
 * the on-screen QR after a sale) so the person who just paid can verify the
 * transaction on-chain. The order itself is read from the subgraph; the shop
 * name + fiat amount the customer paid come from the link query (the chain only
 * records the USDC leg), and the order id / status / proof are trustless.
 */
export default function Receipt() {
  const { orderId } = useParams();
  const params = useSearchParams();
  // Only accept a NUMERIC order id from the URL (on-chain ids are integers).
  // Rejecting anything else prevents a crafted id from reaching the subgraph
  // query as arbitrary text.
  const rawId = Array.isArray(orderId) ? orderId[0] : orderId;
  const safeId = typeof rawId === "string" && /^\d+$/.test(rawId) ? rawId : "";
  // fiat comes from the link query — an UNVERIFIED display hint only. The
  // trustworthy figures (USDC amount, status, order id) come from the chain
  // below; we never let the URL override those. Sanitize to plain text and cap
  // length so a crafted link can't inject markup or absurd strings. (The `shop`
  // hint is deliberately NOT read for display — the on-chain name is the only
  // shop label we trust; see the shopName derivation below.)
  const clean = (s: string) => s.replace(/[<>]/g, "").slice(0, 40);
  const fiat = clean(params.get("fiat") || "");   // display hint, e.g. "₹820"
  // Masked payout handle (e.g. "sh•••@upi") — a display hint the merchant's own
  // withdraw flow appends to their receipt link. Already masked before it leaves
  // the merchant's device (the public receipt has no key to decrypt the on-chain
  // handle anyway), so only a partial identifier is ever exposed on a shared link.
  // Sanitized like every other hint; the • are kept, markup stripped.
  const upiMasked = clean(params.get("upi") || "");
  // Transaction KIND ("buy" = customer paid the merchant | "withdraw" = merchant
  // cashed out to fiat/crypto). Display hint from the link so the receipt frames
  // the right story; the on-chain amount/status stay the trustworthy figures.
  const kindRaw = (params.get("kind") || "buy").toLowerCase();
  const kind = kindRaw === "withdraw" || kindRaw === "usdc" ? kindRaw : "buy";
  const isWithdraw = kind === "withdraw" || kind === "usdc";
  const isCryptoOut = kind === "usdc"; // USDC→own wallet (no fiat rail)
  // Currency code ("INR"/"BRL"/"ARS") → drives the payment-rail label. Sanitize to
  // 3–5 uppercase letters; empty if absent.
  const curRaw = (params.get("cur") || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  // Only accept a well-formed 32-byte tx hash from the URL — otherwise a crafted
  // ?tx= could point the "Confirmation → View" link at an unrelated basescan
  // path and lend a real pending receipt forged credibility.
  const txRaw = params.get("tx") || "";
  const txParam = /^0x[0-9a-fA-F]{64}$/.test(txRaw) ? txRaw : "";
  // Access token: proves the visitor holds the exact link the merchant shared
  // (derived from orderId + the real tx hash, unguessable before the payment
  // settles) rather than one who is just enumerating sequential order ids.
  const accessToken = params.get("token") || "";

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifiedShop, setVerifiedShop] = useState(""); // real shop name from chain
  const [imgBusy, setImgBusy] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  // Ownership gate: null = still checking; then "verified" (chain-confirmed ours),
  // "notOurs" (foreign/random → not found), or "unverified" (couldn't check →
  // refresh). We only render a valid receipt on "verified" — never fail open.
  const [ownerState, setOwnerState] = useState<null | "verified" | "notOurs" | "unverified">(null);
  // Bumping this re-runs the on-chain verification WITHOUT a full page reload
  // (the "Refresh" button on the unverified state). Keeps the PWA feel — no
  // white flash, no wallet/provider re-boot.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let on = true;
    setLoading(true); setOwnerState(null);
    // A non-numeric / missing order id is a genuinely malformed link → "not found".
    if (!safeId) { setLoading(false); setOwnerState("notOurs"); return; }
    // A MISSING token is NOT proof of a foreign order — it usually means the link
    // was minted/shared before the payment settled (the token is derived from the
    // on-chain tx hash, which doesn't exist yet). Show the refreshable "couldn't
    // verify yet" state so the customer can retry once it settles, instead of a
    // permanent "not found" dead end. Only a token MISMATCH below is "not found".
    if (!accessToken) { setLoading(false); setOwnerState("unverified"); return; }
    // A withdrawal (fiat SELL) lives in a DIFFERENT subgraph table (b2Borders) than
    // a payment (orders_collection). Pick the source by the `kind` hint, but fall
    // back to the other table if the primary misses — so a mis-hinted link still
    // resolves instead of falsely showing "not found".
    const lookup = async () => {
      const primary = isWithdraw ? fetchWithdrawalOrder : fetchOrder;
      const secondary = isWithdraw ? fetchOrder : fetchWithdrawalOrder;
      return (await primary(safeId)) || (await secondary(safeId));
    };
    lookup().then((o: any) => {
      if (!on) return;
      setOrder(o); setLoading(false);
      if (!o) { setOwnerState("notOurs"); return; }
      // The token can only be recomputed once the order has a real on-chain
      // tx hash. No hash yet (still matching) → can't confirm the visitor
      // holds a valid link; ask them to wait rather than fail open.
      if (!o.txHash) { setOwnerState("unverified"); return; }
      if (receiptToken(safeId, o.txHash) !== accessToken) { setOwnerState("notOurs"); return; }
      if (!o.userAddress) { setOwnerState("unverified"); return; }
      // Verify on-chain that this order belongs to one of OUR registered
      // merchants BEFORE showing it as a valid receipt.
      verifyOrderOwner(o.userAddress).then((r) => {
        if (!on) return;
        setOwnerState(r.state);
        setVerifiedShop(r.shopName);
      });
    });
    return () => { on = false; };
  }, [safeId, accessToken, retry, isWithdraw]);

  // The trustworthy shop name comes ONLY from the chain (verifiedShop). The URL
  // ?shop= hint is attacker-controllable in a crafted link, so we NEVER render it
  // as the trusted "Paid to X" line — a registered merchant whose on-chain shop
  // name is blank simply shows no shop label rather than an attacker-chosen one.
  const shopVerified = !!verifiedShop;
  const shopName = shopVerified ? verifiedShop : "";
  // Only "verified" renders the real receipt. Everything else shows a safe state.
  const verifying = !!order && ownerState === null; // fetched, still checking
  const notOurs = ownerState === "notOurs";         // definitively not a PayQR order
  const unverified = ownerState === "unverified";   // couldn't confirm (refresh)

  const settled = order?.status === "settled";
  const cancelled = order?.status === "cancelled";
  const txHash = order?.txHash || txParam;

  // ── Verification details the merchant uses to identify the transaction ──
  const rail = railFor(curRaw);                 // { rail, country, flag } | null
  const payer = shortAddr(order?.userAddress);  // buyer/proxy on-chain address
  // Timestamp: completed time if we have it, else when it was placed.
  const whenTs = order?.completedAt || order?.placedAt || null;
  const when = fmtWhen(whenTs);

  // Render the receipt card to a PNG and hand it to the OS share sheet (or
  // download it, if sharing files isn't supported) — so the customer can save
  // or forward proof of payment as an image instead of just a link.
  async function shareAsImage() {
    if (!captureRef.current || imgBusy) return;
    setImgBusy(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: getComputedStyle(captureRef.current).backgroundColor || "#ffffff",
        scale: Math.min(window.devicePixelRatio || 2, 3),
      });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return;
      const file = new File([blob], `payqr-receipt-${order.orderId}.png`, { type: "image/png" });
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
      // Best-effort — leave the customer with the on-screen receipt if it fails.
    } finally {
      setImgBusy(false);
    }
  }

  return (
    <div className="rcpt-screen">
      <div className="rcpt-card" ref={captureRef}>
        <div className="brand rcpt-brand">
          <Logo size={24} className="brand-mark" /> PayQR
        </div>

        {loading || verifying ? (
          <p className="muted" style={{ textAlign: "center", padding: "30px 0" }}>
            {verifying ? "Verifying receipt…" : "Loading receipt…"}
          </p>
        ) : !order ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Receipt not ready yet</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              If you just paid, please wait a moment and refresh this page.
            </p>
          </div>
        ) : notOurs ? (
          // The order exists on-chain but was NOT placed through this PayQR
          // contract by a registered merchant — a random or foreign id. Never
          // render it as a valid receipt.
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Receipt not found</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              This receipt link isn’t valid. Please check the link from your
              payment, or ask the merchant to share it again.
            </p>
          </div>
        ) : unverified ? (
          // Couldn't confirm the order on-chain (network hiccup). We do NOT show
          // the order as a valid receipt here — that fail-open would let a forged
          // link display a foreign order as "paid". Ask the customer to refresh.
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Couldn’t verify yet</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              We couldn’t confirm this receipt on-chain right now. Please refresh
              in a moment.
            </p>
            <button className="btn" style={{ marginTop: 14 }}
              onClick={() => setRetry((n) => n + 1)}>
              Refresh
            </button>
          </div>
        ) : (
          <>
            <div className={`rcpt-tick ${cancelled ? "bad" : settled ? "ok" : "wait"}`}>
              {cancelled ? "✕" : <Icon.Check />}
            </div>
            <div className="rcpt-status">
              {isWithdraw
                ? (cancelled ? "Withdrawal cancelled" : settled ? "Cash-out successful" : "Withdrawal going through")
                : (cancelled ? "Payment cancelled" : settled ? "Payment successful" : "Payment going through")}
            </div>
            {/* WHO: for a payment, "Paid to <shop>"; for a withdrawal the merchant
                IS the shop, so we frame it as their own cash-out. */}
            {shopName && (
              <div className="rcpt-shop">
                {isWithdraw ? shopName : `Paid to ${shopName}`}
                {shopVerified && <span className="rcpt-verified" title="Shop name verified on-chain"> ✓ verified</span>}
              </div>
            )}

            {/* The on-chain USDC amount is the trustworthy figure (read from the
                subgraph). The fiat is a display hint from the link and shown as
                secondary — a receipt can't be forged into a different USDC amount. */}
            <div className="rcpt-amount">
              {fmtUsdc(order.amount)} USDC
            </div>
            {fiat && <div className="rcpt-amount-fiat">{fiat}</div>}
            <div className="rcpt-amount-sub">
              {isWithdraw
                ? (cancelled
                    ? "This withdrawal did not go through"
                    : settled
                      ? (isCryptoOut ? "Sent to your wallet" : "Paid out to your account")
                      : "Your withdrawal is being processed")
                : (cancelled
                    ? "This payment did not go through"
                    : settled
                      ? "Your payment is complete"
                      : "Your payment is being confirmed — this only takes a moment")}
            </div>

            <div className="rcpt-rows">
              {/* WHO paid / WHERE it went — the merchant's verification anchor. */}
              {isWithdraw ? (
                <>
                  <div className="rcpt-row">
                    <span>{isCryptoOut ? "Sent to" : "Withdrawn to"}</span>
                    <b>{isCryptoOut ? "Your wallet" : (rail ? `${rail.rail} · ${rail.country}` : "Your account")}</b>
                  </div>
                  {/* The specific payout handle (masked) so the merchant can confirm
                      WHICH account received it. Only for a fiat cash-out, and only
                      when the withdraw flow passed the masked hint. */}
                  {!isCryptoOut && upiMasked && (
                    <div className="rcpt-row">
                      <span>{rail ? rail.rail : "Account"} ID</span>
                      <b className="mono">{upiMasked}</b>
                    </div>
                  )}
                </>
              ) : payer ? (
                <div className="rcpt-row">
                  <span>Paid by</span>
                  <b className="mono">{payer}</b>
                </div>
              ) : null}

              {/* HOW — the off-chain rail (UPI/PIX/…). Skipped for a crypto-out. */}
              {rail && !isCryptoOut && (
                <div className="rcpt-row">
                  <span>Via</span>
                  <b>{rail.flag} {rail.rail} · {rail.country}</b>
                </div>
              )}

              {/* WHEN — so the merchant can match it to a moment in their day. */}
              {when && (
                <div className="rcpt-row"><span>When</span><b>{when}</b></div>
              )}

              <div className="rcpt-row"><span>Receipt no.</span><b>#{order.orderId}</b></div>
              <div className="rcpt-row">
                <span>Status</span>
                <b className={settled ? "g" : cancelled ? "r" : "w"}>
                  {settled ? "Completed" : cancelled ? "Cancelled" : "In progress"}
                </b>
              </div>
              {txHash && (
                <div className="rcpt-row">
                  <span>Confirmation</span>
                  <a className="link" target="_blank" rel="noopener noreferrer"
                     href={`${SCAN}/tx/${txHash}`}>View ↗</a>
                </div>
              )}
            </div>

            <p className="rcpt-foot">
              {isWithdraw
                ? "Save this as a record of your withdrawal."
                : "Save this receipt as proof of your payment."}
            </p>
          </>
        )}
      </div>
      {order && !notOurs && !unverified && !loading && !verifying && (
        <>
          <button className="btn ghost rcpt-share-img" onClick={shareAsImage} disabled={imgBusy}>
            <Icon.Share width="15" height="15" /> {imgBusy ? "Preparing image…" : "Share as image"}
          </button>
          {/* Support / dispute entry — opens the PayQR support channel with the
              order id prefilled so the issue is tied to this exact transaction. */}
          <a className="rcpt-help"
             href={`https://t.me/PayQRdotPRO?text=${encodeURIComponent(
               `Hi, I need help with ${isWithdraw ? "withdrawal" : "payment"} #${order.orderId}.`
             )}`}
             target="_blank" rel="noopener noreferrer">
            Something wrong with this payment? Report an issue ↗
          </a>
        </>
      )}
    </div>
  );
}
