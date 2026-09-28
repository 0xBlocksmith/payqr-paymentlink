/**
 * Payment Links — merchant creation/revocation calldata and the customer-side
 * relayer order-placement path.
 *
 * ARCHITECTURE (matches payment-integrators PR #104 — LinkRouter +
 * PaymentLinksLib): a merchant creates a shareable link (createLink, one
 * merchant-signed transaction). A walletless customer opens /pay/[linkId],
 * and PayQR's backend relayer (a Cloudflare Worker — see ../../worker/)
 * drives the payment through LinkRouter on the merchant's behalf.
 *
 * WHAT CHANGED FROM THE OLD (PRE-PR#104) DESIGN THIS FILE USED TO TARGET:
 *   - `createLink` no longer returns the linkId — the CALLER derives it via
 *     `computeLinkId(merchant, salt)` (keccak256(abi.encode(merchant, salt)))
 *     and passes it in, so the id is known before the transaction is even
 *     sent. There is no `LinkCreated` return value or reliable event to
 *     decode it from afterward.
 *   - `singleUse: bool` is gone; it's `maxUses: uint32` (0 = unlimited).
 *   - `description: string` is gone; it's `encryptedConfig: bytes` —
 *     client-side encrypted to the merchant's own relay key before it's ever
 *     passed to buildCreateLinkCalldata (see app/payment-links/create/page.tsx
 *     and lib/payoutCrypto.ts's encryptToSelf, the same ECIES primitive used
 *     for the merchant's payout handle). This file itself does no encryption
 *     — buildCreateLinkCalldata takes the ciphertext bytes as-is, so a caller
 *     that skips encrypting still CAN pass raw plaintext bytes; don't.
 *   - `getLink`'s tuple order changed to
 *     (owner, amount, currency, expiresAt, maxUses, status, uses, strikes).
 *   - The relayer is no longer a funded worker EOA calling
 *     `relayerPlaceOrder`/`relayerMarkPaid`/`relayerCancelOrder` directly.
 *     `trustedRelayer` is now the LinkRouter CONTRACT. Mark-paid and cancel
 *     require an EIP-712 signature from the CUSTOMER's own key (generated in
 *     their browser, never sent to the worker) — see markPaidTypedData /
 *     cancelTypedData below and lib/customerOrder.ts, which signs them.
 *   - `/api/pay/:linkId` now also wants `circleId` and a solved human-check
 *     challenge, and returns a `claimToken` that must be persisted and replayed
 *     on later `/api/relay-tx` calls (mark-paid/cancel) for that order.
 *
 * `registerAgent` — WIRED UP via provisionLinkWallet() below, which calls the
 * worker's `POST /api/links/:linkId/wallet` (payment-integrators PR #104,
 * worker/src/provision.ts). That endpoint mints the link's own funds-free
 * AA wallet and returns its address; the caller must then batch
 * `createLink(linkId, …)` followed by `registerAgent(linkId, account)` into
 * ONE transaction, in that exact order — `registerAgent` reads `getLink` to
 * check ownership, so `createLink` must land first WITHIN the same batch, and
 * the two must not be split into separate transactions (a merchant tx between
 * them could be front-run, or the second could simply never be sent). See
 * app/payment-links/create/page.tsx for the full sequence.
 *
 * Mirrors lib/p2p.ts's makePlaceOrder discipline: never trust a callback
 * alone for order success — wait for the transaction receipt independently
 * and decode the event yourself.
 */
import { encodeFunctionData, decodeEventLog, keccak256, encodeAbiParameters, stringToHex, type Hex, type Address, type PublicClient } from "viem";
import { INTEGRATOR_ABI, LINK_ROUTER_ABI, CONTRACT_ADDRESS, CLIENT_ADDRESS, LINK_ROUTER_ADDRESS } from "./contract";

// Trailing slash stripped: every call appends "/api/…", and a configured
// "https://relayer/" turned each of them into "//api/…" — a 404 on every call.
export const RELAYER_WORKER_URL = (process.env.NEXT_PUBLIC_RELAYER_WORKER_URL || "").replace(/\/+$/, "");
// LINK_ROUTER_ADDRESS is required here, not just for provisioning/create: the
// customer-signed mark-paid/cancel flow (linkRouterDomain in this file) throws
// without it. Without this in the gate, /pay/[linkId] rendered as fully
// enabled while mark-paid/cancel was structurally broken — a customer could
// pay, then hit a hard error tapping "I've paid" with no recovery path.
export const PAYMENT_LINKS_ENABLED = Boolean(RELAYER_WORKER_URL && CONTRACT_ADDRESS && LINK_ROUTER_ADDRESS);

// Base origin for a shareable /pay/[linkId] URL. Set NEXT_PUBLIC_PAY_BASE_URL
// (e.g. https://pay.payqr.pro) so a link created from ANY origin the merchant
// dashboard happens to be loaded from (a preview deploy, a custom domain,
// etc.) still points customers at the one canonical pay domain. Unset =
// unchanged behavior: falls back to window.location.origin, so local dev
// (http://localhost:3000) keeps working with no env var required.
export const PAY_BASE_URL = (process.env.NEXT_PUBLIC_PAY_BASE_URL || "").replace(/\/$/, "");

