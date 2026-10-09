import { parseAbi, toFunctionSelector } from "viem";

export const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
export const CLIENT_ADDRESS = process.env.NEXT_PUBLIC_CLIENT_ADDRESS as `0x${string}`;

// PREVIOUS integrator addresses — every earlier contract a merchant may still
// hold a balance on. Funds and records live together in each integrator, so an
// upgrade never migrates money: the old contract keeps paying out, and its locked
// buckets unlock on their normal schedule. The app therefore has to keep READING
// every old contract, or a merchant's balance there becomes invisible in-app.
//
// Comma-separated, newest first, so each upgrade just PREPENDS the address being
// replaced and nothing earlier is ever dropped:
//   NEXT_PUBLIC_PREV_CONTRACT_ADDRESSES=0xNewestOld,0xOlder,0xOldest
// The single-address NEXT_PUBLIC_PREV_CONTRACT_ADDRESS is still honoured (merged
// in), so existing deployments keep working unchanged.
//
// Invalid entries, duplicates and the CURRENT address are dropped. Empty = the
// whole "previous terminal" feature is dormant: no calls, nothing rendered.
function parsePrevAddresses(): `0x${string}`[] {
  const raw = [
    process.env.NEXT_PUBLIC_PREV_CONTRACT_ADDRESSES || "",
    process.env.NEXT_PUBLIC_PREV_CONTRACT_ADDRESS || "",
  ].join(",");
  const current = (CONTRACT_ADDRESS || "").toLowerCase();
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const part of raw.split(",")) {
    const a = part.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) continue;
    const k = a.toLowerCase();
    if (k === current || seen.has(k)) continue;
    seen.add(k);
    out.push(a as `0x${string}`);
  }
  return out;
}
export const PREV_CONTRACT_ADDRESSES = parsePrevAddresses();

/**
 * The current integrator followed by every previous one — the scope for
 * anything HISTORICAL (orders, withdrawals, link sales, receipts). A contract
 * upgrade must never make a merchant's past disappear, so history reads span
 * all of them while new activity only ever goes to CONTRACT_ADDRESS.
 */
export const ALL_CONTRACT_ADDRESSES: `0x${string}`[] = [
  ...(/^0x[0-9a-fA-F]{40}$/.test(CONTRACT_ADDRESS || "") ? [CONTRACT_ADDRESS] : []),
  ...PREV_CONTRACT_ADDRESSES,
];

/** True when `addr` is one of the previous (retired) integrators. */
export function isPrevContract(addr: string | null | undefined): boolean {
  const a = (addr || "").toLowerCase();
  return PREV_CONTRACT_ADDRESSES.some((p) => p.toLowerCase() === a);
}

/**
 * Minimal reads that decode the SAME way on every integrator version. The full
 * INTEGRATOR_ABI tracks the newest contract: getMerchantInfo returns 6 values
 * there but 5 on the oldest deployment, so decoding an old contract with it
 * fails. `registered` and the leading fields of the `merchants` getter have
 * never changed shape.
 */
export const CROSS_VERSION_ABI = parseAbi([
  "function registered(address) view returns (bool)",
  "function merchants(address) view returns (address merchantAddr, bytes encPayoutId, string shopName)",
  "function proxyAddress(address user) view returns (address)",
  "function proxyMerchant(address proxy) view returns (address)",
  "function orderToLink(uint256 orderId) view returns (bytes32)",
  "function getMerchantLinks(address owner, uint256 offset, uint256 limit) view returns (bytes32[])",
  "function getLink(bytes32 linkId) view returns (address owner, uint96 amount, bytes32 currency, uint64 expiresAt, uint32 maxUses, uint8 status, uint32 uses, uint16 strikes)",
  "function revokeLink(bytes32 linkId)",
]);
/** The most recent previous contract, or "" — kept for older call sites. */
export const PREV_CONTRACT_ADDRESS = (PREV_CONTRACT_ADDRESSES[0] ?? "") as `0x${string}` | "";
/** True when at least one valid, distinct previous integrator is configured. */
export const HAS_PREV_CONTRACT = PREV_CONTRACT_ADDRESSES.length > 0;

