/**
 * Fraud screening for a WALLETLESS payment-link customer.
 *
 * WHY THIS EXISTS
 * The merchant app only accepts an order carrying an approved screening record,
 * and INR buy orders are NOT auto-approved. An unscreened order therefore sits
 * at PLACED until it expires — the customer waits on "Finding a payment
 * provider…" forever, and nothing anywhere says why. That is the single reason
 * a link payment could not complete on INR.
 *
 * WHO SIGNS, AND WHY IT MATTERS
 * The screening call is EIP-191 signed by "the user". For a link order the
 * on-chain `order.user` is the merchant's PROXY, a contract that cannot sign at
 * all — so the subject cannot be the order's user, and it must not be the
 * relayer either: the fraud engine enforces one order in flight per wallet, so
 * a shared relayer subject would collide on the second concurrent payment.
 *
 * The subject is the CUSTOMER'S OWN ephemeral key — the same one their browser
 * already generated for `pubKey`, which the LP encrypts payment details to and
 * which signs "I have paid". One key, one identity, one in-flight order per
 * real customer. This is the approach payment-integrators'
 * docs/integrators/merchant-terminal.md prescribes, not an invention here.
 *
 * FAIL-OPEN, DELIBERATELY
 * When screening is not configured, this module is a no-op passthrough: the
 * order is placed exactly as before. A deployment without fraud-engine
 * credentials keeps working on currencies that do not require screening, rather
 * than refusing every payment. The SDK itself also fails open if the API errors
 * — an outage at the fraud engine must not take payments down. What it does NOT
 * do is fail open on a REJECTION: a rejected order is never placed.
 */
import { SCREENING_CONFIG, SUPPORT_ORIGIN_APP } from "./p2p";
import { getCustomerSigner } from "./customerRelayIdentity";

/** True when this deployment has fraud-engine credentials configured. */
export const SCREENING_ENABLED = Boolean(SCREENING_CONFIG);

export class ScreeningRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreeningRejected";
  }
}

/**
 * Run the customer's order through screening, then place it.
 *
 * @param place Places the order and resolves to its id — the relayer path in
 *        lib/paymentLinks.ts. Called ONLY if screening approves.
 * @returns the order id.
 * @throws ScreeningRejected when the engine refuses the order.
 */
export async function placeScreenedOrder(params: {
  place: () => Promise<string>;
  fiatAmount: number;
  usdcAmount: number;
  currency: string;
  merchant: string;
}): Promise<string> {
  // Not configured: place exactly as before. This is the whole of the
  // behaviour change for a deployment without credentials.
  if (!SCREENING_CONFIG) return params.place();

  const { createFraudEngine } = await import("@p2pdotme/sdk/fraud-engine");
  const engine = createFraudEngine({
    apiUrl: SCREENING_CONFIG.apiUrl,
    encryptionKey: SCREENING_CONFIG.encryptionKey,
  });

  // Device fingerprinting and session setup. A failure here must not block a
  // payment — the check below still runs, just with less signal.
  try {
    await engine.init();
  } catch {
    /* proceed without device signal */
  }

  const account = await getCustomerSigner();
  // Whether OUR place() actually ran. After it has, a failure must reach the
  // page as it is — never be answered by placing again.
  let placeCalled = false;
  const place = async () => {
    placeCalled = true;
    return params.place();
  };
  const signer = {
    address: account.address,
    signMessage: (message: string) => account.signMessage({ message }),
  };

  const result = await engine.processBuyOrder({
    signer,
    orderDetails: {
      cryptoAmount: params.usdcAmount,
      fiatAmount: params.fiatAmount,
      currency: params.currency,
      recipientAddress: params.merchant,
      // The link path quotes the customer a single total; there is no separate
      // fee line to report, so the whole amount is what they pay.
      fee: 0,
      amountAfterFee: params.usdcAmount,
      paymentMethod: "payment_link",
    },
    orderSource: SCREENING_CONFIG.orderSource || SUPPORT_ORIGIN_APP,
    placeOrder: place,
  });

  if (result.isErr()) {
    // The SDK reports OUR placement failing (PLACE_ORDER_ERROR) the same way
    // as its own problems. This used to place again on ANY error — so a relayer
    // refusal, or a payment that was still confirming, was followed by a second
    // /api/pay and could become a duplicate order. Now: if place() ran, its own
    // error goes to the page unchanged; only if it never ran (the SDK failed
    // before getting that far) do we place, failing open as the SDK intends.
    if (placeCalled) {
      const cause = (result.error as { cause?: unknown }).cause;
      throw cause instanceof Error ? cause : result.error;
    }
    return params.place();
  }
  if (result.value.status === "rejected") {
    throw new ScreeningRejected(
      result.value.message || "This payment could not be approved. Please contact the merchant."
    );
  }
  return result.value.orderId;
}