/** Build a payment link's public URL — see PAY_BASE_URL above for the
 *  origin's precedence. Client-only (reads window.location as the fallback),
 *  matching how both existing callers already scoped this. */
export function buildPayLinkUrl(linkId: string): string {
  const base = PAY_BASE_URL || (typeof window !== "undefined" ? window.location.origin : "");
  // Short form. /pay/<hex> still resolves for every link already shared.
  return `${base}/p/${encodeLinkId(linkId)}`;
}

export type PaymentLink = {
  owner: `0x${string}`;
  amount: bigint;
  currency: `0x${string}`;
  expiresAt: bigint;
  maxUses: number;
  status: number; // 0 = ACTIVE, 1 = REVOKED
  uses: number;
  strikes: number;
};

export const LinkStatus = { ACTIVE: 0, REVOKED: 1 } as const;

/** Page size for getMerchantLinks — arbitrary but generous; most merchants
 *  will have far fewer links than this in one page. */
const MERCHANT_LINKS_PAGE_SIZE = 200n;

/**
 * Fetches every linkId owned by `owner` via the contract's own
 * `getMerchantLinks(owner, offset, limit)` view (Option A of
 * payment-integrators/docs/proposals/merchant-link-enumeration.md) — a direct,
 * trustless read, no log-scanning, no RPC range-cap exposure.
 *
 * NOT YET DEPLOYED as of this writing: the ABI entry in lib/contract.ts is
 * speculative, matching the proposal's recommended shape (ids-only,
 * offset/limit paginated). Calling this against a contract that doesn't have
 * the function will throw — callers should catch and fall back to
 * `fetchMerchantLinkEvents` (the log-scan) until the contract dev ships this
 * and it's confirmed live on the deployed address.
 */
export async function fetchMerchantLinkIds(
  publicClient: PublicClient,
  owner: Address,
  contract: Address = CONTRACT_ADDRESS
): Promise<Hex[]> {
  const all: Hex[] = [];
  let offset = 0n;
  for (;;) {
    const page = (await publicClient.readContract({
      address: contract,
      abi: INTEGRATOR_ABI,
      functionName: "getMerchantLinks",
      args: [owner, offset, MERCHANT_LINKS_PAGE_SIZE],
    } as any)) as Hex[];
    all.push(...page);
    if (page.length < MERCHANT_LINKS_PAGE_SIZE) break;
    offset += MERCHANT_LINKS_PAGE_SIZE;
  }
  return all;
}

/**
 * Fetches the linkIds the RELAYER WORKER has indexed for `owner`.
 *
 * The worker writes a merchant→link KV entry at provisioning time, where it has
 * already verified the merchant's signature — so this is a direct lookup with
 * no log-scanning and no RPC range-cap exposure, and unlike the scan it cannot
 * quietly truncate.
 *
 * It is NOT complete on its own, and says so: the index only knows links minted
 * through the worker since it shipped, so `indexedFrom` marks where its
 * knowledge begins and the response carries `partial: true`. Callers merge
 * these ids with the other sources rather than replacing them — which is also
 * why this resolves to [] on any failure instead of throwing. A worker that is
 * down must degrade the list, not empty it.
 *
 * Ids only. Every field the UI renders still comes from `getLink` on-chain, so
 * a stale or bogus id costs a lookup and is then dropped, and the worker cannot
 * influence what a link claims to be.
 */