// ABI of the deployed multi-currency MerchantTerminalIntegrator (v13,
// INTERNAL CUSTODY — the integrator holds merchant USDC itself; no vault).
// Signatures match the deployed bytecode exactly:
//   • payout handle is ENCRYPTED `bytes` (client-side ECIES), never plaintext
//   • registerMerchant takes the currency CODE as a 3rd arg
//   • getMerchantInfo returns 6 values (currency included; [0] is encrypted
//     bytes, [5] is the required bytes32 businessSector)
//   • MULTI-OWNER: no owner(); use isOwner()/ownerCount()/superAdmin()
//   • fiat withdrawal is withdrawFiat / withdrawFiatIn (no INR-pinned names)
//   • deliverFiatPayout is the second-step poke (was deliverInrUpi)
// IMPORTANT: NEXT_PUBLIC_CONTRACT_ADDRESS must point at a v12+-shaped contract —
// these signatures will revert on the old plaintext/single-owner integrator.
export const INTEGRATOR_ABI = parseAbi([
  // payoutId is an ENCRYPTED bytes blob (client-side encrypted to the merchant's
  // relay key — see lib/payoutCrypto.ts). The raw UPI/PIX handle is never on-chain
  // in plaintext. Pass encrypted bytes here, not a string.
  // businessSector is REQUIRED, and is a bytes32 rather than a string: the
  // integrator is at the EIP-170 ceiling and a dynamic string cost ~550 bytes of
  // bytecode across the storage write, the generated getter and the event. 31
  // characters covers any real label. Encode with viem's
  // `stringToHex(label, { size: 32 })`, decode with `hexToString(v, { size: 32 })`.
  "function registerMerchant(bytes encPayoutId, string shopName, string currencyCode, bytes32 businessSector)",
  "function registerMerchantRaw(bytes encPayoutId, string shopName, bytes32 currency, bytes32 businessSector)",
  // Carry a merchant over from a previous integrator (no re-registration).
  "function importMerchant(address merchant) returns (bool)",
  "function updateProfile(bytes encPayoutId, string shopName, bytes32 businessSector)",
  "function registered(address) view returns (bool)",
  "function userPlaceOrder(address client, uint256 productId, uint256 quantity, bytes32 currency, uint256 circleId, string pubKey) returns (uint256)",
  "function withdrawFiat(uint256 amount, uint256 circleId, string pubKey, string payoutOverride) returns (uint256)",
  "function withdrawFiatIn(uint256 amount, uint256 circleId, bytes32 currency, string pubKey) returns (uint256)",
  "function deliverFiatPayout(uint256 orderId, string encPayout)",
  "function reconcileWithdrawal(uint256 orderId)",
  "function withdrawUSDC(uint256 amount)",
  "function getMerchantBalance(address merchant) view returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)",
  // Six values now — businessSector was appended. Every existing caller indexes
  // positionally into [0]..[4], so adding a trailing field is additive and none
  // of them need to change.
  "function getMerchantInfo(address merchant) view returns (bytes encPayoutId, string shopName, bytes32 currency, bool isRegistered, bool isFrozen, bytes32 businessSector)",
  "function getMerchantBuckets(address merchant) view returns ((uint256 amount, uint256 unlockTimestamp)[])",
  "function getDailyTxInfo(address merchant) view returns (uint256 usedToday, uint256 limit)",
  "function getMerchantCurrency(address merchant) view returns (string)",
  "function perTxCap(bytes32 currency) view returns (uint256)",
  "function setPerTxCap(bytes32 currency, uint256 cap)",
  "function dailyLimit() view returns (uint256)",
  "function setDailyLimit(uint256 newLimit)",
  "function freezeMerchant(address merchant)",
  "function unfreezeMerchant(address merchant)",
  // MULTI-OWNER: there is NO owner() on this contract — ownership is a SET. Check
  // membership with isOwner(address); ownerCount() is its size; superAdmin() is the
  // single unremovable root. (A single-owner owner() call REVERTS here.)
  "function isOwner(address) view returns (bool)",
  "function ownerCount() view returns (uint256)",
  "function superAdmin() view returns (address)",
  "function admins(address) view returns (bool)",
  "function isAdmin(address who) view returns (bool)",
  // Role-based access control, 5 HIERARCHICAL tiers (0=NONE, 1=VIEWER, 2=SUPPORT,
  // 3=MANAGER, 4=FINANCE): VIEWER=read-only, SUPPORT=+freeze/unfreeze,
  // MANAGER=+set limits INSIDE the range, FINANCE=+recover stuck withdrawals.
  // Owners set the range (only the super-admin may RAISE a max); the
  // super-admin alone sets roles, owners and the trusted relayer. Every OWNER
  // is above all tiers (reads as 4) — gate owner-only UI on isOwner(addr), NOT
  // roleOf==4 (a Finance admin also reads 4 but is not an owner).
  "function adminRole(address) view returns (uint8)",
  "function roleOf(address who) view returns (uint8)",
  "function isManager(address who) view returns (bool)",
  "function isFinance(address who) view returns (bool)",
  "function setRole(address who, uint8 role)",
  "function setTrustedRelayer(address relayer)",
  "function adminAbortWithdrawal(uint256 orderId)",
  "function adminForceSettle(uint256 orderId)",
  // Wedged-order recovery for a PAID withdrawal the Diamond never terminalises:
  // forceUnwedge sweeps a landed proxy refund (settles only when full), abandon
  // force-closes a confirmed never-refund so the merchant's channel is freed.
  // Both are frozen-gated FINANCE tools — the withdraw page only needs them in
  // the ABI so a revert decodes cleanly if one is ever surfaced.
  "function adminForceUnwedge(uint256 orderId)",
  "function adminForceAbandonWedge(uint256 orderId)",
  // Frees the in-flight slot after a SUCCESSFUL (COMPLETED) fiat withdrawal.
  // Distinct from reconcileWithdrawal (which is for CANCELLED orders) — the
  // Cashout widget's reconcile callback must branch on the order status.
  "function finalizeWithdrawal(uint256 orderId)",
  // Recover a COMPLETED BUY whose onOrderComplete callback reverted, leaving the
  // customer's USDC stranded on the merchant proxy uncredited (audit Finding 1).
  // Callable by the merchant/owner/relayer; sweeps the proxy into custody and
  // credits the merchant (capped at the order amount, re-locked). `orderCompleted`
  // is the "was this BUY credited?" flag. No page calls these yet — they're in
  // the ABI so ops scripts/console can use them and any revert decodes cleanly.
  "function sweepStrandedBuy(uint256 orderId)",
  "function orderCompleted(uint256 orderId) view returns (bool)",
  // Settlement lock is admin-tunable per currency (no redeploy). lockPeriod is
  // the EFFECTIVE hold (seconds) for a currency. Pages derive maturity from the
  // actual bucket unlockTimestamps instead of this — kept for ABI completeness.
  "function lockPeriod(bytes32 currency) view returns (uint256)",
  "function settlementPeriod() view returns (uint256)",
  // Break-glass pause: when true, userPlaceOrder + every withdrawal revert
  // Paused() — which friendlyError() maps to a calm maintenance message.
  "function paused() view returns (bool)",
  "function proxyAddress(address user) view returns (address)",
  // Public `merchants` struct getter — the dynamic buckets array is omitted, so
  // this returns the scalar fields in order; index 8 is inFlightWithdrawals (the
  // count of unsettled SELL withdrawals — a new fiat withdraw reverts
  // WithdrawalInFlight while this is > 0). Used to warn + offer recovery. Index 9
  // (frozenAt) was appended for the dormant-account escheat clock; earlier
  // positions are unchanged so this stays backward-compatible.
  "function merchants(address) view returns (address merchantAddr, bytes encPayoutId, string shopName, bytes32 currency, uint256 totalDeposited, bool isFrozen, uint256 dailyTxCount, uint256 lastTxDate, uint256 inFlightWithdrawals, uint256 frozenAt)",
  // proxy => the merchant EOA it was deployed for. Used by the public receipt to
  // resolve a SELL/withdrawal order's placer (a per-merchant proxy) back to the
  // registered merchant. MUST be present or the receipt ownership check throws
  // and fails open for every proxy-placed order.
  "function proxyMerchant(address proxy) view returns (address)",
  "event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount)",
  // CRITICAL: CashoutWidget parses the SELL orderId from this event after
  // withdrawFiat — without it in the ABI, decodeEventLog can never match it and
  // every fiat cash-out dies AFTER the funds were committed on-chain.
  "event WithdrawalFiat(address indexed merchant, uint256 indexed orderId, bytes32 currency, uint256 amount)",
  "event WithdrawalUSDC(address indexed merchant, uint256 amount)",
  "event WithdrawalReconciled(address indexed merchant, uint256 indexed orderId, uint256 amount)",
  "event MerchantFrozen(address indexed merchant)",
  "event MerchantUnfrozen(address indexed merchant)",
  // Custom ERRORS — every one the contract can revert with. Without these in the
  // ABI, viem can't decode a revert and shows a raw hex signature (e.g. the
  // "0x10cbb591 not found on ABI" = WithdrawalInFlight the user hit). With them,
  // errorName() below maps each to a clear, human message.
  "error AlreadyRegistered()",
  "error DailyLimitReached()",
  "error ExceedsPerTxCap()",
  "error FieldTooLong()",
  "error FiatAlreadyDelivered()",
  "error InsufficientAvailableBalance()",
  "error InvalidAddress()",
  "error InvalidCircle()",
  "error InvalidCurrency()",
  "error InvalidQuantity()",
  "error MerchantIsFrozen()",
  "error NotAuthorized(uint8 required, uint8 actual)",
  "error NotRegistered()",
  "error NothingToWithdraw()",
  "error OfframpFeeNotReady()",
  "error OfframpInsufficientPool()",
  "error OnlyDiamond()",
  "error OnlyOwner()",
  "error OnlySuperAdmin()",
  "error ProductNotFound()",
  "error Reentrancy()",
  "error UnknownWithdrawal()",
  "error WithdrawalAlreadySettled()",
  "error WithdrawalInFlight()",
  "error WithdrawalNotCancellable()",
  "error WithdrawalNotFound()",
  // Break-glass pause + settlement-lock guards (added this contract rev).
  "error Paused()",
  "error PauseUnchanged()",
  "error InvalidLockPeriod()",
  // Dormant-account escheat guards (super-admin, 90-day continuous freeze).
  "error NotEscheatable()",
  "error NothingToEscheat()",
  // Admin/RBAC + recovery guards (no page calls these paths directly, but the
  // withdraw page's owner-recovery CAN surface them — keep them decodable).
  "error CannotRemoveSuperAdmin()",
  "error LastOwner()",
  "error MerchantNotFrozen()",
  "error NothingToSkim()",
  "error HandoffExpired()",
  // Payment Links — matches payment-integrators PR #104
  // (LinkRouter + PaymentLinksLib). `linkId` is now caller-supplied (derived
  // via computeLinkId(merchant, salt) — see lib/paymentLinks.ts), createLink
  // returns nothing, and encryptedConfig replaces the old plaintext
  // `description` string. getLink's tuple order is
  // (owner, amount, currency, expiresAt, maxUses, status, uses, strikes) —
  // NOT the order the pre-PR#104 contract used; decode carefully.
  "function createLink(bytes32 linkId, uint96 amount, bytes32 currency, uint64 expiresAt, uint32 maxUses, bytes encryptedConfig)",
  "function revokeLink(bytes32 linkId)",
  "function resetLinkStrikes(bytes32 linkId)",
  "function getLink(bytes32 linkId) view returns (address owner, uint96 amount, bytes32 currency, uint64 expiresAt, uint32 maxUses, uint8 status, uint32 uses, uint16 strikes)",
  "function isLinkActive(bytes32 linkId) view returns (bool)",
  // The reverse lookup the `links` mapping cannot do — see
  // payment-integrators/docs/proposals/merchant-link-enumeration.md (Option A).
  // NOW DEPLOYED, so this is no longer speculative. Ids-only and paginated,
  // because the array is append-only and unbounded and returning it whole would
  // run out of gas for exactly the merchants with the most links.
  //
  // An OLD integrator still lacks it and will throw, so callers keep the
  // fallbacks (the worker index, the log-scan) rather than relying on this
  // alone — which also covers a frontend pointed at the previous deployment.
  "function getMerchantLinks(address owner, uint256 offset, uint256 limit) view returns (bytes32[] memory)",
  "function linkOrdersEnabled() view returns (bool)",
  "function perTxCap(bytes32 currency) view returns (uint256)",
  "function orderToLink(uint256 orderId) view returns (bytes32)",
  // Relayer entry points are now only callable by `trustedRelayer`, which PR
  // #104 sets to the LinkRouter contract — never a worker-held EOA. Kept here
  // only for ABI/error-decoding completeness; the frontend never calls these
  // directly (see lib/paymentLinks.ts / LINK_ROUTER_ABI below).
  "function relayerPlaceOrder(bytes32 linkId, address client, uint256 productId, uint256 quantity, bytes32 currency, uint256 circleId, string pubKey) returns (uint256 orderId)",
  "function relayerMarkPaid(bytes32 linkId, uint256 orderId)",
  "function relayerCancelOrder(bytes32 linkId, uint256 orderId)",
  "event LinkCreated(bytes32 indexed linkId, address indexed owner, uint96 amount, bytes32 currency, uint64 expiresAt, uint32 maxUses, bytes encryptedConfig)",
  "event LinkRevoked(bytes32 indexed linkId, address indexed revokedBy)",
  "event LinkStrikesReset(bytes32 indexed linkId, uint16 clearedCount)",
  "event LinkOrderPlaced(bytes32 indexed linkId, uint256 indexed orderId, address indexed merchant, uint256 amount)",
  "event LinkOrdersEnabledSet(bool enabled)",
  "event LinkOrderPaid(bytes32 indexed linkId, uint256 indexed orderId)",
  "event LinkOrderCancelled(bytes32 indexed linkId, uint256 indexed orderId)",
  "error LinkExists()",
  "error LinkNotFound()",
  "error LinkNotActive()",
  "error LinkExpired()",
  "error LinkAlreadyUsed()",
  "error LinkAmountMismatch()",
  "error LinkOrdersDisabled()",
  "error OnlyTrustedRelayer()",
  "error NotRegistered()",
  "error MerchantIsFrozen()",
  "error InvalidCurrency()",
  "error ExceedsPerTxCap()",
]);

