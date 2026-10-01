/**
 * Customer-side order reading + payout decryption for Payment Links.
 *
 * Reverse-engineered from @p2pdotme/widgets' own checkout.js: once an order
 * reaches ACCEPTED, the widget reads the order's `encUpi` field straight off
 * the Diamond contract and decrypts it client-side with
 * decryptPaymentAddress({ encrypted, recipientIdentity }) — both are public
 * exports of @p2pdotme/sdk/orders (already a direct dependency here), not
 * internals private to the widget package. This lets a custom, non-widget UI
 * (PaymentLinkWidget.tsx) render the SAME real payout data the widget does,
 * with our own screens instead of the widget's.
 *
 * cancel/paidBuyOrder: the SDK's OrdersClient can PREPARE these calls
 * (produces {to, data} without needing a signer), which we then forward
 * through the already-deployed, narrowly-scoped worker `/api/relay-tx`
 * endpoint — the exact mechanism PaymentLinkWidget.tsx's CheckoutSigner stub
 * already used for the same two calls when they came from inside <Checkout>.
 * The worker still recognises these exact selectors and translates them onto
 * LinkRouter (worker/src/config.ts's RELAY_INTENTS) — that part of the
 * forwarding shape is unchanged by PR #104.
 *
 * WHAT PR #104 ADDED: the worker now requires a `claimToken` (minted at
 * placement, see lib/paymentLinks.ts's makeRelayerPlaceOrder) AND a customer
 * EIP-712 signature over the exact (linkId, orderId, action) being requested
 * — LinkRouter.markPaid/cancel verify that signature on-chain and refuse to
 * advance or cancel anything without it. Both are threaded through here now;
 * forwardToRelay's old {to, data}-only body would be rejected outright.
 */
// TYPE-ONLY: see customerRelayIdentity.ts. createOrders is loaded on demand so
// the ECIES stack stays off the pay page's first paint.
import type { Order, OrdersClient } from "@p2pdotme/sdk/orders";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";
import { DIAMOND_ADDRESS, USDC_ADDRESS, SUBGRAPH_URL } from "./p2p";
import { RELAYER_WORKER_URL, getLinkClaim, markPaidTypedData, cancelTypedData } from "./paymentLinks";
import { customerRelayStore, getCustomerSigner, getCustomerIdentity } from "./customerRelayIdentity";
import { LINK_ROUTER_ABI, LINK_ROUTER_ADDRESS } from "./contract";

const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

let cachedClient: OrdersClient | null = null;

async function client(): Promise<OrdersClient> {
  if (cachedClient) return cachedClient;
  const { createOrders } = await import("@p2pdotme/sdk/orders");
  cachedClient = createOrders({
    publicClient: reader as any,
    diamondAddress: DIAMOND_ADDRESS as `0x${string}`,
    usdcAddress: USDC_ADDRESS as `0x${string}`,
    subgraphUrl: SUBGRAPH_URL,
    relayIdentityStore: await customerRelayStore(),
  });
  return cachedClient;
}

/** Read a single order straight from the Diamond contract (no subgraph
 *  indexing lag) — includes `status`, `encUpi`, and the settled amounts. */
export async function getCustomerOrder(orderId: string): Promise<Order> {
  const result = await (await client()).getOrder({ orderId: BigInt(orderId) });
  if (result.isErr()) throw new Error(result.error.message || "Could not read the order.");
  return result.value;
}

/** Decrypt an order's `encUpi` with the customer's OWN relay identity.
 *  null when it can't be decrypted on this device (encrypted to another key).
 *  It used to return the text "Session changed", which the page then showed as
 *  the payout address and put into the UPI QR (review M1) — never a value to
 *  pay to. */
export async function decryptPayoutAddress(encUpi: string): Promise<string | null> {
  try {
    const result = await (await client()).decryptPaymentAddress({ encrypted: encUpi });
    return result.isErr() || !result.value ? null : result.value;
  } catch {
    return null;
  }
}

