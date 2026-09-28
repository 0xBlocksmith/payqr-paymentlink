// Merchant transaction history straight from the p2p.me subgraph — no backend
// database. The subgraph indexes every on-chain order across the WHOLE p2p
// protocol, so every query here is scoped to PayQR's own integrators as well as
// to this merchant — a merchant who also uses other P2P ecosystem apps must not
// see those orders here. Balances/locks still come live from the contracts; this
// is purely the historical list.

import { keccak256, stringToBytes, isAddress } from "viem";
import { SUBGRAPH_URL } from "./p2p";
import { ALL_CONTRACT_ADDRESSES } from "./contract";

const ST = { 0: "matching", 1: "matching", 2: "matching", 3: "settled", 4: "cancelled" };

/**
 * EVERY PayQR integrator, current and previous, lower-cased for the subgraph.
 *
 * History spans contract upgrades: an upgrade deploys a NEW integrator, and the
 * merchant's earlier orders stay recorded under the OLD one. Scoping to the
 * current address alone made all of that history vanish the moment the app was
 * repointed. Still strictly PayQR-only: orders from other apps on the protocol
 * carry other integrator ids and never match.
 */
const scope = () => ALL_CONTRACT_ADDRESSES.map((a) => a.toLowerCase());

/** One address or a list → unique, valid, non-zero, lower-case addresses. */
function addrList(...inputs: (string | string[] | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const x of inputs.flat()) {
    if (x && isAddress(x) && !/^0x0+$/i.test(x)) out.add(x.toLowerCase());
  }
  return [...out];
}

/**
 * POST a query. Throws on a network failure AND on a 200-with-errors, so a
 * subgraph outage or reindex never renders as "no transactions" — a merchant
 * can't tell that from a genuine zero. Callers keep their last good data.
 * Values always travel as GraphQL VARIABLES, never interpolated.
 */
async function querySubgraph(query: string, variables: Record<string, unknown>, label: string) {
  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    throw new Error("Couldn't reach the transaction index.");
  }
  if (data?.errors) {
    console.error(`subgraph error (${label}):`, data.errors);
    throw new Error("Subgraph returned an error.");
  }
  return data?.data;
}

/**
 * The BUY orderIds this merchant placed through ANY PayQR integrator, mapped to
 * the integrator each went through.
 *
 * `orders_collection` is protocol-wide and has NO integrator field, so it
 * cannot be scoped on its own. `b2Borders` does carry `integrator` and shares
 * the orderId space, so it is the scoping index.
 *
 * Two kinds of placer: a POS sale records the MERCHANT as the order's user, a
 * payment-link sale records the merchant's PROXY — and each integrator has its
 * own proxy for the merchant. Pass every proxy (see useMerchantProxies).
 *
 * Returns null when no integrator is configured, so callers can tell "not
 * scopeable" from "scoped to zero orders".
 */
async function fetchPayqrOrderIds(
  address: string,
  proxies?: string | string[]
): Promise<Map<string, string> | null> {
  const integrators = scope();
  if (integrators.length === 0) return null;
  const data = await querySubgraph(
    `query($users: [String!], $integrators: [String!]) {
      b2Borders(
        first: 500,
        where: { user_in: $users, orderType: 0, integrator_in: $integrators },
        orderBy: blockTimestamp,
        orderDirection: desc
      ) { orderId integrator { id } }
    }`,
    { users: addrList(address, proxies), integrators },
    "fetchPayqrOrderIds"
  );
  return new Map<string, string>(
    (data?.b2Borders || []).map((o) => [String(o.orderId), String(o.integrator?.id || "")])
  );
}

/**
 * A merchant's BUY orders (POS and link sales) across every PayQR integrator.
 * Rows: { orderId, amount (raw 6-dec), status, txHash, createdAt, placedAt,
 * completedAt, integrator } — status is 'matching' | 'settled' | 'cancelled'.
 */