export async function fetchIndexedMerchantLinkIds(owner: Address): Promise<Hex[]> {
  if (!RELAYER_WORKER_URL) return [];
  const out: Hex[] = [];
  let cursor: string | null = null;
  // Bounded: the worker pages at 200, and a merchant with more than 2,000 links
  // is past what this list renders usefully anyway. Without a ceiling a
  // misbehaving cursor would loop forever.
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${RELAYER_WORKER_URL}/api/merchants/${owner}/links`);
    // Asked for explicitly: the worker's default page is 100, which made the
    // ten-page ceiling below 1,000 links rather than the 2,000 intended.
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    let body: { linkIds?: string[]; cursor?: string | null };
    try {
      const res = await fetch(url.toString());
      if (!res.ok) break;
      body = await res.json();
    } catch {
      break;
    }
    for (const id of body.linkIds ?? []) {
      if (/^0x[0-9a-fA-F]{64}$/.test(id)) out.push(id as Hex);
    }
    cursor = body.cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

// ─── Log-scan fallback ────────────────────────────────────────────────
// Everything below exists ONLY because getMerchantLinks (above) may not be
// deployed yet. Once it's live everywhere this app points at, the scan below
// — and its RPC range-cap workarounds — can be deleted along with this
// section header.

// Starting chunk size for a backward eth_getLogs scan. Different RPCs cap this
// differently — Base Sepolia's public endpoint (sepolia.base.org) allows
// ~10,000 blocks, but an Alchemy key on the FREE tier allows only 10 (its
// error names the exact allowed range). Hardcoding either number breaks on the
// other provider, so this is just the OPTIMISTIC starting point — a range
// error below shrinks it and retries rather than failing the whole scan.
const INITIAL_CHUNK_BLOCKS = 9_500n;
const MIN_CHUNK_BLOCKS = 10n;

// Hard ceiling on how many eth_getLogs calls one scan may issue. Without this,
// a narrow-range RPC (a 10-block cap turns a 200k-block lookback into ~20,000
// sequential calls) makes the BROWSER itself refuse to open more connections
// (ERR_INSUFFICIENT_RESOURCES) — this stops the scan well short of that and
// returns whatever was found, rather than crashing the tab. See
// payment-integrators/docs/proposals/merchant-link-enumeration.md for the
// real fix (an on-chain or subgraph index) this is a stopgap for.
const MAX_SCAN_REQUESTS = 400;

function isRangeLimitError(err: unknown): boolean {
  const msg = String((err as any)?.details ?? (err as any)?.shortMessage ?? (err as any)?.message ?? err);
  return /block range|10 block|range should work|limit exceeded|too many blocks/i.test(msg);
}

// Free-tier RPCs also rate-limit CONCURRENT eth_getLogs calls, separately from
// the range cap above — firing every chunk at once via Promise.all throws
// "over rate limit" well before the range error would ever trigger. Fetch
// chunks sequentially instead; a merchant's link list is not a hot path worth
// trading reliability for speed on.
async function fetchLinkCreatedEvents(
  publicClient: PublicClient,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint
) {
  return publicClient.getContractEvents({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    eventName: "LinkCreated",
    args: { owner },
    fromBlock,
    toBlock,
  } as any);
}

/**
 * Fetches every LinkCreated event for `owner`, scanning backward from the
 * chain tip. Stops at genesis or once it has looked back `maxLookbackBlocks`
 * blocks — a merchant's link history is bounded by how long this app (and
 * this specific contract deployment) has existed, so an unbounded backward
 * scan just wastes RPC calls once past it.
 *
 * Chunk size ADAPTS at runtime: it starts at INITIAL_CHUNK_BLOCKS and halves
 * (down to MIN_CHUNK_BLOCKS) whenever the RPC rejects a window as too wide,
 * re-fetching that same window at the smaller size rather than aborting the
 * whole scan — so this keeps working whether the provider allows 10,000
 * blocks per call or 10.
 *
 * STOPGAP, not a fix: on a narrow-range RPC this can still mean hundreds of
 * sequential requests, and `maxLookbackBlocks` defaults small specifically to
 * keep that bounded rather than exhausting MAX_SCAN_REQUESTS and returning an
 * incomplete list. See
 * payment-integrators/docs/proposals/merchant-link-enumeration.md for the
 * real fix (an on-chain or subgraph index) — raise this default back up once
 * that ships.
 */
export async function fetchMerchantLinkEvents(
  publicClient: PublicClient,
  owner: Address,
  maxLookbackBlocks = 2_000n
) {
  const latest = await publicClient.getBlockNumber();
  const floor = latest > maxLookbackBlocks ? latest - maxLookbackBlocks : 0n;

  const all: Awaited<ReturnType<typeof fetchLinkCreatedEvents>> = [];
  let chunk = INITIAL_CHUNK_BLOCKS;
  let to = latest;
  let requests = 0;
  while (to >= floor) {
    if (requests >= MAX_SCAN_REQUESTS) break; // return what we have rather than hang or crash the tab
    const from = to - chunk + 1n > floor ? to - chunk + 1n : floor;
    try {
      requests++;
      const events = await fetchLinkCreatedEvents(publicClient, owner, from, to);
      all.push(...events);
      if (from === floor) break;
      to = from - 1n;
    } catch (err) {
      if (chunk > MIN_CHUNK_BLOCKS && isRangeLimitError(err)) {
        chunk = chunk / 2n > MIN_CHUNK_BLOCKS ? chunk / 2n : MIN_CHUNK_BLOCKS;
        continue; // retry this same `to`, now with a narrower window
      }
      throw err;
    }
  }
  return all;
}

/** Derives the linkId the contract expects: keccak256(abi.encode(merchant,
 *  salt)). Mirrors PaymentLinksLib.computeLinkId exactly — see its own
 *  comment for why this makes ids collision-safe across merchants but NOT
 *  unguessable (Base's sequencer mempool is private, which is what makes
 *  that an accepted risk there). */
export function computeLinkId(merchant: Address, salt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [merchant, salt]));
}

/** A fresh random salt for computeLinkId. */
export function randomLinkSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

/** Build the createLink calldata for the merchant's own signer to send.
 *  `amountUsdc6` is 0 for a variable/customer-entered-amount link.
 *  `linkId` MUST come from computeLinkId(merchantAddress, salt) — the caller
 *  picks the salt (randomLinkSalt() is fine) and keeps `linkId` to read the
 *  link back afterward, since createLink no longer returns it. */
export function buildCreateLinkCalldata(params: {
  linkId: Hex;
  amountUsdc6: bigint;
  currencyCode: string;
  maxUses: number; // 0 = unlimited, 1 = old "single use"
  expiresAt: number; // unix seconds, 0 = no expiry
  encryptedConfig?: Hex; // opaque blob, e.g. client-side-encrypted description
}): Hex {
  return encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "createLink",
    args: [
      params.linkId,
      params.amountUsdc6,
      stringToHex(params.currencyCode, { size: 32 }),
      BigInt(params.expiresAt),
      params.maxUses,
      params.encryptedConfig ?? "0x",
    ],
  });
}

export function buildRevokeLinkCalldata(linkId: Hex): Hex {
  return encodeFunctionData({ abi: INTEGRATOR_ABI, functionName: "revokeLink", args: [linkId] });
}

/** Build the registerAgent calldata for the LinkRouter — the second half of
 *  the required createLink+registerAgent batch (see provisionLinkWallet
 *  below). `agent` is the account address returned by provisioning. */
export function buildRegisterAgentCalldata(linkId: Hex, agent: Address): Hex {
  return encodeFunctionData({ abi: LINK_ROUTER_ABI, functionName: "registerAgent", args: [linkId, agent] });
}

/** EIP-712 typed data for authorising a link-wallet provisioning request —
 *  matches provision.ts's verifyMerchant domain/type exactly:
 *  EIP712("P2P Merchant Terminal Admin", "1") on the INTEGRATOR address (not
 *  LinkRouter — this authorises minting against the integrator's merchant
 *  registry, unrelated to the LinkRouter domain markPaidTypedData/
 *  cancelTypedData use). `expiry` must be a unix-seconds timestamp within the
 *  worker's PROVISION_WINDOW_SECONDS (300s) of "now" or the worker rejects it
 *  — mint the signature immediately before sending, don't reuse a stale one. */
export function linkWalletTypedData(chainId: number, linkId: Hex, expiry: number) {
  return {
    domain: {
      name: "P2P Merchant Terminal Admin",
      version: "1",
      chainId,
      verifyingContract: CONTRACT_ADDRESS,
    },
    types: { LinkWallet: [{ name: "linkId", type: "bytes32" }, { name: "expiry", type: "uint256" }] },
    primaryType: "LinkWallet" as const,
    message: { linkId, expiry: BigInt(expiry) },
  } as const;
}

/** Provisioning result from the worker. `existing: true` means this link id
 *  was already minted (e.g. a retry after a dropped response) — the SAME
 *  account is returned, safe to batch createLink+registerAgent against again
 *  (registerAgent is write-once on-chain, so a genuine duplicate call there
 *  simply reverts rather than doing anything harmful). */
export type ProvisionedWallet = { linkId: Hex; account: Address; existing: boolean };

/**
 * Mint (or fetch) the link's own funds-free AA wallet from the worker —
 * `POST /api/links/:linkId/wallet` (payment-integrators PR #104,
 * worker/src/provision.ts). The worker sizes the minted key's TTL itself
 * (from the link's on-chain expiry if it already exists, unbounded if not —
 * see provision.ts's authorise()); this call passes no expiry of its own.
 * MUST be called, and its `account` batched into registerAgent, BEFORE
 * createLink is sent: the merchant app's job is to follow the ordering the
 * worker's own doc comment prescribes:
 *
 *   1. provisionLinkWallet(...)                     → { account }
 *   2. ONE batched transaction, in this order:
 *        createLink(linkId, …)
 *        registerAgent(linkId, account)
 *
 * `signTypedData` must sign with the MERCHANT's own smart-account signer —
 * the worker verifies via ERC-1271 against the signer address for a
 * contract account, so a signature from anything else (an admin EOA, e.g.)
 * is refused as "Not authorised" even though it looks valid client-side. */
export async function provisionLinkWallet(params: {
  linkId: Hex;
  chainId: number;
  signTypedData: (typedData: ReturnType<typeof linkWalletTypedData>) => Promise<Hex>;
  signerAddress: Address;
}): Promise<ProvisionedWallet> {
  if (!PAYMENT_LINKS_ENABLED) throw new Error("Payment Links isn't configured on this deployment.");

  // Inside the worker's 300 s window with room for clock skew: a phone whose
  // clock ran a minute behind used to sign an expiry the worker already
  // considered past, and the merchant got a bare "Not authorised".
  const expiry = Math.floor(Date.now() / 1000) + 240;
  const signature = await params.signTypedData(linkWalletTypedData(params.chainId, params.linkId, expiry));

  const res = await fetch(`${RELAYER_WORKER_URL}/api/links/${params.linkId}/wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signer: params.signerAddress, signature, expiry }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as any);
    throw new Error(body?.error || "Could not prepare this payment link. Please try again.");
  }
  const data = (await res.json()) as { linkId: Hex; account: Address; existing: boolean };
  if (!data?.account) throw new Error("Malformed response from the payment relayer.");
  return { linkId: data.linkId, account: data.account, existing: Boolean(data.existing) };
}