/**
 * The circle to place a link order in, chosen the way p2p.me's Checkout widget
 * chooses (review M5): the SDK routes to a circle with partners eligible for
 * THIS amount. Taking the first circle listed for the currency left every link
 * order on "Setting up your payment…" whenever that circle had nobody
 * online, while another had partners.
 *
 * "none" means no partner can take it right now — the caller says so instead
 * of placing an order nobody will accept. null means routing itself failed (a
 * subgraph or RPC hiccup); the caller falls back to the currency's circle.
 * `user` is who the order belongs to on-chain: the merchant's proxy.
 *
 * ONLY "no eligible circles" is "none". placeOrder.prepare wraps EVERY
 * selectCircle failure in the one code CIRCLE_SELECTION_FAILED — a subgraph
 * request that failed and a genuinely empty partner list arrive identically at
 * this level. Reading that code as "none" turned any routing hiccup into
 * "Payments are busy right now" and refused a payment the warmed circle could
 * have taken (review item 1). The real answer is one level down, on the
 * wrapped cause: NO_ELIGIBLE_CIRCLES is the only one that means nobody can
 * take it. Everything else (SUBGRAPH_REQUEST_FAILED, VALIDATION_ERROR, …) is
 * our side failing, and falls back.
 */
export async function routeLinkCircle(p: {
  currency: string;
  usdcAmount: bigint;
  fiatAmount: bigint;
  user: Address;
}): Promise<bigint | "none" | null> {
  try {
    const prepared = await (await client()).placeOrder.prepare({
      orderType: 0, // BUY
      currency: p.currency as any,
      user: p.user,
      amount: p.usdcAmount,
      fiatAmount: p.fiatAmount,
      recipientAddr: p.user,
      preferredPaymentChannelConfigId: 0n,
    } as any);
    if (prepared.isErr()) {
      const cause = (prepared.error as { cause?: { code?: unknown } }).cause;
      if (prepared.error.code === "CIRCLE_SELECTION_FAILED" && cause?.code === "NO_ELIGIBLE_CIRCLES") return "none";
      console.warn("[payqr:routing] circle routing failed; falling back to the currency's circle", prepared.error);
      return null;
    }
    return prepared.value.meta?.circleId ?? null;
  } catch {
    return null;
  }
}

/**
 * How far this device's clock is from the chain's, in ms — 0 unless it is off
 * by more than 30 s. The pay window is counted from the chain's acceptance time
 * against this device's clock (as p2p.me's widget does), so a phone running
 * five minutes fast showed the window as already over the moment it opened
 * (review M4). Ignoring small differences keeps the countdown identical to the
 * widget's on a correctly set phone. A failed read assumes the clock is right.
 */
export async function deviceClockSkewMs(): Promise<number> {
  try {
    const block = await reader.getBlock();
    const skew = Number(block.timestamp) * 1000 - Date.now();
    return Math.abs(skew) > 30_000 ? skew : 0;
  } catch {
    return 0;
  }
}

/**
 * Is `orderId` really an order on THIS link, placed with THIS browser's key?
 * Read from the LinkRouter, which records both when the order is placed.
 *
 * The order id reaches the page from the relayer, and nothing checked it
 * (review M1): a compromised relayer could hand back an order on another link,
 * placed with this customer's pubkey — so the customer would be shown, and
 * pay, a stranger's payout details. Checked before any payment details are
 * shown. "unknown" is a read failure: keep waiting, show nothing, retry.
 */
export async function verifyLinkOrder(orderId: string, linkId: Hex): Promise<"ok" | "mismatch" | "unknown"> {
  try {
    const identity = await getCustomerIdentity();
    const [customer, onLink] = (await reader.readContract({
      address: LINK_ROUTER_ADDRESS as `0x${string}`,
      abi: LINK_ROUTER_ABI,
      functionName: "orders",
      args: [BigInt(orderId)],
    } as any)) as readonly [string, Hex];
    if (/^0x0+$/.test(customer)) return "unknown"; // not recorded yet (or not a link order)
    const sameLink = onLink.toLowerCase() === linkId.toLowerCase();
    const sameCustomer = customer.toLowerCase() === String(identity.address).toLowerCase();
    return sameLink && sameCustomer ? "ok" : "mismatch";
  } catch {
    return "unknown";
  }
}