export async function fetchHistory(address, proxies?: string | string[]) {
  if (!address || !isAddress(address)) return [];

  let scoped: Map<string, string> | null;
  try {
    scoped = await fetchPayqrOrderIds(address, proxies);
  } catch {
    // Never fall back to an unscoped query — that would leak other apps' orders.
    throw new Error("Couldn't reach the transaction index.");
  }
  if (!scoped || scoped.size === 0) return [];

  const data = await querySubgraph(
    `query($users: [String!], $ids: [String!]) {
      orders_collection(
        first: 200,
        where: { userAddress_in: $users, orderId_in: $ids },
        orderBy: orderId,
        orderDirection: desc
      ) { orderId status usdcAmount placedAt completedAt transactionHash }
    }`,
    { users: addrList(address, proxies), ids: [...scoped.keys()] },
    "fetchHistory"
  );

  return (data?.orders_collection || []).map((o) => {
    const placed = Number(o.placedAt) * 1000;
    return {
      orderId: String(o.orderId),
      amount: String(o.usdcAmount), // raw 6-dec
      status: ST[Number(o.status)] || "matching",
      txHash: o.transactionHash || null,
      createdAt: new Date(placed).toISOString(),
      placedAt: Number(o.placedAt),
      completedAt: o.completedAt ? Number(o.completedAt) : null,
      integrator: scoped!.get(String(o.orderId)) || null,
    };
  });
}

/**
 * A merchant's FIAT WITHDRAWALS (SELL orders, orderType 1) across every PayQR
 * integrator. They are placed by the merchant's PROXY, one per integrator, so
 * pass every proxy.
 *
 * Rows are shaped like fetchHistory's, tagged kind:"withdraw".
 */
export async function fetchWithdrawals(proxies: string | string[]) {
  const users = addrList(proxies);
  const integrators = scope();
  if (users.length === 0 || integrators.length === 0) return [];
  const data = await querySubgraph(
    `query($users: [String!], $integrators: [String!]) {
      b2Borders(
        first: 200,
        where: { user_in: $users, orderType: 1, integrator_in: $integrators },
        orderBy: blockTimestamp,
        orderDirection: desc
      ) { orderId amount transactionHash blockTimestamp integrator { id } }
    }`,
    { users, integrators },
    "fetchWithdrawals"
  );
  return (data?.b2Borders || []).map((o) => {
    const ts = Number(o.blockTimestamp) * 1000;
    return {
      orderId: String(o.orderId),
      amount: String(o.amount), // raw 6-dec USDC
      kind: "withdraw",
      status: "withdrawn",
      txHash: o.transactionHash || null,
      createdAt: new Date(ts).toISOString(),
      placedAt: Number(o.blockTimestamp),
      integrator: o.integrator?.id || null,
    };
  });
}

/**
 * Fetch a SINGLE order by id from the subgraph — powers the public,
 * no-auth customer receipt page (/receipt/[orderId]). Returns null if not found.
 *   { orderId, amount(raw 6-dec, principal the merchant nets), fiatAmount
 *     (raw 6-dec, the customer's TOTAL paid incl. any small-order fee),
 *     status, userAddress, txHash, placedAt, completedAt }
 */
export async function fetchOrder(orderId) {
  // On-chain order ids are integers — reject anything else so a crafted id can't
  // reach the query as arbitrary text (defense-in-depth for the public receipt).
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  let data;
  try {
    data = await querySubgraph(
      `query($id: String!) {
        orders_collection(first: 1, where: { orderId: $id }) {
          orderId status usdcAmount fiatAmount actualUsdcAmount actualFiatAmount
          userAddress placedAt completedAt transactionHash
        }
      }`,
      { id },
      "fetchOrder"
    );
  } catch {
    // The receipt page already treats null as "not ready yet / refresh".
    return null;
  }
  const o = data?.orders_collection?.[0];
  if (!o) return null;
  // Prefer the ACTUAL settled amounts when present (post-match, e.g. a partial
  // fill), falling back to the as-placed amounts otherwise.
  const usdcAmount = o.actualUsdcAmount && o.actualUsdcAmount !== "0" ? o.actualUsdcAmount : o.usdcAmount;
  const fiatAmount = o.actualFiatAmount && o.actualFiatAmount !== "0" ? o.actualFiatAmount : o.fiatAmount;
  return {
    orderId: String(o.orderId),
    amount: String(usdcAmount), // principal — what the MERCHANT receives
    fiatAmount: fiatAmount != null ? String(fiatAmount) : null, // what the CUSTOMER paid (incl. fee)
    status: ST[Number(o.status)] || "matching",
    userAddress: o.userAddress || null, // the placer (merchant, or their proxy)
    txHash: o.transactionHash || null,
    placedAt: Number(o.placedAt),
    completedAt: o.completedAt ? Number(o.completedAt) : null,
  };
}

