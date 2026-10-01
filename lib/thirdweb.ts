"use client";

import { createThirdwebClient } from "thirdweb";
import { base, baseSepolia } from "thirdweb/chains";
import { ACTIVE_CHAIN } from "./chain";

/**
 * Central thirdweb setup.
 *
 * The merchant's on-chain identity is a thirdweb SMART ACCOUNT (ERC-4337),
 * created from an in-app wallet (phone/social login). Gas is SPONSORED by the
 * thirdweb paymaster (sponsorGas: true), so the merchant transacts with 0 ETH —
 * same zero-ETH UX as before.
 *
 * REQUIRED env: NEXT_PUBLIC_THIRDWEB_CLIENT_ID
 *   Get it from thirdweb.com/dashboard → your project → Settings → Client ID.
 *   It is public (safe to ship to the browser), but LOCK IT DOWN in the
 *   dashboard: restrict it to your production domain(s) so nobody else can use
 *   your sponsorship quota.
 */
export const THIRDWEB_CLIENT_ID = process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID || "";

export const thirdwebClient = createThirdwebClient({
  // A missing id is a hard misconfig — surface it clearly rather than failing
  // deep inside a wallet call. (Still constructs so the build succeeds.)
  clientId: THIRDWEB_CLIENT_ID || "MISSING_THIRDWEB_CLIENT_ID",
});

// DERIVED from lib/chain.ts rather than re-reading the env: two separate reads
// of NEXT_PUBLIC_CHAIN could disagree, and then reads (wagmi/viem) and writes
// (thirdweb) would go to different chains.
export const THIRDWEB_CHAIN = ACTIVE_CHAIN.id === base.id ? base : baseSepolia;
