// Merchant transaction history straight from the p2p.me subgraph — no backend
// database. The subgraph indexes every on-chain order across the WHOLE p2p
// protocol, so every query here is scoped to PayQR's own integrator as well as
// to this merchant — a merchant who also uses other P2P ecosystem apps must not
// see those orders here. Balances/locks still come live from the contract; this
// is purely the historical list for the Transactions page.

import { keccak256, stringToBytes, isAddress } from "viem";
import { SUBGRAPH_URL } from "./p2p";
import { CONTRACT_ADDRESS } from "./contract";

const ST = { 0: "matching", 1: "matching", 2: "matching", 3: "settled", 4: "cancelled" };

/**
 * Fetch the orderIds this merchant placed THROUGH PAYQR'S OWN INTEGRATOR.
 *
 * `orders_collection` is protocol-wide and carries NO integrator field (unlike
 * `b2Borders`), so filtering it by `userAddress` alone returns every order the
 * address ever placed on the p2p protocol — including ones from the OTHER P2P
 * ecosystem apps the merchant may have used. Live data confirms this: the same
 * user address appears under several different integrator ids, and orderIds are
 * a single protocol-wide sequence.
 *
 * `b2Borders` DOES carry `integrator` and shares the same orderId space, so it
 * is the scoping index: the PayQR ramps are exactly the orderIds that appear in
 * b2Borders under CONTRACT_ADDRESS for this user. orderType 0 = BUY (an incoming
 * payment / ramp); orderType 1 = the fiat SELL leg handled by fetchWithdrawals.
 *
 * Returns null when scoping can't be established (no configured integrator), so
 * callers can distinguish "not scopeable" from "scoped to zero orders".
 */
async function fetchPayqrOrderIds(address): Promise<string[] | null> {
  if (!CONTRACT_ADDRESS) return null;
  const query = `query($user: String!, $integrator: String!) {
    b2Borders(
      first: 200,
      where: { user: $user, orderType: 0, integrator: $integrator },
      orderBy: blockTimestamp,
      orderDirection: desc
    ) {
      orderId
    }
  }`;
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      variables: { user: address.toLowerCase(), integrator: CONTRACT_ADDRESS.toLowerCase() },
    }),
    cache: "no-store",
  });
  const data = await res.json();
  // Same rule as everywhere else here: a 200-with-errors must not read as an
  // empty scope, which would silently blank the merchant's whole history.
  if (data?.errors) {
    console.error("subgraph error (fetchPayqrOrderIds):", data.errors);
    throw new Error("Subgraph returned an error.");
  }
  return (data?.data?.b2Borders || []).map((o) => String(o.orderId));
}

/**
 * Fetch a merchant's orders from the subgraph.
 * Returns rows shaped for the Transactions page:
 *   { orderId, amount (raw 6-dec string), status, txHash, createdAt(ms), placedAt }
 * status: 'matching' | 'settled' | 'cancelled'  (the page maps these to badges)
 *
 * SCOPED TO PAYQR: only orders placed through this app's integrator are
 * returned — see fetchPayqrOrderIds for why userAddress alone isn't enough.
 */
