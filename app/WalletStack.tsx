"use client";

import { ThirdwebProvider, AutoConnect } from "thirdweb/react";
import { thirdwebClient } from "../lib/thirdweb";
import { appWallets } from "../components/useAuth";

/**
 * The wallet half of the app's providers, split into its own module so it can be
 * loaded as a SEPARATE CHUNK.
 *
 * WHY IT IS SPLIT
 * thirdweb is the single largest thing this app ships — 528 KB of chunk, driven
 * by the wallet SDK's elliptic/bn.js crypto. While it was imported directly by
 * `providers.tsx`, it sat in the ROOT LAYOUT's graph, which means every route
 * downloaded it, including `/pay/[linkId]`.
 *
 * That page is the one customers actually load. They reach it by scanning a QR,
 * usually on a phone, often on a bad connection — and they never connect a
 * wallet. The payment is driven by the link wallet through the relayer worker,
 * so the page uses a plain viem `createPublicClient` and no wagmi or thirdweb
 * hooks at all. It was paying half a megabyte for a wallet it cannot use.
 *
 * WHAT THIS COSTS
 * Merchant routes now fetch this chunk asynchronously rather than as part of the
 * initial bundle, so there is a moment before the provider mounts. `providers.tsx`
 * renders the app's existing <Splash /> for that moment — which is what those
 * pages already showed while `useMerchant` waited on `ready`, so the visible
 * behaviour is unchanged.
 *
 * WHAT MUST NOT CHANGE
 * Children render INSIDE this component, never beside it. thirdweb's hooks throw
 * outside a ThirdwebProvider, so a merchant page that rendered before this
 * mounted would crash rather than degrade.
 */
export function WalletStack({ children }: { children: React.ReactNode }) {
  return (
    <ThirdwebProvider>
      {/* CRITICAL: without AutoConnect, the connection status is stuck at
          "unknown" forever — the login button never enables and a logged-in
          session is never restored on reload. AutoConnect drives the status
          machine on first load AND reconnects the persisted in-app wallet,
          reconstructing the SAME smart account (appWallets carries the
          EIP-4337 + sponsorGas config). */}
      <AutoConnect client={thirdwebClient} wallets={appWallets} />
      {children}
    </ThirdwebProvider>
  );
}