/**
 * LinkRouter — the integrator's `trustedRelayer` (payment-integrators PR
 * #104), replacing the old funded relayer EOA. The customer's browser signs
 * EIP-712 `MarkPaid`/`Cancel` digests against THIS contract (see
 * lib/customerOrder.ts); the worker only ever relays that signature, and
 * cannot advance or cancel a payment on its own. See lib/paymentLinks.ts for
 * the domain/typehash constants used to build those digests client-side.
 */
export const LINK_ROUTER_ADDRESS = process.env.NEXT_PUBLIC_LINK_ROUTER_ADDRESS as
  | `0x${string}`
  | undefined;

export const LINK_ROUTER_ABI = parseAbi([
  "function registerAgent(bytes32 linkId, address agent)",
  "function place(bytes32 linkId, address client, uint256 productId, uint256 quantity, bytes32 currency, uint256 circleId, string pubKey, address customer) returns (uint256 orderId)",
  "function markPaid(bytes32 linkId, uint256 orderId, bytes signature)",
  "function cancel(bytes32 linkId, uint256 orderId, bytes signature)",
  "function linkAgent(bytes32 linkId) view returns (address)",
  "function orderCustomer(uint256 orderId) view returns (address)",
  // Kept for good (unlike the integrator's orderToLink, deleted on complete and
  // cancel): who placed each order, and on which link.
  "function orders(uint256 orderId) view returns (address customer, bytes32 linkId)",
  "function markPaidDigest(bytes32 linkId, uint256 orderId) view returns (bytes32)",
  "function cancelDigest(bytes32 linkId, uint256 orderId) view returns (bytes32)",
  "event AgentRegistered(bytes32 indexed linkId, address indexed agent, address indexed merchant)",
  "event OrderPlaced(bytes32 indexed linkId, uint256 indexed orderId, address customer)",
  "event OrderMarkedPaid(bytes32 indexed linkId, uint256 indexed orderId)",
  "event OrderCancelled(bytes32 indexed linkId, uint256 indexed orderId)",
  "error ZeroAddress()",
  "error NotLinkOwner()",
  "error AgentAlreadySet()",
  "error NotLinkAgent()",
  "error UnknownOrder()",
  "error OrderLinkMismatch()",
  "error BadCustomerSignature()",
  "error Reentrancy()",
]);