export async function fetchHistory(address) {
  // Only a well-formed 0x address may reach the query — mirrors the ^\d+$ guard
  // on the id-based lookups. The value is ALSO passed as a GraphQL VARIABLE (not
  // string-interpolated), so it is structurally incapable of altering the query
  // even if a future caller reached this without the regex (defense-in-depth).
  if (!address || !isAddress(address)) return [];

  // Establish the PayQR-only scope first: the set of orderIds this merchant
  // placed through OUR integrator. Everything else the address did elsewhere on
  // the protocol (other P2P ecosystem apps) is excluded by construction.
  let ids;
  try {
    ids = await fetchPayqrOrderIds(address);
  } catch {
    // Scope lookup failed — surface it rather than falling back to the
    // unscoped query, which would leak other integrators' orders into this
    // merchant's history.
    throw new Error("Couldn't reach the transaction index.");
  }
  // No integrator configured ⇒ we cannot prove any order is ours. Return empty
  // rather than showing the whole protocol's traffic as this merchant's.
  if (ids === null) return [];
  if (ids.length === 0) return [];

  const query = `query($user: String!, $ids: [String!]) {
    orders_collection(
      first: 50,
      where: { userAddress: $user, orderId_in: $ids },
      orderBy: orderId,
      orderDirection: desc
    ) {
      orderId
      status
      usdcAmount
      placedAt
      completedAt
      transactionHash
    }
  }`;

  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { user: address.toLowerCase(), ids } }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    // A NETWORK failure must not masquerade as an empty history either — same
    // rationale as the 200-with-errors case below. Returning [] here made every
    // flaky poll wipe real rows to a false "No payments yet". Throw so the
    // caller's .catch keeps the last good data.
    throw new Error("Couldn't reach the transaction index.");
  }
  // A GraphQL endpoint can return HTTP 200 with { errors: [...] } and null data
  // (schema drift, subgraph reindexing/outage). Treating that as an empty list
  // would render a FALSE "no transactions" / "0 earnings" that a merchant can't
  // tell apart from a genuine zero. Throw so the caller's .catch keeps the last
  // good data instead of overwriting it with a misleading empty set.
  if (data?.errors) {
    console.error("subgraph error (fetchHistory):", data.errors);
    throw new Error("Subgraph returned an error.");
  }
  const rows = data?.data?.orders_collection || [];

  return rows.map((o) => {
    const placed = Number(o.placedAt) * 1000;
    return {
      orderId: String(o.orderId),
      amount: String(o.usdcAmount), // raw 6-dec
      status: ST[Number(o.status)] || "matching",
      txHash: o.transactionHash || null,
      createdAt: new Date(placed).toISOString(),
      placedAt: Number(o.placedAt),
      completedAt: o.completedAt ? Number(o.completedAt) : null,
    };
  });
}

/**
 * Fetch a merchant's FIAT WITHDRAWALS from the subgraph.
 *
 * A fiat withdrawal is a SELL order (orderType = 1) placed by the merchant's
 * per-merchant PROXY address (not their EOA). They're indexed in the p2p.me
 * subgraph's `b2Borders` keyed by our integrator. So: pass the merchant's proxy
 * address (read on-chain via `proxyAddress(merchant)`) and we return its SELL
 * orders. No contract change, no event-log scraping needed.
 *
 * SUBGRAPH IS PROTOCOL-WIDE, NOT PER-APP: `b2Borders` indexes every integrator
 * on the protocol, and each row carries its own `integrator` id. Filtering by
 * `user` alone isn't enough to guarantee only THIS app's transactions show —
 * a proxy address collision (or a future protocol change reusing addresses
 * across integrators) would leak another integrator's orders into this
 * merchant's history. Scope explicitly to CONTRACT_ADDRESS so only orders
 * actually placed through PayQR's own integrator contract are ever returned.
 *
 * Returns rows shaped like fetchHistory but tagged kind:"withdraw":
 *   { orderId, amount(raw 6-dec USDC), kind:"withdraw", txHash, createdAt, placedAt }
 */
export async function fetchWithdrawals(proxyAddress) {
  // Same address validation as fetchHistory before interpolation into GraphQL.
  if (!proxyAddress || !isAddress(proxyAddress)) return [];
  if (!CONTRACT_ADDRESS) return [];
  const query = `query($user: String!, $integrator: String!) {
    b2Borders(
      first: 50,
      where: { user: $user, orderType: 1, integrator: $integrator },
      orderBy: blockTimestamp,
      orderDirection: desc
    ) {
      orderId
      amount
      transactionHash
      blockTimestamp
    }
  }`;
  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        variables: { user: proxyAddress.toLowerCase(), integrator: CONTRACT_ADDRESS.toLowerCase() },
      }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    // Network failure ⇒ throw, don't fake an empty list (see fetchHistory).
    throw new Error("Couldn't reach the transaction index.");
  }
  // See fetchHistory: a 200-with-errors must not masquerade as an empty list.
  if (data?.errors) {
    console.error("subgraph error (fetchWithdrawals):", data.errors);
    throw new Error("Subgraph returned an error.");
  }
  const rows = data?.data?.b2Borders || [];
  return rows.map((o) => {
    const ts = Number(o.blockTimestamp) * 1000;
    return {
      orderId: String(o.orderId),
      amount: String(o.amount), // raw 6-dec USDC
      kind: "withdraw",
      status: "withdrawn",
      txHash: o.transactionHash || null,
      createdAt: new Date(ts).toISOString(),
      placedAt: Number(o.blockTimestamp),
    };
  });
}