/** Read a link's on-chain state. Throws only on a genuine RPC failure —
 *  callers distinguish "doesn't exist" (owner == zero address) from a
 *  transient read error themselves, mirroring the receipt page's three-state
 *  trust model (verified / notOurs / unverified).
 *
 *  Tuple order is (owner, amount, currency, expiresAt, maxUses, status, uses,
 *  strikes) — PR #104's getLink, NOT the pre-PR#104 order this file used to
 *  assume. Decoding this with the old field order silently reads garbage
 *  (currency as an expiry timestamp, etc.) with no type error to catch it. */
export async function fetchLink(
  publicClient: any,
  linkId: Hex,
  contract: Address = CONTRACT_ADDRESS
): Promise<PaymentLink> {
  const result = (await publicClient.readContract({
    address: contract,
    abi: INTEGRATOR_ABI,
    functionName: "getLink",
    args: [linkId],
  })) as readonly [`0x${string}`, bigint, `0x${string}`, bigint, number, number, number, number];
  return {
    owner: result[0],
    amount: result[1],
    currency: result[2],
    expiresAt: result[3],
    maxUses: result[4],
    status: result[5],
    uses: result[6],
    strikes: result[7],
  };
}

export function isLinkOwnerZero(link: PaymentLink): boolean {
  return link.owner === "0x0000000000000000000000000000000000000000";
}