/**
 * Fetch a SINGLE WITHDRAWAL (fiat SELL) order by id — powers the withdrawal
 * receipt. Withdrawals are b2Borders (orderType 1), keyed by the merchant's
 * proxy in `user`. Returns the SAME shape as fetchOrder. null if not found.
 *
 * Scoped to PayQR's integrators (all of them): an orderId pasted into a receipt
 * link must never resolve to a DIFFERENT app's withdrawal. The receipt page
 * independently re-checks on-chain registration too.
 */
export async function fetchWithdrawalOrder(orderId) {
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  const integrators = scope();
  if (integrators.length === 0) return null;
  let data;
  try {
    data = await querySubgraph(
      `query($id: String!, $integrators: [String!]) {
        b2Borders(first: 1, where: { orderId: $id, orderType: 1, integrator_in: $integrators }) {
          orderId amount user transactionHash blockTimestamp integrator { id }
        }
      }`,
      { id, integrators },
      "fetchWithdrawalOrder"
    );
  } catch {
    return null;
  }
  const o = data?.b2Borders?.[0];
  if (!o) return null;
  const ts = Number(o.blockTimestamp);
  return {
    orderId: String(o.orderId),
    amount: String(o.amount), // raw 6-dec USDC
    status: "settled", // indexed here ⇒ the fiat leg fired
    userAddress: o.user || null, // the merchant's proxy → verifyOrderOwner resolves it
    txHash: o.transactionHash || null,
    placedAt: ts,
    completedAt: ts,
    integrator: o.integrator?.id || null,
  };
}

/**
 * Receipt link access token — there's no backend to hold a signing secret, so
 * instead of a real signature we derive the token from the order's on-chain
 * tx hash, which is unpredictable until the payment actually settles. A link
 * minted before the real payment lands can't guess it; the receipt page
 * recomputes this from the SAME chain data it already fetches and rejects a
 * mismatch. Not cryptographically unforgeable (no secret key), but enough to
 * stop someone from browsing to a link for /receipt/<other-order-id>.
 */
export function receiptToken(orderId: string, txHash: string): string {
  return keccak256(stringToBytes(`${orderId}:${txHash.toLowerCase()}`)).slice(2, 18);
}

/**
 * A merchant's PAYMENT-LINK sales only — across every PayQR integrator.
 *
 * The separation comes from the contract: a POS sale records the MERCHANT as
 * the order's user, a link sale records the merchant's PROXY. So BUY orders
 * (orderType 0) under the proxies are exactly the link sales. Pass every proxy
 * — one per integrator — or link sales made before an upgrade disappear.
 *
 * Rows are shaped like fetchHistory's, tagged kind:"link".
 */
export async function fetchLinkOrders(proxies: string | string[]) {
  const users = addrList(proxies);
  const integrators = scope();
  if (users.length === 0 || integrators.length === 0) return [];

  const idData = await querySubgraph(
    `query($users: [String!], $integrators: [String!]) {
      b2Borders(
        first: 500,
        where: { user_in: $users, orderType: 0, integrator_in: $integrators },
        orderBy: blockTimestamp,
        orderDirection: desc
      ) { orderId integrator { id } }
    }`,
    { users, integrators },
    "fetchLinkOrders ids"
  );
  const integratorOf = new Map<string, string>(
    (idData?.b2Borders || []).map((o) => [String(o.orderId), String(o.integrator?.id || "")])
  );
  if (integratorOf.size === 0) return [];

  const data = await querySubgraph(
    `query($users: [String!], $ids: [String!]) {
      orders_collection(
        first: 500,
        where: { userAddress_in: $users, orderId_in: $ids },
        orderBy: orderId,
        orderDirection: desc
      ) { orderId status usdcAmount placedAt completedAt transactionHash }
    }`,
    { users, ids: [...integratorOf.keys()] },
    "fetchLinkOrders"
  );

  return (data?.orders_collection || []).map((o) => ({
    orderId: String(o.orderId),
    amount: String(o.usdcAmount),
    status: ST[Number(o.status)] || "matching",
    txHash: o.transactionHash || null,
    placedAt: Number(o.placedAt),
    completedAt: o.completedAt ? Number(o.completedAt) : null,
    kind: "link",
    integrator: integratorOf.get(String(o.orderId)) || null,
  }));
}
