"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ACTIVE_CHAIN, RPC_URL } from "../lib/chain";
import { ThemeProvider } from "../components/theme";
import { AppUpdateProvider } from "../components/AppUpdate";
import { UpdateBanner } from "../components/UpdateBanner";
import { Splash } from "../components/Splash";

/**
 * thirdweb owns WALLET + AUTH + gasless smart account (see lib/thirdweb.ts,
 * useAuth, useSmartAccount). wagmi is kept purely as the READ layer — every
 * useReadContract in the app reads through it, no wallet connector needed.
 *
 * The wallet half now loads as its own chunk (see WalletStack.tsx): it is 528 KB,
 * it was in the root layout's graph, and so every route paid for it — including
 * the customer pay page, which has no wallet at all.
 */

// One throttled/batched transport applied to whichever chain is active. Both
// Base ids are keyed so the transports record satisfies wagmi's chain-union type
// (ACTIVE_CHAIN is env-selected: base | baseSepolia); only the active one is used.
const rpc = http(RPC_URL, { batch: { wait: 200 }, retryCount: 2, retryDelay: 1500 });

const wagmiConfig = createConfig({
  chains: [ACTIVE_CHAIN],
  transports: {
    [base.id]: rpc,
    [baseSepolia.id]: rpc,
  },
  batch: { multicall: true },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't retry-storm on rate limits; serve cached data while refetching.
      retry: 1,
      retryDelay: 2000,
      staleTime: 10_000,
    },
  },
});

/**
 * Loaded on demand, and `ssr: false` because the wallet SDK reaches for browser
 * globals. The fallback is the app's own splash rather than nothing: these
 * routes already showed it while `useMerchant` waited on `ready`, so a merchant
 * sees the same thing they saw before, not a new blank frame.
 */
const WalletStack = dynamic(() => import("./WalletStack").then((m) => m.WalletStack), {
  ssr: false,
  loading: () => <Splash />,
});

/**
 * Routes that render WITHOUT the wallet stack.
 *
 * Both are the same page — `/p/[code]` re-exports `/pay/[linkId]` behind the
 * short URL — and it is the only page a CUSTOMER loads. It uses a plain viem
 * client and the relayer worker, with no wagmi or thirdweb hooks, so the wallet
 * SDK is dead weight there.
 *
 * `/receipt` is deliberately NOT in this list even though it is public and has
 * no wallet hooks either. Merchants open receipts from /transactions, and
 * crossing this boundary unmounts the provider — which would drop a merchant's
 * connected session mid-navigation and force a reconnect on the way back. A
 * customer who scanned a QR never walks into the merchant app, so /pay and /p
 * can cross it safely; /receipt cannot.
 */
const WALLET_FREE = ["/pay/", "/p/"];

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "";
  const walletFree = WALLET_FREE.some((p) => pathname.startsWith(p));

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          {/* Registers the service worker and drives OTA update detection;
              UpdateBanner shows the global "update ready · refresh" toast.
              Outside the wallet stack so the pay page keeps update handling. */}
          <AppUpdateProvider>
            {walletFree ? children : <WalletStack>{children}</WalletStack>}
            <UpdateBanner />
          </AppUpdateProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
