import { base, baseSepolia } from "viem/chains";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;

// Chain selection honors NEXT_PUBLIC_CHAIN ("base" | "baseSepolia") so a mainnet
// cutover is an env change, not a code change. Unset means Base Sepolia (local
// development). Any OTHER value is refused at build time by next.config.mjs:
// this used to be `=== "base" ? base : baseSepolia`, so "Base", "mainnet" or
// "base " with a pasted space silently ran the app on the TESTNET while every
// address pointed at mainnet — merchants unregistered, balances zero, and every
// customer signature rejected, with no error anywhere. Trimmed here to match.
export const ACTIVE_CHAIN =
  (process.env.NEXT_PUBLIC_CHAIN ?? "").trim() === "base" ? base : baseSepolia;

/** True on Base mainnet (8453). Testnet-only fallbacks key off this. */
export const IS_MAINNET = ACTIVE_CHAIN.id === base.id;

// Chain-aware block explorer base URL — derives from ACTIVE_CHAIN instead of
// being hardcoded per-page, so a mainnet cutover (NEXT_PUBLIC_CHAIN=base)
// doesn't leave "View on explorer" links pointed at the Sepolia testnet
// explorer. viem's base/baseSepolia both carry this in blockExplorers.default.
export const EXPLORER_URL = ACTIVE_CHAIN.blockExplorers?.default.url ?? "https://basescan.org";
