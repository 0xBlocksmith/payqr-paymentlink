/**
 * Withdrawal adapter — isolates the contract call so pages never touch an ABI.
 *
 * Only the USDC-to-wallet withdrawal is built here. The FIAT (SELL) withdrawal is
 * handled end-to-end by the official @p2pdotme Cashout widget (CashoutWidget),
 * which supplies its OWN relay identity/pubkey and does the encryption + delivery.
 * The old buildFiatWithdraw / buildFiatWithdrawIn / getRelayPubKey helpers were
 * removed: they were unused (dead code) and reading the relay keypair here was a
 * cross-account leak surface on a shared device.
 */
import { encodeFunctionData, isAddress } from "viem";
import { INTEGRATOR_ABI } from "./contract";
import { USDC_ADDRESS } from "./p2p";

/** USDC-to-wallet withdrawal — currency-agnostic. The contract's withdrawUSDC
 *  always pays out to msg.sender (the merchant's own connected wallet). */
export function buildUsdcWithdraw({ amountRaw }: { amountRaw: bigint }) {
  const data = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "withdrawUSDC",
    args: [amountRaw],
  });
  return { data };
}

// Minimal ERC-20 transfer ABI — used to forward USDC from the merchant's wallet
// to an external address (the contract itself can only pay out to msg.sender).
const ERC20_TRANSFER = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;

/** Build a plain USDC ERC-20 transfer FROM the merchant's wallet TO an external
 *  address. Used as step 2 of an external USDC withdrawal: withdrawUSDC pulls the
 *  funds into the wallet, then this forwards them on. Returns the `to` (USDC token
 *  contract) and encoded `data` for sendTransaction. */
export function buildUsdcTransfer({ to, amountRaw }: { to: `0x${string}`; amountRaw: bigint }) {
  // Guard the TOKEN address: USDC_ADDRESS is env-derived (`|| ""`), so a
  // misconfigured/unset NEXT_PUBLIC_USDC_ADDRESS would otherwise build a transfer
  // "to" an empty/invalid contract and burn the just-withdrawn funds. Fail loudly
  // instead — the caller surfaces this and the money stays safe in the wallet.
  if (!isAddress(USDC_ADDRESS)) {
    throw new Error("USDC token address is not configured — cannot forward the withdrawal.");
  }
  // Guard the RECIPIENT too, so an invalid destination can never be encoded even
  // if a future caller skips the UI-side validation.
  if (!isAddress(to)) {
    throw new Error("The destination address is invalid.");
  }
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER,
    functionName: "transfer",
    args: [to, amountRaw],
  });
  return { to: USDC_ADDRESS as `0x${string}`, data };
}