/** Same shape as chain.ts's linkBlockedReason on the worker, so the pay page
 *  can show the same verdict before ever hitting /api/pay. Deliberately does
 *  NOT check merchant/contract-level gates (frozen, paused, links disabled,
 *  cap) — those are caught by the worker's own simulate-before-send and
 *  surfaced via explainRevert; duplicating them here would just drift. */
export function linkBlockedReason(link: PaymentLink, nowSec: number): string | null {
  if (link.status !== LinkStatus.ACTIVE) return "This payment link has been cancelled.";
  if (link.expiresAt !== 0n && BigInt(nowSec) > link.expiresAt) return "This payment link has expired.";
  if (link.maxUses !== 0 && link.uses >= link.maxUses)
    return "This payment link has already been used the maximum number of times.";
  return null;
}

// ─── LinkRouter EIP-712 (customer-signed mark-paid / cancel) ──────────────

/** Matches LinkRouter.sol's `EIP712("P2P LinkRouter", "1")` domain exactly —
 *  a mismatch here makes ECDSA.recover() land on the wrong address and the
 *  Router reverts BadCustomerSignature(). `verifyingContract` MUST be the
 *  deployed LinkRouter address, not the integrator. */
export function linkRouterDomain(chainId: number) {
  if (!LINK_ROUTER_ADDRESS) throw new Error("NEXT_PUBLIC_LINK_ROUTER_ADDRESS is not configured.");
  return {
    name: "P2P LinkRouter",
    version: "1",
    chainId,
    verifyingContract: LINK_ROUTER_ADDRESS,
  } as const;
}

const MARK_PAID_TYPES = { MarkPaid: [{ name: "linkId", type: "bytes32" }, { name: "orderId", type: "uint256" }] } as const;
const CANCEL_TYPES = { Cancel: [{ name: "linkId", type: "bytes32" }, { name: "orderId", type: "uint256" }] } as const;

/** Typed-data payload for the customer's "I've paid" signature. Pass to
 *  viem's signTypedData with the customer's own relay private key — see
 *  lib/customerOrder.ts. */
export function markPaidTypedData(chainId: number, linkId: Hex, orderId: bigint) {
  return {
    domain: linkRouterDomain(chainId),
    types: MARK_PAID_TYPES,
    primaryType: "MarkPaid" as const,
    message: { linkId, orderId },
  };
}

/** Typed-data payload for the customer's cancel signature. */
export function cancelTypedData(chainId: number, linkId: Hex, orderId: bigint) {
  return {
    domain: linkRouterDomain(chainId),
    types: CANCEL_TYPES,
    primaryType: "Cancel" as const,
    message: { linkId, orderId },
  };
}

/**
 * Build the placeOrder callback for the CUSTOMER-facing PaymentLinkWidget.
 * Unlike makePlaceOrder (lib/p2p.ts), this NEVER calls signer.sendTransaction
 * — the customer has no wallet. It POSTs to the relayer Worker's
 * /api/pay/:linkId, which reads the link fresh from chain itself, drives the
 * payment through LinkRouter as the link's own (funds-free) AA wallet, and
 * returns {orderId, txHash, claimToken}. `claimToken` must be persisted by
 * the caller (see useLinkClaim below) and replayed on /api/relay-tx for this
 * order — without it, mark-paid/cancel are refused.
 *
 * getHumanSolution is required once the relayer has the gate enabled
 * (REQUIRE_HUMAN_CHECK=true in production). It fetches a signed puzzle from
 * /api/challenge and solves it — see components/HumanCheck.tsx. A solution is
 * single-use, so it is solved per call rather than cached.
 */