// Map a contract revert to a clear, human message. Pass any error thrown by a
// sendTransaction / readContract. Walks viem's error chain to find the decoded
// custom-error name (now that all errors are in the ABI above) and returns a
// friendly sentence — so the merchant never sees a raw "0x… not found on ABI".
/**
 * Selector -> human message, DERIVED from the error names rather than written
 * out as hex literals.
 *
 * It used to be a hand-maintained table of 34 literals, and EVERY ONE OF THEM
 * WAS WRONG — not one matched the selector its own contract actually reverts
 * with. The header claimed they were "Generated via
 * node scripts/check-error-signatures.js"; there is no scripts/ directory in
 * this repo. So the whole table was dead weight: no lookup could ever hit, and
 * every decodable revert fell through to the generic "Something went wrong."
 *
 * The evidence it bit in production is still in the git history of this file —
 * a section headed "Unknown signatures seen in production (ABI out of sync with
 * contract)" carrying 0x10cbb591, which is precisely the REAL selector for
 * WithdrawalInFlight, the entry sitting broken a few lines above it. Someone
 * met the correct value, could not reconcile it with the table, and patched the
 * symptom.
 *
 * Computing them removes the failure mode rather than correcting 34 numbers: a
 * renamed error now breaks the build via the ABI, and a new one needs only a
 * sentence here. Nothing in this map can drift from the contract again.
 */
