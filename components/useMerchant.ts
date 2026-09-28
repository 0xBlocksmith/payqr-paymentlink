"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract, useReadContracts, usePublicClient } from "wagmi";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { useQueryClient } from "@tanstack/react-query";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, CROSS_VERSION_ABI, PREV_CONTRACT_ADDRESSES } from "../lib/contract";
import { STATIC_STALE_MS } from "../lib/cache";
import { useSmartAccount } from "./useSmartAccount";
import { useAuth } from "./useAuth";
import { prefsSet } from "../lib/countries";

/**
 * One background import per merchant per page load, shared by every component
 * that calls useMerchant — several mount at once, and each must not send its
 * own transaction.
 */
const imports = new Map<string, Promise<void>>();

/**
 * Shared page guard: requires wallet auth (thirdweb) + prefs.
 * Redirects to /login when logged out or when prefs are missing.
 *
 * The merchant's on-chain identity is their thirdweb SMART ACCOUNT (gas
 * sponsored) — so `address` here is the smart-account address.
 *
 * RETURNING MERCHANTS (after a contract upgrade)
 * A merchant registered on a PREVIOUS integrator is treated as registered: the
 * current integrator carries their record over (MerchantImportLib), so they
 * never see onboarding again. We also trigger that import once in the
 * background (importMerchant — gas-sponsored, no prompt) so their profile is
 * populated on the new contract before any page reads it. If that ever fails,
 * the contract still imports them on their first sale or link.
 */
export function useMerchant({ requireRegistered = true } = {}) {
  const router = useRouter();
  const { ready: authReady, authenticated } = useAuth();
  const { address, ready: saReady, sendTransaction, sendBatchTransaction, signTypedData } = useSmartAccount();
  const publicClient = usePublicClient();
  const queryClient = useQueryClient();

  const { data: registeredHere, isLoading: regLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "registered",
    args: [address],
    query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });

  // Only asked when the current integrator says "not registered".
  const checkPrevious = !!address && registeredHere === false && PREV_CONTRACT_ADDRESSES.length > 0;
  const { data: prevRegs, isLoading: prevLoading } = useReadContracts({
    contracts: PREV_CONTRACT_ADDRESSES.map(
      (c) => ({ address: c, abi: CROSS_VERSION_ABI, functionName: "registered", args: [address!] }) as const
    ),
    query: { enabled: checkPrevious, staleTime: STATIC_STALE_MS },
  });
  const knownBefore = checkPrevious && !!prevRegs?.some((r) => r.status === "success" && r.result === true);

  // Does the CURRENT integrator know how to carry merchants over? Only newer
  // ones have importMerchant. On an older one, treating a previous merchant as
  // registered would let them skip onboarding on a contract that has no record
  // of them — and every sale would then fail. So ask, with a free eth_call
  // (no transaction): if the function exists it returns, otherwise it reverts.
  const [importSupported, setImportSupported] = useState<boolean | null>(null);
  useEffect(() => {
    if (!knownBefore || !address || !publicClient) return;
    let alive = true;
    publicClient
      .call({
        to: CONTRACT_ADDRESS,
        data: encodeFunctionData({ abi: INTEGRATOR_ABI, functionName: "importMerchant", args: [address] }),
      })
      // importMerchant NEVER reverts: it returns FALSE when it cannot carry the
      // merchant over (this integrator doesn't list that previous one, or the
      // old record is unusable). Treating "did not revert" as success showed
      // such a merchant as registered, skipped onboarding, and every sale then
      // failed with NotRegistered. Read the answer.
      .then((r) => {
        if (!alive) return;
        let ok = false;
        try {
          ok =
            !!r.data &&
            decodeFunctionResult({ abi: INTEGRATOR_ABI, functionName: "importMerchant", data: r.data }) === true;
        } catch {
          ok = false;
        }
        setImportSupported(ok);
      })
      .catch(() => alive && setImportSupported(false));
    return () => { alive = false; };
  }, [knownBefore, address, publicClient]);

  const onPrevious = knownBefore && importSupported === true;

  // Carry a returning merchant over, once.
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    if (!onPrevious || !address || !sendTransaction || !publicClient) return;
    const key = address.toLowerCase();
    let job = imports.get(key);
    if (!job) {
      job = (async () => {
        const hash = await sendTransaction({
          to: CONTRACT_ADDRESS,
          data: encodeFunctionData({ abi: INTEGRATOR_ABI, functionName: "importMerchant", args: [address] }),
        });
        await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      })().catch((e) => {
        // Not fatal: the contract imports them on their first sale or link.
        console.warn("background merchant import failed:", e);
      });
      imports.set(key, job);
    }
    let alive = true;
    setImporting(true);
    job.finally(() => {
      if (!alive) return;
      setImporting(false);
      // Pages may have read (and cached) the still-empty profile while the
      // import ran — refresh every contract read, not just this one.
      queryClient.invalidateQueries();
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPrevious, address, !!sendTransaction, !!publicClient]);

  useEffect(() => {
    if (authReady && !authenticated) router.replace("/login");
  }, [authReady, authenticated, router]);

  // Currency + language are chosen on the login page. If somehow missing
  // (e.g. direct deep-link), bounce back to login. Registration is NOT forced —
  // the dashboard opens for unregistered users; registration is requested
  // lazily when they tap "Accept Payment".
  useEffect(() => {
    if (requireRegistered && authReady && authenticated && !prefsSet()) {
      router.replace("/login");
    }
  }, [requireRegistered, authReady, authenticated, router]);

  // `ready` means "safe to act on address + isRegistered". During thirdweb's
  // multi-second smart-account init the address is briefly undefined; treating
  // that as ready would let pages route on a stale/undefined isRegistered and
  // flicker. So require the smart account, the registration read, the
  // previous-integrator check when it applies, and a finished carry-over.
  const ready =
    authReady &&
    (!authenticated ||
      (saReady &&
        !!address &&
        !regLoading &&
        !(checkPrevious && prevLoading) &&
        !(knownBefore && importSupported === null) &&
        !importing));

  // Registered here, OR registered on a previous integrator (carried over).
  const isRegistered = registeredHere === true || onPrevious ? true : registeredHere;

  return {
    ready,
    authenticated,
    address,
    isRegistered,
    refetchRegistered: refetch,
    sendTransaction,
    sendBatchTransaction,
    signTypedData,
  };
}