export function makeRelayerPlaceOrder({
  linkId,
  publicClient,
  quantity,
  circleId,
  getIdentity,
  getHumanSolution,
}: {
  linkId: Hex;
  publicClient: any;
  /** Product-2 units, which for this integrator IS the 6-dec USDC amount
   *  exactly (unit price is one 6-dec unit) — the same identity /qr relies on.
   *  Ignored server-side for a fixed-amount link, which re-derives it from the
   *  link's own on-chain amount; required for a variable-amount link. */
  quantity: bigint;
  circleId?: number;
  getIdentity: () => Promise<{ publicKey: string } | null>;
  getHumanSolution?: () => Promise<{ challenge: string; nonce: string } | null>;
}) {
  return async () => {
    if (!PAYMENT_LINKS_ENABLED) {
      throw new Error("Payment Links isn't configured on this deployment.");
    }
    const identity = await getIdentity();
    if (!identity?.publicKey) throw new Error("relay identity missing");

    // The customer's relay pubkey, sent in the SDK's OWN spelling: 128 hex
    // characters, no `04` tag.
    //
    // This field used to be the one thing that made a link payment impossible
    // to complete, because two consumers of it disagreed. The worker demanded
    // the tagged form (it derives the customer's address from the key, and that
    // derivation needs the tag); the LP's encryption demands the untagged form
    // (@p2pdotme/sdk's encryptWithPublicKey re-adds `04` itself, so a tagged
    // key becomes `0404…`, which is not a point, and encryption fails). Sending
    // the tagged form satisfied the worker and left every order placeable and
    // then permanently unpayable — the LP could never deliver payment details.
    //
    // The worker now normalises: it accepts either spelling, derives from the
    // tagged form, and writes the UNTAGGED form on-chain (worker/src/pay.ts).
    // So this sends what the SDK produces, unchanged — the same spelling
    // lib/p2p.ts's makePlaceOrder has always sent on the merchant BUY path,
    // which is the path that already worked.
    const pubKey = identity.publicKey.startsWith("0x")
      ? identity.publicKey.slice(2)
      : identity.publicKey;

    // The worker parses `quantity` with Number() then BigInt(), so it must
    // cross the wire as a JSON number in the safe-integer range. Anything
    // larger would silently round to a DIFFERENT order value rather than being
    // rejected — refuse it here instead of placing a wrong-amount order.
    if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("That amount is too large to process.");
    }

    // Solved fresh, never cached: the relayer spends a solution once, so a
    // reused one is rejected as a replay — which would read as a broken page
    // rather than a spent token.
    const human = await getHumanSolution?.();

    const res = await fetch(`${RELAYER_WORKER_URL}/api/pay/${linkId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quantity: Number(quantity),
        pubKey,
        circleId,
        challenge: human?.challenge,
        nonce: human?.nonce,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      // The relayer stopped waiting for the outcome, but the payment was SENT
      // and may well land. It hands back the claim token and a reference to
      // follow it up with (GET /api/pay/status/<reference>). Keep both: this
      // used to be thrown away as an ordinary error, so the order landed with
      // no claim — the customer could never mark it paid or cancel it — and
      // the Pay button came back, inviting a second order.
      if (res.status === 502 && body?.pending === true && typeof body?.reference === "string") {
        const resumable = typeof body.claimToken === "string" && body.claimToken.length > 0;
        if (resumable) {
          savePendingPayment(linkId, { reference: body.reference, claimToken: body.claimToken, at: Date.now() });
        }
        throw new PaymentPendingError(
          body?.error || "Your payment is still being confirmed.",
          body.reference,
          resumable
        );
      }
      // A failed send can still carry the operation hash; support needs it to
      // trace a payment the customer is unsure about.
      const ref = typeof body?.reference === "string" ? ` Reference: ${body.reference}` : "";
      throw new Error((body?.error || "Order placement failed. Please try again.") + ref);
    }
    const { orderId, txHash, claimToken } = (await res.json()) as {
      orderId: string;
      txHash: Hex;
      claimToken?: string;
    };
    if (!orderId || !txHash) throw new Error("Malformed response from the payment relayer.");

    // Persist the claim token BEFORE the on-chain re-verification below. The
    // order already exists at this point — the worker only returns an orderId
    // once the user operation reported success — so a throw from the receipt
    // wait must not strand the customer without the one credential that lets
    // them mark it paid or cancel it. Storing late meant a slow bundler (or a
    // userOpHash in `txHash`, see below) permanently orphaned a real order.
    if (claimToken) storeLinkClaim(orderId, claimToken);

    // Never trust the Worker's word alone — re-verify independently, exactly
    // like makePlaceOrder does for the merchant-signed /qr flow.
    //
    // `txHash` is the bundler's real transaction hash in the normal case, but
    // handlePay falls back to `userOpHash` when the receipt was unavailable on
    // its side. A userOpHash is NOT a transaction hash, so waiting on it would
    // block until timeout rather than failing usefully — bound the wait and
    // treat a miss as unverified-but-placed rather than as a failure, since
    // the order does exist.
    let confirmedOrderId: string | null = null;
    try {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 30_000 });
      if (receipt.status === "reverted") throw new Error("The order transaction reverted.");

      for (const log of receipt.logs) {
        try {
          const ev: any = decodeEventLog({ abi: INTEGRATOR_ABI, data: log.data, topics: log.topics });
          // Match the linkId too: one bundled transaction can carry several
          // links' operations, and taking the first LinkOrderPlaced would hand
          // this customer a neighbour's order id.
          if (
            ev.eventName === "LinkOrderPlaced" &&
            String(ev.args.linkId).toLowerCase() === linkId.toLowerCase()
          ) {
            confirmedOrderId = ev.args.orderId.toString();
            break;
          }
        } catch {
          // not our event — skip
        }
      }
      if (confirmedOrderId && confirmedOrderId !== String(orderId)) {
        // The chain disagrees with the worker about which order this is —
        // that is a real integrity failure, not a slow receipt. The claim
        // token above is already stored, but keyed under the WORKER's id —
        // mirror it under the id the CHAIN says is real before throwing, so
        // whichever id ends up driving mark-paid/cancel later, getLinkClaim
        // can still find it instead of stranding the customer on an order
        // that demonstrably exists.
        if (claimToken) storeLinkClaim(confirmedOrderId, claimToken);
        throw new Error("Could not verify the order on-chain.");
      }
    } catch (e: any) {
      // A reverted transaction or a genuine mismatch is fatal; a timeout on a
      // hash we could not resolve is not — the order is already placed and the
      // widget polls its real status from the Diamond either way.
      if (/reverted|verify the order/i.test(String(e?.message))) throw e;
    }

    return { orderId: confirmedOrderId ?? String(orderId), txHash };
  };
}

// ─── A payment that was still confirming ──────────────────────────────────
//
// When /api/pay stops waiting before the outcome is known, the order may still
// land. The relayer returns the claim token (minted before sending) and the
// operation hash as a `reference`; once the order lands, GET
// /api/pay/status/<reference> binds that same token to the real order id. Kept
// in the customer's own browser, per link, so a reload resumes instead of
// showing the Pay button again. Dropped after 24 h, when the relayer forgets it.

export class PaymentPendingError extends Error {
  constructor(
    message: string,
    readonly reference: string,
    /** True when a claim token came back, so the payment can be followed up. */
    readonly resumable: boolean
  ) {
    super(message);
    this.name = "PaymentPendingError";
  }
}

const PENDING_KEY_PREFIX = "payqr.linkPending:";
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
type PendingPayment = { reference: string; claimToken: string; at: number };

function savePendingPayment(linkId: string, p: PendingPayment) {
  try {
    localStorage.setItem(`${PENDING_KEY_PREFIX}${linkId.toLowerCase()}`, JSON.stringify(p));
  } catch {
    /* best-effort: without it the page cannot resume after a reload */
  }
}

export function clearPendingPayment(linkId: string) {
  try {
    localStorage.removeItem(`${PENDING_KEY_PREFIX}${linkId.toLowerCase()}`);
  } catch {
    /* nothing to clear */
  }
}

/** The payment for this link that is still confirming, if any. */
export function getPendingPayment(linkId: string): PendingPayment | null {
  try {
    const raw = localStorage.getItem(`${PENDING_KEY_PREFIX}${linkId.toLowerCase()}`);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingPayment>;
    if (
      typeof p?.reference !== "string" ||
      typeof p?.claimToken !== "string" ||
      typeof p?.at !== "number" ||
      Date.now() - p.at > PENDING_TTL_MS
    ) {
      clearPendingPayment(linkId);
      return null;
    }
    return p as PendingPayment;
  } catch {
    return null;
  }
}

/**
 * Follows a pending payment until the relayer knows its outcome. Resolves with
 * the order id (and stores the claim under it, so "I've paid" and cancel work
 * exactly as for a payment that confirmed at once); throws when it failed or
 * cannot be found.
 *
 * Paced for the relayer's limits: at most 12 status checks an hour per
 * reference, and 10 a minute shared with /api/pay and /api/relay-tx. Most
 * payments resolve within the first minute or two.
 */
export async function resolvePendingPayment(
  linkId: string,
  opts: { isCancelled?: () => boolean } = {}
): Promise<string> {
  const pending = getPendingPayment(linkId);
  if (!pending) throw new Error("There is no payment waiting to be confirmed.");
  const DELAYS = [10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000];
  const support = `Please contact support with this reference: ${pending.reference}`;
  for (let attempt = 0; ; attempt++) {
    if (opts.isCancelled?.()) throw new Error("stopped");
    let wait = DELAYS[Math.min(attempt, DELAYS.length - 1)];
    try {
      const res = await fetch(`${RELAYER_WORKER_URL}/api/pay/status/${pending.reference}`);
      const body = await res.json().catch(() => ({}) as any);
      if (res.ok && body?.status === "placed" && body?.orderId) {
        storeLinkClaim(String(body.orderId), pending.claimToken);
        clearPendingPayment(linkId);
        return String(body.orderId);
      }
      if (res.ok && body?.status === "failed") {
        // Nothing was placed, so paying again is safe.
        clearPendingPayment(linkId);
        throw new PaymentFollowUpError(body?.error || "The payment could not be completed. Please try again.");
      }
      if (res.status === 404 || res.status === 400) {
        clearPendingPayment(linkId);
        throw new PaymentFollowUpError(`We couldn't find this payment. ${support}`);
      }
      if (res.status === 429) wait = Math.max(wait, 600_000);
      // "pending", or the relayer is busy or down: ask again later.
    } catch (e) {
      if (e instanceof PaymentFollowUpError) throw e;
      /* network error: ask again later */
    }
    if (Date.now() - pending.at > PENDING_TTL_MS) {
      clearPendingPayment(linkId);
      throw new PaymentFollowUpError(`This payment could not be confirmed. ${support}`);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** A definitive answer about a pending payment (failed, or not found). */
export class PaymentFollowUpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentFollowUpError";
  }
}