/**
 * Fetch a SINGLE order by id from the subgraph — powers the public,
 * no-auth customer receipt page (/receipt/[orderId]). The customer who
 * just paid can open the link and verify the sale on-chain.
 * Returns null if not found.
 *   { orderId, amount(raw 6-dec, principal the merchant nets), fiatAmount
 *     (raw 6-dec, the customer's TOTAL paid incl. any small-order fee),
 *     status, txHash, placedAt, completedAt }
 */
export async function fetchOrder(orderId) {
  // On-chain order ids are integers — reject anything else so a crafted id can't
  // reach the query as arbitrary text (defense-in-depth for the public receipt).
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  const query = `query($id: String!) {
    orders_collection(first: 1, where: { orderId: $id }) {
      orderId
      status
      usdcAmount
      fiatAmount
      actualUsdcAmount
      actualFiatAmount
      userAddress
      placedAt
      completedAt
      transactionHash
    }
  }`;
  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id } }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    return null;
  }
  // Surface a 200-with-errors so a subgraph fault is observable rather than
  // silently read as "order not found" (the receipt page already treats a null
  // here as "not ready yet / refresh", so returning null is acceptable — but we
  // log the real cause).
  if (data?.errors) console.error("subgraph error (fetchOrder):", data.errors);
  const o = data?.data?.orders_collection?.[0];
  if (!o) return null;
  // Prefer the ACTUAL settled amounts when present (post-match, e.g. a partial
  // fill) — same precedence rates.ts already uses — falling back to the
  // as-placed amounts otherwise.
  const usdcAmount = o.actualUsdcAmount && o.actualUsdcAmount !== "0" ? o.actualUsdcAmount : o.usdcAmount;
  const fiatAmount = o.actualFiatAmount && o.actualFiatAmount !== "0" ? o.actualFiatAmount : o.fiatAmount;
  return {
    orderId: String(o.orderId),
    amount: String(usdcAmount),          // principal — what the MERCHANT receives
    fiatAmount: fiatAmount != null ? String(fiatAmount) : null, // gross — what the CUSTOMER paid (incl. fee)
    status: ST[Number(o.status)] || "matching",
    userAddress: o.userAddress || null,   // the placer proxy (resolves to the merchant)
    txHash: o.transactionHash || null,
    placedAt: Number(o.placedAt),
    completedAt: o.completedAt ? Number(o.completedAt) : null,
  };
}

/**
 * Fetch a SINGLE WITHDRAWAL (fiat SELL) order by id — powers the withdrawal
 * receipt. Withdrawals are NOT in orders_collection; they're b2Borders (orderType
 * 1), keyed by the merchant's proxy in `user`, with different fields (amount /
 * blockTimestamp, and no status). A row indexed here has already emitted its
 * on-chain WithdrawalFiat, so we treat it as completed. Returns the SAME shape as
 * fetchOrder so the receipt page can consume either uniformly (userAddress = the
 * proxy, so verifyOrderOwner resolves it via proxyMerchant). null if not found.
 *
 * Scoped to CONTRACT_ADDRESS — see fetchWithdrawals for why: b2Borders is
 * protocol-wide, and an orderId a customer/merchant pastes into a receipt link
 * should never resolve to a DIFFERENT integrator's withdrawal just because the
 * id happens to match. (verifyOrderOwner in the receipt page independently
 * re-checks on-chain registration too — this is defense-in-depth, not the only
 * guard.)
 */
export async function fetchWithdrawalOrder(orderId) {
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  if (!CONTRACT_ADDRESS) return null;
  const query = `query($id: String!, $integrator: String!) {
    b2Borders(first: 1, where: { orderId: $id, orderType: 1, integrator: $integrator }) {
      orderId
      amount
      user
      transactionHash
      blockTimestamp
    }
  }`;
  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { id, integrator: CONTRACT_ADDRESS.toLowerCase() } }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    return null;
  }
  if (data?.errors) console.error("subgraph error (fetchWithdrawalOrder):", data.errors);
  const o = data?.data?.b2Borders?.[0];
  if (!o) return null;
  const ts = Number(o.blockTimestamp);
  return {
    orderId: String(o.orderId),
    amount: String(o.amount),         // raw 6-dec USDC
    status: "settled",                // indexed here ⇒ the fiat leg fired
    userAddress: o.user || null,      // the merchant's proxy → verifyOrderOwner resolves it
    txHash: o.transactionHash || null,
    placedAt: ts,
    completedAt: ts,
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
