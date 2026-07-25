"use client";

import { useMemo } from "react";
import { useActiveWallet } from "thirdweb/react";
import { Support, computeOrderAction, useOrderStates } from "@p2pdotme/widgets/support";
import type { SupportSigner } from "@p2pdotme/widgets/support";
import type { Order } from "@p2pdotme/sdk/orders";
import { DIAMOND_ADDRESS, SUPPORT_BRIDGE_URL, SUPPORT_ORIGIN_APP } from "../lib/p2p";
import { ACTIVE_CHAIN, RPC_URL } from "../lib/chain";

/**
 * Per the integrator guide (INTEGRATOR_SUPPORT_GUIDE.md § "The signer"):
 * `address` and `signMessage` must come from the SAME key — the support
 * bridge verifies a plain EIP-191 signature (no ERC-1271/6492 support). The
 * merchant's ACTIVE account (useActiveAccount(), what
 * useCheckoutSigner/useSmartAccount expose) is the ERC-4337 SMART ACCOUNT —
 * signing with it produces a contract signature bound to the smart-account
 * address, which the bridge's plain ecrecover can't verify ("bad_signature").
 * So this uses the wallet's ADMIN EOA (wallet.getAdminAccount()) instead —
 * its address and signature are naturally consistent.
 *
 * NOT built with the guide's `fromThirdwebAccount` adapter: that helper reads
 * `account.getChain()` for `getChainId`, which is a property of the ACTIVE
 * WALLET connection, not of an arbitrary `Account` object — the admin EOA
 * account returned by `getAdminAccount()` has no such method, so
 * `fromThirdwebAccount` throws "could not resolve a numeric chainId from the
 * active chain". Supplying `getChainId` ourselves (same static ACTIVE_CHAIN.id
 * useCheckoutSigner already uses — this merchant wallet never switches chains)
 * sidesteps that gap.
 */
export function useSupportSigner(): SupportSigner | null {
  const wallet = useActiveWallet();
  return useMemo(() => {
    const adminAccount = wallet?.getAdminAccount?.();
    if (!adminAccount) return null;
    return {
      address: adminAccount.address as `0x${string}`,
      signMessage: (message: string) => adminAccount.signMessage({ message }),
      getChainId: () => ACTIVE_CHAIN.id,
    };
  }, [wallet]);
}

/**
 * Live on-chain order/dispute state for every VISIBLE payment row, read in one
 * batched multicall (useOrderStates does its own polling — no per-row RPC
 * calls to write ourselves). Call once per screen with the currently visible
 * orderIds; feed the result into <OrderDisputeManager> per row.
 */
export function useDisputeOrderStates(orderIds: string[]) {
  return useOrderStates({
    orderIds,
    diamondAddress: (DIAMOND_ADDRESS || undefined) as `0x${string}` | undefined,
    chainId: ACTIVE_CHAIN.id,
    rpcUrl: RPC_URL || undefined,
  });
}

/**
 * Per-order Dispute Manager chip — always-available chat entry point for one
 * Transactions row, so the merchant can relay a buyer's complaint to p2p.me
 * support REGARDLESS of the order's on-chain state (including CANCELLED —
 * the most common case: a buyer paid, the merchant cancelled, and the buyer
 * has no app of their own to file a dispute from, since PayQR is
 * merchant-only. The merchant is the one who reports it here on their
 * behalf).
 *
 * Uses the base `Support` component (not `ContactSupport`) deliberately:
 * `ContactSupport` only renders while a report-problem window is open or a
 * dispute already exists (`shouldRender` gate in the widget internals) — it
 * would render NOTHING for a cancelled order. `Support` always renders its
 * "Get help" / dispute-status launcher regardless of order state.
 *
 * MERCHANT-SIDE SCOPE: on-chain `raiseDispute` is filed by the order's BUYER
 * (the wallet in Order.user), not the merchant, so no `txSigner` is passed —
 * this is a chat/relay surface only, never a dispute-filing tx from the
 * merchant's own wallet. (Withdrawal/fiat-cashout rows aren't payment orders
 * and never reach this component — see the `kind !== "withdraw"` filter at
 * the call site.)
 */
export function OrderDisputeManager({
  orderId,
  order,
  signer,
}: {
  orderId: string;
  order: Order;
  signer: SupportSigner;
}) {
  // Support isn't wired for this deployment yet (see lib/p2p.ts) — render
  // nothing rather than a launcher that can't reach a bridge.
  if (!SUPPORT_BRIDGE_URL) return null;

  // layout is ops-mode-only in this widget (customer mode always renders a
  // small launcher button + its own modal, regardless of `layout`) — omitted.
  const { disputeState } = computeOrderAction(order, Date.now());
  return (
    <Support
      orderId={orderId}
      signer={signer}
      bridgeUrl={SUPPORT_BRIDGE_URL}
      originApp={SUPPORT_ORIGIN_APP}
      disputeStatus={disputeState}
      chatEnabled={true}
    />
  );
}