// ─── Claim token storage ───────────────────────────────────────────────────
//
// The worker's /api/relay-tx binds mark-paid/cancel to "the browser that
// placed the order" via this opaque token, minted at placement time and
// required on every later relay-tx call for that order (see
// worker/src/relayTx.ts's verifyClaim). It's per-order, not per-link, so it's
// keyed by orderId in the customer's own localStorage — the same browser
// storage scope as their relay identity keypair.

const CLAIM_KEY_PREFIX = "payqr.linkClaim:";

function storeLinkClaim(orderId: string, claimToken: string) {
  try {
    localStorage.setItem(`${CLAIM_KEY_PREFIX}${orderId}`, claimToken);
  } catch {
    // best-effort — a missing claim token just makes mark-paid/cancel fail
    // with a clear "session no longer valid" message instead of silently
    // corrupting anything
  }
}

export function getLinkClaim(orderId: string): string | null {
  try {
    return localStorage.getItem(`${CLAIM_KEY_PREFIX}${orderId}`);
  } catch {
    return null;
  }
}

export { CONTRACT_ADDRESS, CLIENT_ADDRESS };

// ─── Local index of links this device created ─────────────────────────────
//
// Finding a merchant's own links should not require archaeology, but it does:
// `getMerchantLinks` is not deployed on every integrator, so the list page
// falls back to scanning `LinkCreated` logs. That scan is bounded by the RPC —
// Alchemy's free tier caps `eth_getLogs` at TEN blocks, so the adaptive
// chunking collapses to the minimum and MAX_SCAN_REQUESTS runs out after about
// 4,000 blocks. On Base that is roughly two hours of history, after which a
// merchant's links simply vanish from their own list.
//
// So we remember the ids. This is an INDEX, not a cache of link data: every
// field still comes from `getLink` on-chain, so a link revoked from another
// device still shows as revoked here, and an id invented locally shows as
// nothing at all. Losing this storage costs discoverability on this device,
// never correctness — and the log scan still runs underneath for links created
// elsewhere.
const CREATED_KEY_PREFIX = "payqr.myLinks:"; // + lowercased merchant address