const ERROR_SIGNATURES: Record<string, string> = Object.fromEntries(
  Object.entries({
    // ── Merchant / registration ──────────────────────────────────────
    AlreadyRegistered: "This shop is already registered.",
    NotRegistered: "Your shop isn't registered yet. Sign out, sign back in and finish the setup, then try again.",
    FieldTooLong: "That text is too long — please shorten it and try again.",
    BusinessSectorRequired:
      "Tell us what your business sells — it's required, and must be under 31 characters.",
    PayoutHandleNotSet:
      "Add where your money should go before withdrawing — open Settings and save your payout details.",
    MerchantIsFrozen: "This account is temporarily frozen. Contact support.",
    MerchantNotFrozen: "That recovery step needs the account frozen first.",
    InvalidAddress: "A required field (like your payout ID) is missing or invalid.",

    // ── Limits and pricing ───────────────────────────────────────────
    DailyLimitReached: "You've reached today's transaction limit. Try again tomorrow.",
    ExceedsPerTxCap: "That amount is over the per-transaction limit for your currency.",
    InvalidQuantity: "Enter a valid amount.",
    InvalidCurrency: "That currency isn't supported.",
    InvalidCircle: "No live payment route for that currency right now.",
    ProductNotFound: "Pricing isn't configured — please contact support.",

    // ── Withdrawals ──────────────────────────────────────────────────
    InsufficientAvailableBalance:
      "Not enough available balance for this amount (some funds may still be settling).",
    NothingToWithdraw: "There's nothing available to withdraw yet.",
    WithdrawalInFlight:
      "You already have a withdrawal in progress. Finish or cancel it before starting a new one.",
    WithdrawalAlreadySettled: "This withdrawal was already completed.",
    WithdrawalNotCancellable: "This withdrawal can't be cancelled in its current state.",
    WithdrawalNotFound: "That withdrawal wasn't found.",
    UnknownWithdrawal: "That withdrawal wasn't found.",
    FiatAlreadyDelivered: "This payout was already delivered.",
    OfframpFeeNotReady: "The payment partner is still finalizing — try again in a moment.",
    OfframpInsufficientPool:
      "The offramp can't cover the fee right now. Please try again shortly.",

    // ── Permissions and lifecycle ────────────────────────────────────
    OnlyOwner: "Only the owner can do that.",
    OnlySuperAdmin: "Only the super-admin can do that.",
    OnlyDiamond: "That action isn't allowed here.",
    CannotRemoveSuperAdmin: "The super-admin can't be removed.",
    LastOwner: "The last owner can't be removed.",
    HandoffExpired: "The admin handoff window has expired — start it again.",
    NothingToSkim: "There's no surplus to recover.",
    NotEscheatable: "This account cannot be escheated.",
    NothingToEscheat: "There's no dormant balance to escheat.",

    // ── Global state ─────────────────────────────────────────────────
    Paused: "Payments are temporarily paused for maintenance. Please try again shortly.",
    PauseUnchanged: "Pause state unchanged.",
    InvalidLockPeriod: "The lock period value is invalid.",
    Reentrancy: "Please wait for the previous action to finish.",

    // ── Payment links (PR #104: LinkRouter + PaymentLinksLib) ────────
    LinkExists: "This payment link already exists.",
    LinkNotFound: "This payment link was not found.",
    LinkNotActive: "This payment link has been cancelled.",
    LinkExpired: "This payment link has expired.",
    LinkAlreadyUsed: "This payment link has already been used the maximum number of times.",
    LinkAmountMismatch: "The amount has changed. Please reload the page.",
    LinkOrdersDisabled: "Link payments are temporarily unavailable. Please try again later.",
    OnlyTrustedRelayer: "This payment could not be processed. Please try again.",

    // ── LinkRouter ───────────────────────────────────────────────────
    ZeroAddress: "Something is misconfigured here. Please contact support.",
    NotLinkOwner: "Only the merchant who created this link can change it.",
    AgentAlreadySet: "This link is already set up.",
    NotLinkAgent: "This payment link is no longer active.",
    UnknownOrder: "That order wasn't found.",
    OrderLinkMismatch: "That order doesn't belong to this link.",
    BadCustomerSignature: "Please reload the page and try again.",
  }).map(([errorName, message]) => [toFunctionSelector(`${errorName}()`), message])
);

