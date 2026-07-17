import { parseAbi } from "viem";

export const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
export const CLIENT_ADDRESS = process.env.NEXT_PUBLIC_CLIENT_ADDRESS as `0x${string}`;

// PREVIOUS integrator address, set ONLY during/after an upgrade so merchants can
// still drain a balance they hold on the OLD contract (funds and records live in
// each integrator together — the old one keeps paying out; see the drain-in-place
// upgrade model). Locked funds on the old contract unlock on their normal schedule
// and remain withdrawable from it. Leave UNSET in steady state — every reader below
// is gated on this being a real address, so the whole "previous terminal" feature
// is DORMANT (renders nothing, makes no calls) until you actually upgrade.
// Same shape as CONTRACT_ADDRESS (a v12+ internal-custody integrator).
const _prev = (process.env.NEXT_PUBLIC_PREV_CONTRACT_ADDRESS || "").trim();
export const PREV_CONTRACT_ADDRESS = (/^0x[0-9a-fA-F]{40}$/.test(_prev) ? _prev : "") as
  | `0x${string}`
  | "";
/** True only when a valid, DISTINCT previous integrator is configured. */
export const HAS_PREV_CONTRACT =
  PREV_CONTRACT_ADDRESS !== "" &&
  PREV_CONTRACT_ADDRESS.toLowerCase() !== (CONTRACT_ADDRESS || "").toLowerCase();

// ABI of the deployed multi-currency MerchantTerminalIntegrator (v13,
// INTERNAL CUSTODY — the integrator holds merchant USDC itself; no vault).
// Signatures match the deployed bytecode exactly:
//   • payout handle is ENCRYPTED `bytes` (client-side ECIES), never plaintext
//   • registerMerchant takes the currency CODE as a 3rd arg
//   • getMerchantInfo returns 5 values (currency included; [0] is encrypted bytes)
//   • MULTI-OWNER: no owner(); use isOwner()/ownerCount()/superAdmin()
//   • fiat withdrawal is withdrawFiat / withdrawFiatIn (no INR-pinned names)
//   • deliverFiatPayout is the second-step poke (was deliverInrUpi)
// IMPORTANT: NEXT_PUBLIC_CONTRACT_ADDRESS must point at a v12+-shaped contract —
// these signatures will revert on the old plaintext/single-owner integrator.
export const INTEGRATOR_ABI = parseAbi([
  // payoutId is an ENCRYPTED bytes blob (client-side encrypted to the merchant's
  // relay key — see lib/payoutCrypto.ts). The raw UPI/PIX handle is never on-chain
  // in plaintext. Pass encrypted bytes here, not a string.
  "function registerMerchant(bytes encPayoutId, string shopName, string currencyCode)",
  "function registerMerchantRaw(bytes encPayoutId, string shopName, bytes32 currency)",
  "function updateProfile(bytes encPayoutId, string shopName)",
  "function registered(address) view returns (bool)",
  "function userPlaceOrder(address client, uint256 productId, uint256 quantity, bytes32 currency, uint256 circleId, string pubKey) returns (uint256)",
  "function withdrawFiat(uint256 amount, uint256 circleId, string pubKey, string payoutOverride) returns (uint256)",
  "function withdrawFiatIn(uint256 amount, uint256 circleId, bytes32 currency, string pubKey) returns (uint256)",
  "function deliverFiatPayout(uint256 orderId, string encPayout)",
  "function reconcileWithdrawal(uint256 orderId)",
  "function withdrawUSDC(uint256 amount)",
  "function getMerchantBalance(address merchant) view returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)",
  "function getMerchantInfo(address merchant) view returns (bytes encPayoutId, string shopName, bytes32 currency, bool isRegistered, bool isFrozen)",
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
  // MANAGER=+caps/limits/relayer, FINANCE=+recover stuck withdrawals. Every OWNER
  // is above all tiers (reads as 4) — gate owner-only UI on isOwner(addr), NOT
  // roleOf==4 (a Finance admin also reads 4 but is not an owner).
  "function adminRole(address) view returns (uint8)",
  "function roleOf(address who) view returns (uint8)",
  "function isManager(address who) view returns (bool)",
  "function isFinance(address who) view returns (bool)",
  "function setRole(address who, uint8 role)",
  "function addAdmin(address who)",
  "function removeAdmin(address who)",
  "function transferOwnership(address newOwner)",
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
]);

// Map a contract revert to a clear, human message. Pass any error thrown by a
// sendTransaction / readContract. Walks viem's error chain to find the decoded
// custom-error name (now that all errors are in the ABI above) and returns a
// friendly sentence — so the merchant never sees a raw "0x… not found on ABI".
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
 *  string (so declining a MetaMask/thirdweb prompt never shows scary text). */
export function friendlyError(e: any, fallback = "Something went wrong. Please try again."): string {
  if (isUserCancel(e)) return "Cancelled.";
  // viem exposes the decoded error name in a few places depending on version.
  let name = "";
  try {
    const walked = typeof e?.walk === "function" ? e.walk() : e;
    name = walked?.data?.errorName || walked?.name || "";
    // shortMessage sometimes contains: reverted with custom error 'X()'
    const msg = String(e?.shortMessage || e?.message || "");
    if (!ERROR_MESSAGES[name]) {
      const m = msg.match(/custom error ['"]?([A-Za-z]+)/);
      if (m) name = m[1];
    }
  } catch { /* ignore */ }
  return ERROR_MESSAGES[name] || fallback;
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
