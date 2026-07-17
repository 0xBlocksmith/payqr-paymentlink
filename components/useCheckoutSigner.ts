"use client";

import { useMemo } from "react";
import { usePublicClient } from "wagmi";
import { useActiveWallet } from "thirdweb/react";
import { useSmartAccount } from "./useSmartAccount";

/**
 * Adapts the merchant's thirdweb SMART ACCOUNT to the @p2pdotme/widgets
 * `CheckoutSigner` interface:
 *   { address, sendTransaction({ to, data, gasLimit }) => { hash } }
 *
 * Transactions are sent as sponsored UserOperations through the smart account
 * (gas paid by the thirdweb paymaster), so the merchant needs 0 ETH.
 *
 * Returns { signer, publicClient, ready }.
 */
export function useCheckoutSigner() {
  const { address, ready, sendTransaction } = useSmartAccount();
  const wallet = useActiveWallet();
  const publicClient = usePublicClient();

  const signer = useMemo(() => {
    if (!ready || !address || !sendTransaction) return null;
    // The merchant identity is an ERC-4337 SMART ACCOUNT — a contract, which
    // cannot produce an EIP-191 signature. The fraud engine verifies the
    // `X-Signature` header by ecrecover against `X-Signer-Address` (= our
    // signerAddress), so it needs a PLAIN EOA signature. thirdweb's smart
    // account signMessage would instead emit an ERC-1271/6492 CONTRACT
    // signature bound to the smart-account address, which ecrecover can't
    // recover → every screening call would fail auth.
    //
    // So for screening we sign with the underlying ADMIN EOA and report ITS
    // address as `signerAddress`, while `address` stays the smart account (the
    // subject the fraud engine actually tracks). This is exactly the
    // smart-wallet case the widget/SDK docs call out. If there's no admin
    // account (e.g. a bare EOA wallet), signMessage is omitted and the widget
    // simply skips screening rather than sending an unverifiable signature.
    const adminAccount = wallet?.getAdminAccount?.();
    return {
      address,
      signerAddress: (adminAccount?.address ?? address) as `0x${string}`,
      sendTransaction: async ({ to, data }) => {
        // gasLimit is ignored — the bundler/paymaster handles gas estimation.
        const hash = await sendTransaction({ to, data });
        return { hash };
      },
      // EIP-191 signature from the admin EOA (resolves to a hex string, which
      // satisfies the widget's `(message: string) => Promise<string>` shape).
      // Omitted when there's no EOA that can sign — the widget then places the
      // order without fraud-engine logging.
      ...(adminAccount
        ? { signMessage: (message: string) => adminAccount.signMessage({ message }) }
        : {}),
    };
  }, [ready, address, sendTransaction, wallet]);

  return { signer, publicClient, ready: !!signer && !!publicClient };
}