const ERROR_MESSAGES: Record<string, string> = {
  WithdrawalInFlight: "You already have a withdrawal in progress. Finish or cancel it before starting a new one.",
  OfframpFeeNotReady: "The payment partner is still finalizing — try again in a moment.",
  OfframpInsufficientPool: "The offramp can't cover the fee right now. Please try again shortly.",
  InsufficientAvailableBalance: "Not enough available balance for this amount (some funds may still be settling).",
  NothingToWithdraw: "There's nothing available to withdraw yet.",
  ExceedsPerTxCap: "That amount is over the per-transaction limit for your currency.",
  DailyLimitReached: "You've reached today's transaction limit. Try again tomorrow.",
  MerchantIsFrozen: "This account is temporarily frozen. Contact support.",
  NotRegistered: "This shop isn't registered yet. Please complete setup first.",
  AlreadyRegistered: "This shop is already registered.",
  FieldTooLong: "That text is too long — please shorten it and try again.",
  InvalidAddress: "A required field (like your payout ID) is missing or invalid.",
  InvalidCurrency: "That currency isn't supported.",
  InvalidCircle: "No live payment route for that currency right now.",
  InvalidQuantity: "Enter a valid amount.",
  ProductNotFound: "Pricing isn't configured — please contact support.",
  FiatAlreadyDelivered: "This payout was already delivered.",
  WithdrawalAlreadySettled: "This withdrawal was already completed.",
  WithdrawalNotCancellable: "This withdrawal can't be cancelled in its current state.",
  WithdrawalNotFound: "That withdrawal wasn't found.",
  UnknownWithdrawal: "That withdrawal wasn't found.",
  NotAuthorized: "You don't have permission to do that.",
  OnlyOwner: "Only the owner can do that.",
  OnlySuperAdmin: "Only the super-admin can do that.",
  OnlyDiamond: "That action isn't allowed here.",
  Paused: "Payments are temporarily paused for maintenance. Please try again shortly.",
  Reentrancy: "Please wait for the previous action to finish.",
  MerchantNotFrozen: "That recovery step needs the account frozen first.",
  CannotRemoveSuperAdmin: "The super-admin can't be removed.",
  LastOwner: "The last owner can't be removed.",
  NothingToSkim: "There's no surplus to recover.",
  HandoffExpired: "The admin handoff window has expired — start it again.",
};