async function forwardToRelay(params: {
  to: `0x${string}`;
  data: `0x${string}`;
  claimToken: string;
  signature: Hex;
  human?: { challenge: string; nonce: string } | null;
}): Promise<RelayResult> {
  const res = await fetch(`${RELAYER_WORKER_URL}/api/relay-tx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Flattened: the relayer reads `challenge` and `nonce` at the top level
    // of the body, not nested. Sending the object would pass every local check
    // and then fail the gate server-side with nothing to point at.
    body: JSON.stringify({
      to: params.to,
      data: params.data,
      claimToken: params.claimToken,
      signature: params.signature,
      challenge: params.human?.challenge,
      nonce: params.human?.nonce,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    throw new RelayError(body?.error || "This action isn't available right now.", res.status);
  }
  // `warning`: the relayer's notice that an earlier claim from this device did
  // not settle. Shown to the customer so a block never comes as a surprise.
  return (await res.json()) as RelayResult;
}

export type RelayResult = { hash: `0x${string}`; warning?: string };

/** A refused relay-tx call, with its HTTP status so a caller can tell "still
 *  confirming" (502) from a real refusal. */
export class RelayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RelayError";
  }
}

/** The relayer sent the action but stopped waiting for its outcome — it may
 *  still land, so it is not a failure to retry. */
export function isStillConfirming(e: unknown): boolean {
  return e instanceof RelayError && e.status === 502 && /still being confirmed/i.test(e.message);
}

/**
 * Shared setup for markOrderPaid/cancelCustomerOrder: the claim token minted
 * at placement, and the customer's own EIP-712 signature over this exact
 * (linkId, orderId, action) — LinkRouter refuses to advance or cancel
 * anything without both. `linkId` and `chainId` must be the SAME ones the
 * order was placed against; the pay page threads these through from the
 * link it already read off-chain.
 */
async function signRelayAction(params: {
  orderId: string;
  linkId: Hex;
  chainId: number;
  action: "markPaid" | "cancel";
}): Promise<{ claimToken: string; signature: Hex }> {
  const claimToken = getLinkClaim(params.orderId);
  if (!claimToken) throw new Error("This payment session is no longer valid. Please reopen the link.");

  const signer = await getCustomerSigner();
  const orderId = BigInt(params.orderId);
  // viem infers signTypedData's overload from the literal call site, so the
  // two shapes are kept as separate calls rather than one shared variable
  // passed to a single call — a ternary here fails to typecheck even though
  // both branches are individually valid.
  const signature =
    params.action === "markPaid"
      ? await signer.signTypedData(markPaidTypedData(params.chainId, params.linkId, orderId))
      : await signer.signTypedData(cancelTypedData(params.chainId, params.linkId, orderId));

  return { claimToken, signature };
}

/** Customer taps "I've paid" — the real paidBuyOrder(orderId) call, prepared
 *  by the SDK and forwarded through the relayer (customer has no signer),
 *  authorised by the customer's own EIP-712 signature over this order. */
export async function markOrderPaid(params: {
  orderId: string;
  linkId: Hex;
  chainId: number;
  human?: { challenge: string; nonce: string } | null;
}): Promise<RelayResult> {
  const prepared = await (await client()).paidBuyOrder.prepare({ orderId: BigInt(params.orderId) });
  if (prepared.isErr()) throw new Error(prepared.error.message || "Could not prepare the confirmation.");
  const { claimToken, signature } = await signRelayAction({ ...params, action: "markPaid" });
  return forwardToRelay({
    to: prepared.value.to,
    data: prepared.value.data,
    claimToken,
    signature,
    human: params.human,
  });
}

/** Customer taps "Cancel order" — the real cancelOrder(orderId) call, same
 *  prepare-then-forward path as markOrderPaid, same customer-signature gate. */
export async function cancelCustomerOrder(params: {
  orderId: string;
  linkId: Hex;
  chainId: number;
  human?: { challenge: string; nonce: string } | null;
}): Promise<RelayResult> {
  const prepared = await (await client()).cancelOrder.prepare({ orderId: BigInt(params.orderId) });
  if (prepared.isErr()) throw new Error(prepared.error.message || "Could not prepare the cancellation.");
  const { claimToken, signature } = await signRelayAction({ ...params, action: "cancel" });
  return forwardToRelay({
    to: prepared.value.to,
    data: prepared.value.data,
    claimToken,
    signature,
    human: params.human,
  });
}
