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
 * WHICH ENDPOINT, AND WHY IT MATTERS
 * A link payment is a B2B order — a merchant's customer paying through an
 * integrator — so it is screened on the B2B endpoint,
 * POST /activity-logs/b2b-buy-order, exactly as the <Checkout> widget screens
 * the /qr terminal's orders. It used to go through the SDK's processBuyOrder,
 * which posts to the RETAIL endpoint (/activity-logs). That endpoint refuses any
 * wallet with fewer than 10 completed buys ("new accounts cannot place buy
 * orders at this time"), and every link customer screens under a brand-new key
 * — so EVERY link payment was rejected. The B2B endpoint has no new-account
 * gate: it checks the blacklist, rapid cancels, one B2B order in flight per
 * wallet, and the domain-scoped cluster gate.
 *
 * The flow mirrors the widget's processB2BBuyOrder
 * (@p2pdotme/widgets src/core/b2b-fraud-engine.ts), which the package does not
 * export: fingerprint log → B2B activity log → place → link the order id.
 *
 * WHO SIGNS
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
 * order is placed exactly as before. When the fraud engine cannot be reached or
 * answers with an error, the order is still placed (unlinked), as the widget
 * does — an outage at the fraud engine must not take payments down. What it
 * does NOT do is fail open on a REJECTION: a rejected order is never placed.
 */
import type { FraudEngineSigner } from "@p2pdotme/sdk/fraud-engine";
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

/** POST /activity-logs/b2b-buy-order's answer (the widget's B2BScreeningResponse). */
interface B2BScreeningResponse {
  activity_log_id: number | null;
  approved?: boolean;
  reason?: string | null;
  message?: string | null;
  restricted_until?: string | null;
  /** The buyer must pass a liveness check first. */
  liveliness_required?: boolean;
}

type ScreeningCredentials = NonNullable<typeof SCREENING_CONFIG>;

type OrderDetails = {
  fiatAmount: number;
  usdcAmount: number;
  currency: string;
  merchant: string;
};

/**
 * Run the customer's order through screening, then place it.
 *
 * @param place Places the order and resolves to its id — the relayer path in
 *        lib/paymentLinks.ts. Called only if screening does not refuse it, and
 *        at most once.
 * @returns the order id.
 * @throws ScreeningRejected when the engine refuses the order.
 */
export async function placeScreenedOrder(
  params: OrderDetails & { place: () => Promise<string> }
): Promise<string> {
  // Not configured: place exactly as before. This is the whole of the
  // behaviour change for a deployment without credentials.
  if (!SCREENING_CONFIG) return params.place();
  const config = SCREENING_CONFIG;

  const account = await getCustomerSigner();
  const signer: FraudEngineSigner = {
    address: account.address,
    signerAddress: account.address,
    signMessage: (message: string) => account.signMessage({ message }),
  };

  // Before the activity log, so the cluster gate sees this device. A missing
  // fingerprint must never block a payment.
  try {
    await postFingerprintLog(signer, config);
  } catch (e) {
    console.warn("[payqr:screening] fingerprint log failed; continuing", e);
  }

  let screening: B2BScreeningResponse | null = null;
  try {
    screening = await postB2BActivityLog(signer, config, params);
  } catch (e) {
    // Network, 5xx, signing: fail open and place unlinked, as the widget does.
    console.warn("[payqr:screening] screening unavailable; placing without it", e);
  }

  if (screening?.approved === false) {
    throw new ScreeningRejected(
      screening.message || screening.reason || "This payment could not be approved. Please contact the merchant."
    );
  }
  // The widget answers this with its own liveness step; a link has none. Placing
  // anyway would put an order through that the engine asked to be held.
  if (screening?.liveliness_required === true) {
    throw new ScreeningRejected(
      "This payment needs an extra verification step that payment links don't support yet. Please contact the merchant."
    );
  }

  // Called once, outside any retry: if it fails, its own error goes to the page
  // unchanged — a relayer refusal or a payment still confirming must never be
  // answered by placing again.
  const orderId = await params.place();

  const activityLogId = screening?.activity_log_id ?? null;
  if (activityLogId !== null) {
    // The order already exists; a failed link only loses the screening record.
    void linkOrder(signer, config, activityLogId, orderId).catch((e) =>
      console.warn(`[payqr:screening] could not link order ${orderId}`, e)
    );
  }
  return orderId;
}

async function postB2BActivityLog(
  signer: FraudEngineSigner,
  config: ScreeningCredentials,
  order: OrderDetails
): Promise<B2BScreeningResponse> {
  const { encryptPayload, getSignedHeaders } = await import("@p2pdotme/sdk/fraud-engine");
  const userAddress = signer.address.toLowerCase();
  const timestamp = Date.now();
  const payload = JSON.stringify({
    user_details: { currency: order.currency },
    transaction_details: {
      crypto_amount: order.usdcAmount,
      fiat_amount: order.fiatAmount,
      currency: order.currency,
      recipient_address: order.merchant,
      // The link path quotes the customer a single total; there is no separate
      // fee line to report, so the whole amount is what they pay.
      fee: 0,
      amount_after_fee: order.usdcAmount,
      payment_method: "payment_link",
      order_timestamp: timestamp,
      order_source: config.orderSource || SUPPORT_ORIGIN_APP,
    },
    device_details: deviceDetails(),
    // Scopes the cluster gate to this product's domain.
    domain: hostname(),
  });
  const encrypted = await encryptPayload(payload, `b2b_buy_order|${userAddress}|${timestamp}`, config.encryptionKey);
  const headers = await getSignedHeaders(signer, "activity-log");

  const res = await fetch(`${trimSlash(config.apiUrl)}/activity-logs/b2b-buy-order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ user_address: userAddress, timestamp, encrypted_payload: encrypted }),
  });
  if (!res.ok) throw new Error(`b2b-buy-order: HTTP ${res.status}`);
  const data = (await res.json()) as B2BScreeningResponse;
  // An approval must carry the id the order is linked to afterwards; without it
  // the answer is unusable, which is an API fault — fail open, as the widget does.
  if (data.approved !== false && data.activity_log_id == null) {
    throw new Error("b2b-buy-order: approved without an activity_log_id");
  }
  return data;
}

async function linkOrder(
  signer: FraudEngineSigner,
  config: ScreeningCredentials,
  activityLogId: number,
  orderId: string
): Promise<void> {
  const { getSignedHeaders } = await import("@p2pdotme/sdk/fraud-engine");
  const headers = await getSignedHeaders(signer, "link-order");
  const res = await fetch(`${trimSlash(config.apiUrl)}/activity-logs/link-order`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      activity_log_id: activityLogId,
      order_id: orderId,
      user_address: signer.address.toLowerCase(),
    }),
  });
  if (!res.ok) throw new Error(`link-order: HTTP ${res.status}`);
}

async function postFingerprintLog(signer: FraudEngineSigner, config: ScreeningCredentials): Promise<void> {
  const { encryptPayload, getFingerprint, getSignedHeaders } = await import("@p2pdotme/sdk/fraud-engine");
  const fingerprint = await getFingerprint(3000);
  if (!fingerprint) return;
  const userAddress = signer.address.toLowerCase();
  const timestamp = Date.now();
  const payload = JSON.stringify({ fingerprint_id: fingerprint.visitorId, is_b2b: true, domain: hostname() });
  const encrypted = await encryptPayload(payload, `fingerprint|${userAddress}|${timestamp}`, config.encryptionKey);
  const headers = await getSignedHeaders(signer, "fingerprint-log");
  const res = await fetch(`${trimSlash(config.apiUrl)}/fingerprint-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ user_address: userAddress, timestamp, encrypted_payload: encrypted }),
  });
  if (!res.ok) throw new Error(`fingerprint-log: HTTP ${res.status}`);
}

/** The widget's getMinimalDeviceDetails. */
function deviceDetails(): Record<string, unknown> {
  if (typeof navigator === "undefined") return {};
  const scr = typeof screen !== "undefined" ? screen : null;
  return {
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: Array.from(navigator.languages ?? []),
    screen_width: scr?.width ?? 0,
    screen_height: scr?.height ?? 0,
    device_pixel_ratio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    timezone: typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined,
    timezone_offset: new Date().getTimezoneOffset(),
    cookies_enabled: navigator.cookieEnabled,
    do_not_track: navigator.doNotTrack ?? null,
    online: navigator.onLine,
    touch_support: typeof window !== "undefined" && "ontouchstart" in window,
    max_touch_points: navigator.maxTouchPoints ?? 0,
    vendor: navigator.vendor ?? "",
    app_version: navigator.appVersion,
    color_depth: scr?.colorDepth ?? 0,
    pixel_depth: scr?.pixelDepth ?? 0,
  };
}

/** Hostname only, so scheme and port don't fragment clusters. */
function hostname(): string {
  return typeof window !== "undefined" && window.location ? window.location.hostname || "" : "";
}

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