/**
 * True when the error is the user declining/closing a wallet prompt (rejecting a
 * signature or transaction, or dismissing the connect modal) — NOT a real failure.
 * Different wallets/SDKs phrase this differently: MetaMask says "User denied
 * transaction signature" (code 4001), thirdweb/others say "User rejected", "user
 * closed modal", etc. We match the EIP-1193 code 4001 plus a broad phrase regex so
 * a cancel always reads as a calm "Cancelled" instead of a scary error. */
export function isUserCancel(e: any): boolean {
  try {
    // EIP-1193 user-rejected-request code (may be nested in the error chain).
    const code = e?.code ?? e?.cause?.code ?? e?.walk?.()?.code;
    if (code === 4001) return true;
    const msg = String(
      e?.shortMessage || e?.message || e?.details || e?.reason || ""
    ).toLowerCase();
    return /user rejected|user denied|denied (the )?(transaction|message|signature|request)|rejected the request|user closed|closed the modal|cancell?ed/.test(
      msg
    );
  } catch {
    return false;
  }
}

/** Extract the friendly message for a contract revert, or a sensible fallback.
 *  A user-cancel is surfaced as a short "Cancelled." rather than a raw wallet
 *  string (so declining a MetaMask/thirdweb prompt never shows scary text).
 *
 *  The @p2pdotme/widgets SDK classifies its own failures (fraud-engine
 *  screening rejections, no-eligible-merchant routing, encryption errors,
 *  etc.) into a `P2PError` with a purpose-built `userMessage` and `code`
 *  BEFORE it ever reaches us — that's the real diagnosis (e.g. "fraud engine
 *  blocked this order", not "no merchant online"). Since a P2PError has no
 *  Solidity errorName/errorSignature, it always used to fall through to
 *  `fallback` below, hiding the SDK's actual reason from the user. Surface
 *  it first. */
