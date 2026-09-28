"use client";

import { useMemo } from "react";
import { ContactSupport, computeOrderAction, useOrderStates } from "@p2pdotme/widgets/support";
import type { SupportSigner } from "@p2pdotme/widgets/support";
import type { Order } from "@p2pdotme/sdk/orders";
import { DIAMOND_ADDRESS, SUPPORT_BRIDGE_URL, SUPPORT_ORIGIN_APP } from "../lib/p2p";
import { ACTIVE_CHAIN, RPC_URL } from "../lib/chain";
import { useSmartAccount } from "./useSmartAccount";
import { useCheckoutSigner } from "./useCheckoutSigner";

/**
 * `address` MUST be the merchant's ERC-4337 SMART ACCOUNT, because the bridge
 * authorizes the order thread by OWNERSHIP: `/me/orders/:orderId/thread` and
 * `/me/orders/:orderId/messages` both require `session.sub === order.user`.
 * Our payment rows come from `fetchHistory(address)`, which queries the
 * subgraph with `where: { userAddress: <merchant address> }`, and that address
 * is the smart account (useSmartAccount → useActiveAccount). So `order.user`
 * IS the smart account, and a session minted for any other key — including
 * the admin EOA — is rejected 403 `not_authorized` on every call.
 *
 * `signMessage` MUST come from the SMART ACCOUNT too — NOT from the admin EOA.
 * The bridge verifies with viem's `verifyHash`, which for a contract address
 * calls ERC-1271 `isValidSignature(hash, sig)` on the account. thirdweb's
 * `Account` does NOT recover against that raw `hash`: it first wraps it in an
 * EIP-712 `AccountMessage` envelope (domain-separated by the account), then
 * recovers against THAT digest and checks the recovered key is an admin.
 * Verified on a live merchant account on Base:
 *
 *   getMessageHash(0x1111…1111) -> 0xf0a7f2326796a55610746c8d424533dc…
 *
 * i.e. a different digest from the input. So a plain `personal_sign` from the
 * admin EOA — which signs over `hashMessage(message)` — recovers to a garbage
 * address when checked against the wrapped digest, fails the admin check, and
 * the bridge reports 401 `bad_signature`.
 *
 * The smart account's own `signMessage` performs that AccountMessage wrapping
 * (and ERC-6492-wraps while the account is still counterfactual), so it is the
 * only signer whose output `isValidSignature` accepts.
 *
 * NOTE: `useCheckoutSigner` deliberately signs with the admin EOA and reports
 * it via `signerAddress` — that is correct for the FRAUD ENGINE, which does a
 * plain ecrecover against `signerAddress`. The support bridge is the opposite
 * case: it verifies against `address` via ERC-1271. Do not "unify" these two.
 *
 * NOT built with the guide's `fromThirdwebAccount` adapter: that helper reads
 * `account.getChain()` for `getChainId`, which is a property of the ACTIVE
 * WALLET connection rather than of the `Account` object, so it throws "could
 * not resolve a numeric chainId from the active chain". Supplying `getChainId`
 * ourselves (same static ACTIVE_CHAIN.id useCheckoutSigner already uses — this
 * merchant wallet never switches chains) sidesteps that gap.
 */
export function useSupportSigner(): SupportSigner | null {
  const { address, ready, account } = useSmartAccount();
  return useMemo(() => {
    if (!ready || !address || !account) return null;
    return {
      address,
      signMessage: (message: string) => account.signMessage({ message }),
      getChainId: () => ACTIVE_CHAIN.id,
    };
  }, [account, address, ready]);
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
 * Uses `ContactSupport`, NOT the base `Support` component. `Support` opens the
 * chat by booting Chatwoot's BROWSER WEBSITE SDK, which needs the inbox's
 * `website_token` + `hmac_token`. Every live p2p.me inbox has since been
 * migrated to `Channel::Api`, which has neither, so the bridge's sign-in
 * response carries `chatwoot: null` and `Support` dead-ends:
 *
 *   if (!session.chatwoot) { setPhase({ kind: "unavailable" }); return; }
 *
 * That is the misleading "Support not available yet — your order needs to be
 * accepted" screen; it has nothing to do with the order's state, and no order
 * on any circle can get past it. `ContactSupport` instead renders
 * `UserSupportPanel`, which proxies the SAME per-order conversation through
 * the bridge's `/me/orders/:id/thread` + `/messages` routes under its shared
 * admin token — no website token involved. That is the path goat.cash,
 * coins.me and lotpot already run in production.
 *
 * `txSigner` IS wired (see below), because the two halves are load-bearing
 * together: the bridge only ever creates a Chatwoot conversation from its
 * on-chain `OrderDispute` listener (`chatwoot.createConversation` has exactly
 * one caller). With no dispute there is no thread to open — the panel would
 * render empty and `POST /messages` would 409 `conversation_not_ready`. So the
 * report-problem flow that raises the dispute is what makes the chat reachable
 * at all.
 *
 * CONSEQUENCE — this surface is no longer always-visible. `ContactSupport`
 * renders only while a report-problem window is open or a dispute already
 * exists. That is deliberate: those are exactly the states where a thread can
 * exist, so an always-on launcher could only have offered a dead end.
 * Concretely, for a cancelled BUY the widget opens a 15min–24h window (the
 * merchant's own smart account is `Order.user` — see `fetchHistory` — so the
 * merchant is the party the contract lets file), and past that window neither
 * the widget nor the contract has a dispute path.
 * (Withdrawal/fiat-cashout rows aren't payment orders and never reach this
 * component — see the `kind !== "withdraw"` filter at the call site.)
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
  // Doubles as the raiseDispute sender: `CheckoutSigner` already satisfies
  // `RaiseDisputeSigner` ({ address, sendTransaction }), and it sends as a
  // sponsored UserOperation so the merchant needs no ETH.
  const { signer: txSigner } = useCheckoutSigner();

  // Support isn't wired for this deployment yet (see lib/p2p.ts) — render
  // nothing rather than a launcher that can't reach a bridge.
  if (!SUPPORT_BRIDGE_URL) return null;

  const state = computeOrderAction(order, Date.now());
  return (
    <ContactSupport
      orderId={orderId}
      state={state}
      signer={signer}
      bridgeUrl={SUPPORT_BRIDGE_URL}
      originApp={SUPPORT_ORIGIN_APP}
      txSigner={txSigner ?? undefined}
      diamondAddress={(DIAMOND_ADDRESS || undefined) as `0x${string}` | undefined}
      rpcUrl={RPC_URL || undefined}
      chainId={ACTIVE_CHAIN.id}
      chatEnabled={true}
    />
  );
}
