"use client";

import { useState, useEffect } from "react";
import { Checkout } from "@p2pdotme/widgets/checkout";
import { useCheckoutSigner } from "./useCheckoutSigner";
import { useRelayIdentity } from "./useRelayIdentity";
import { makePlaceOrder, SUBGRAPH_URL, USDC_ADDRESS, DIAMOND_ADDRESS, CURRENCIES, SCREENING_CONFIG } from "../lib/p2p";
import { ACTIVE_CHAIN } from "../lib/chain";
import { friendlyError } from "../lib/contract";
import { Icon } from "./Icons";

/**
 * Live UPI checkout via the official p2p.me widget. The widget generates the
 * relay identity (user pubkey), auto-resolves the INR circle through the
 * subgraph, and drives the place → accept → pay → complete flow. We supply the
 * placeOrder callback that calls OUR integrator's userPlaceOrder.
 *
 * Props:
 *   orderId     string — when set, the widget skips placeOrder and tracks an
 *               already-placed order instead (resuming a payment the merchant
 *               reopened this dialog for)
 *   usdcAmount  bigint (6-dec) — what the merchant is charging
 *   quantity    bigint — product-2 units (USDC cents) for our userPlaceOrder
 *   productName string
 *   onComplete  (orderId) => void
 *   onClose     () => void
 */
type CheckoutWidgetProps = {
  orderId?: string;
  usdcAmount: bigint;
  /** Optional 6-dec fiat override for the CUSTOMER-facing total. When the order
   *  is sized to the nearest whole USDC cent, the on-chain quote drifts a
   *  fraction off a round fiat amount (₹250 → ₹249.57); passing the merchant's
   *  typed round fiat here shows ₹250.00 instead. Omitted → widget derives fiat
   *  from the on-chain buyPrice × usdcAmount (its default). */
  fiatAmount?: bigint;
  quantity: bigint;
  productName?: string;
  currencies?: any[];
  onPlaced?: (orderId: any, txHash?: any) => void;
  onComplete?: (orderId: any) => void;
  onCancel?: (orderId?: any) => void;
  onClose?: () => void;
  onError?: (msg: string) => void;
};

export function CheckoutWidget({ orderId, usdcAmount, fiatAmount, quantity, productName, currencies, onPlaced, onComplete, onCancel, onClose, onError }: CheckoutWidgetProps) {
  const { signer, publicClient, ready } = useCheckoutSigner();
  const { getIdentity, syncToSdkStore } = useRelayIdentity();
  const [err, setErr] = useState("");
  // Mirror our per-address relay identity into the widget's global store BEFORE
  // it mounts, so the widget places the order AND decrypts the returned payout
  // with the SAME key. Otherwise the payer's UPI/PIX shows as "Session changed".
  // Gate the widget on this so the store is correct the first time the widget
  // reads it.
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    let on = true;
    syncToSdkStore().then(() => { if (on) setSynced(true); }).catch(() => { if (on) setSynced(true); });
    return () => { on = false; };
    // getIdentity/syncToSdkStore are stable per address; re-run only if the
    // connected account changes (which changes the identity to mirror).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready || !synced) {
    return <p className="muted">Preparing wallet…</p>;
  }

  const placeOrder = makePlaceOrder({ signer, publicClient, quantity, getIdentity });

  return (
    <div className="checkout-fullscreen">
      {onClose && (
        <button className="checkout-fullscreen-close" onClick={onClose} aria-label="Close">
          <Icon.Close />
        </button>
      )}
      {err && <p className="error">{err}</p>}
      <Checkout
        mode="inline"
        orderId={orderId}
        signer={signer}
        chainId={ACTIVE_CHAIN.id}
        diamondAddress={(DIAMOND_ADDRESS || undefined) as `0x${string}` | undefined}
        currencies={currencies && currencies.length ? currencies : CURRENCIES}
        productName={productName}
        amount={`${(Number(usdcAmount) / 1e6).toFixed(2)} USDC`}
        subgraphUrl={SUBGRAPH_URL}
        usdcAddress={(USDC_ADDRESS || undefined) as `0x${string}` | undefined}
        usdcAmount={usdcAmount}
        fiatAmount={fiatAmount}
        screening={SCREENING_CONFIG}
        placeOrder={placeOrder}
        onOrderPlaced={(orderId, txHash) => onPlaced?.(orderId, txHash)}
        onComplete={(orderId) => onComplete?.(orderId)}
        onCancel={(orderId) => onCancel?.(orderId)}
        onError={(e) => { const m = friendlyError(e, "Couldn't start this payment. Please try again."); setErr(m); onError?.(m); }}
        onClose={() => onClose?.()}
      />
    </div>
  );
}