export function friendlyError(e: any, fallback = "Something went wrong. Please try again."): string {
  if (isUserCancel(e)) return "Cancelled.";
  if (e?.name === "P2PError" && typeof e.userMessage === "string" && e.userMessage) {
    return e.userMessage;
  }
  let name = "";
  let signature = "";
  try {
    const walked = typeof e?.walk === "function" ? e.walk() : e;
    name = walked?.data?.errorName || walked?.name || "";
    // viem's AbiErrorSignatureNotFoundError (and ContractFunctionRevertedError's
    // decode failure) exposes the 4-byte selector as a TOP-LEVEL `signature`
    // field, not nested under `.data` — `walked?.data?.errorSignature` is never
    // populated, which made the whole ERROR_SIGNATURES fallback map below dead
    // code (verified against node_modules/viem/_esm/errors/abi.js).
    signature = walked?.signature || "";
    // shortMessage sometimes contains: reverted with custom error 'X()'
    const msg = String(e?.shortMessage || e?.message || "");
    if (!ERROR_MESSAGES[name]) {
      const m = msg.match(/custom error ['"]?([A-Za-z]+)/);
      if (m) name = m[1];
    }
    // A selector carried as TEXT inside the message, with no structure around
    // it. Account-abstraction providers report a failed simulation as a plain
    // sentence — thirdweb says:
    //
    //   "Paymaster error from https://…/v2: UserOperation reverted during
    //    simulation with reason: 0x49aeece1"
    //
    // There is no viem error object to walk and no `custom error 'X()'` phrase
    // to match, so every one of these reached the customer as raw hex. The
    // selector is right there in the string, and ERROR_SIGNATURES already knows
    // what it means; the only thing missing was looking. Matched on a word
    // boundary so a transaction hash or address cannot be mistaken for one.
    if (!ERROR_MESSAGES[name] && !ERROR_SIGNATURES[signature]) {
      const inText = msg.match(/\b(0x[0-9a-fA-F]{8})\b/);
      if (inText && ERROR_SIGNATURES[inText[1].toLowerCase()]) {
        signature = inText[1].toLowerCase();
      }
    }
    // Log unknown error signatures to help identify missing ABI errors
    if (!ERROR_MESSAGES[name] && signature && !ERROR_SIGNATURES[signature]) {
      console.warn(`Unknown error signature: ${signature} (name: ${name})`);
    }
  } catch { /* ignore */ }
  return ERROR_MESSAGES[name] || ERROR_SIGNATURES[signature] || fallback;
}

// Fine-grained pricing product: id 2 @ 1e-6 USDC/unit (one 6-dec unit), so the
// on-chain `quantity` IS the plain 6-dec USDC amount (quantity = usdcAmount).
// This is what makes the customer's charged fiat land on the exact quote with
// zero cent-rounding drift — see usdcForFiat() in lib/pricing.ts. The product's
// unit price must be set to 1 on the price-source client (deploy script does
// this via client.setProductPrice(2, 1)); the old 0.01-USDC/cent pricing
// (unit price 10_000) is what caused the ₹250→₹249.57 drift.
export const PRODUCT_ID = 2n;
// Per-transaction cap defaults: India (INR) 50 USDC, every other market 100 USDC.
// NOTE: these are only a LOADING-STATE FALLBACK. The qr terminal reads the LIVE
// perTxCap(currency) from the contract so it always reflects the real cap —
// including any admin setPerTxCap override — without a redeploy. Keep these in
// sync with the contract's PER_TX_CAP_INR / PER_TX_CAP_DEFAULT constants.
const PER_TX_CAP_INR = 50;
const PER_TX_CAP_DEFAULT = 100;
export function perTxCapUsdc(currencyCode: string): number {
  return currencyCode === "INR" ? PER_TX_CAP_INR : PER_TX_CAP_DEFAULT;
}

export const fmtUsdc = (raw) => (Number(raw) / 1e6).toFixed(2);

// Decode a bytes32 currency (as returned by getMerchantInfo()[2]) back to its
// ISO code string ("INR", "BRL", …). Stops at the first NUL byte. Returns "" for
// empty/zero. Used so the UI can key caps / home-currency off the merchant's
// REGISTERED currency (the value the contract enforces), not a UI selection.
export function currencyFromBytes32(b?: string): string {
  if (!b || typeof b !== "string" || !b.startsWith("0x")) return "";
  let out = "";
  for (let i = 2; i + 1 < b.length; i += 2) {
    const byte = b.slice(i, i + 2);
    if (byte === "00") break;
    out += String.fromCharCode(parseInt(byte, 16));
  }
  return out;
}