function createdKey(merchant: string): string {
  return CREATED_KEY_PREFIX + merchant.toLowerCase();
}

/** Record a link this merchant just created on this device. */
export function rememberLink(merchant: Address, linkId: Hex): void {
  try {
    const existing = rememberedLinks(merchant);
    if (existing.includes(linkId)) return;
    localStorage.setItem(createdKey(merchant), JSON.stringify([...existing, linkId]));
  } catch {
    // Storage unavailable (private window, quota). The log scan is still there,
    // so this degrades discoverability rather than breaking anything.
  }
}

/** Link ids this merchant created on this device, oldest first. */
export function rememberedLinks(merchant?: Address | string): Hex[] {
  if (!merchant) return [];
  try {
    const raw = localStorage.getItem(createdKey(String(merchant)));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Only well-formed ids survive: a corrupt entry must not become a getLink
    // call that throws and blanks the whole list.
    return Array.isArray(parsed)
      ? parsed.filter((v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v))
      : [];
  } catch {
    return [];
  }
}

// ─── Short link encoding ──────────────────────────────────────────────────
//
// A linkId is a 32-byte keccak hash, and all 32 bytes are load-bearing: the
// pay page reads the link straight off the chain with it, so nothing can be
// truncated without losing the ability to find the link at all.
//
// What CAN change is the alphabet. Hex spends two characters per byte and uses
// only 16 of the 64 characters a URL path allows, so "0x" + 64 hex is 66
// characters for 32 bytes of information. base64url carries the same 32 bytes
// in 43, with no padding and nothing that needs escaping in a URL or a QR.
// Together with the shorter /p/ route that takes a shared link from ~92
// characters to ~67 — the difference between a QR that scans cleanly across a
// counter and one that does not.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** 0x-hex linkId -> 43-character base64url. */
export function encodeLinkId(linkId: string): string {
  const hex = linkId.startsWith("0x") ? linkId.slice(2) : linkId;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return linkId; // not an id — hand it back
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chunk = [B64[(n >> 18) & 63], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]];
    // Drop the characters that encode bytes past the end rather than padding
    // with "=", which would need escaping in a URL.
    const keep = i + 3 <= bytes.length ? 4 : bytes.length - i + 1;
    out += chunk.slice(0, keep).join("");
  }
  return out;
}

/**
 * Either spelling -> canonical 0x-hex, or "" if it is neither.
 *
 * Accepting both is not politeness: every link already shared points at the hex
 * form, and those must keep working forever — a payment link can be printed on
 * a poster. Returning "" for anything else is what makes a mistyped or tampered
 * URL fail closed as "this link doesn't exist" rather than being half-read.
 */
export function decodeLinkId(input: string): Hex | "" {
  const raw = String(input || "").trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase() as Hex;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return `0x${raw.toLowerCase()}` as Hex;
  if (!/^[A-Za-z0-9\-_]{43}$/.test(raw)) return "";
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of raw) {
    const v = B64.indexOf(ch);
    if (v < 0) return "";
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  if (bytes.length !== 32) return "";
  return `0x${bytes.map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
