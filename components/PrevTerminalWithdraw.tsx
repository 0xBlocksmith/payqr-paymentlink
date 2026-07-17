"use client";

/**
 * PREVIOUS-TERMINAL withdraw path — the upgrade safety net.
 *
 * When the app is repointed to a NEW integrator (NEXT_PUBLIC_CONTRACT_ADDRESS),
 * any USDC a merchant still holds on the OLD integrator stays there: funds and
 * records live together in each integrator, so the old one keeps paying out, and
 * locked buckets unlock on their normal schedule. But the rest of the app only
 * talks to the NEW contract — so without this, a merchant could not SEE or WITHDRAW
 * an old balance through the app after the switch (the money is safe, just
 * unreachable in-app). This component closes that gap: it reads the merchant's
 * balance on the PREVIOUS integrator and, if there's anything there, lets them
 * withdraw it to their own wallet.
 *
 * DORMANT BY DEFAULT: renders nothing and makes no calls unless
 * NEXT_PUBLIC_PREV_CONTRACT_ADDRESS is set to a valid, distinct address
 * (HAS_PREV_CONTRACT). In steady state (no upgrade) it is completely inert.
 *
 * Scope is deliberately minimal — USDC-to-own-wallet only (withdrawUSDC pays
 * msg.sender). That is the safe, currency-agnostic wind-down path; a merchant who
 * wants the old balance as fiat can withdraw here, then cash out normally. No
 * fiat/circle/relay machinery is duplicated against the old contract.
 */
import { useEffect, useState } from "react";
import { encodeFunctionData } from "viem";
import { useReadContract, usePublicClient } from "wagmi";
import { useMerchant } from "./useMerchant";
import {
  PREV_CONTRACT_ADDRESS,
  HAS_PREV_CONTRACT,
  INTEGRATOR_ABI,
  fmtUsdc,
  friendlyError,
} from "../lib/contract";

function fmtRemaining(secs: number): string {
  if (secs <= 0) return "ready";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.ceil(secs / 60)} min`;
  if (secs < 86400) return `${Math.ceil(secs / 3600)} hr`;
  return `${Math.ceil(secs / 86400)} days`;
}

export function PrevTerminalWithdraw() {
  // Hard gate: the whole feature is inert unless a valid previous address is set.
  if (!HAS_PREV_CONTRACT) return null;
  return <PrevTerminalWithdrawInner />;
}

function PrevTerminalWithdrawInner() {
  const { ready, address, sendTransaction } = useMerchant();
  const publicClient = usePublicClient();
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const enabled = !!address;
  const PREV = PREV_CONTRACT_ADDRESS as `0x${string}`;

  // Balance the merchant holds on the OLD contract: [pending(locked), available].
  const { data: balance, refetch } = useReadContract({
    address: PREV,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBalance",
    args: [address],
    query: { enabled, refetchInterval: 20000 },
  });
  const { data: buckets } = useReadContract({
    address: PREV,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBuckets",
    args: [address],
    query: { enabled, refetchInterval: 20000 },
  });

  // getMerchantBalance → (pending, available, totalDeposited, isFrozen). We only
  // need pending (locked) + available (unlocked).
  const bal = balance as readonly [bigint, bigint, bigint, boolean] | undefined;
  const pending = bal?.[0] ?? 0n;
  const available = bal?.[1] ?? 0n;
  const total = pending + available;

  // Nothing on the old contract → render nothing (the common case even during an
  // upgrade, once a merchant has drained). Keeps the page clean.
  if (total === 0n) return null;

  const availNum = Number(available) / 1e6;
  const lockedBuckets = ((buckets as { amount: bigint; unlockTimestamp: bigint }[]) || [])
    .filter((b) => b.amount > 0n && Number(b.unlockTimestamp) > now)
    .sort((a, b) => Number(a.unlockTimestamp) - Number(b.unlockTimestamp));
  const nextUnlock = lockedBuckets[0];

  async function withdrawAll() {
    setError("");
    setDone("");
    if (!ready || !address) {
      setError("Still loading — try again in a moment.");
      return;
    }
    if (available === 0n) {
      setError("Your previous-terminal funds are still settling. Check back once they unlock.");
      return;
    }
    setBusy(true);
    try {
      // Withdraw the full UNLOCKED amount from the OLD contract to the merchant's
      // own wallet. Uses the on-chain `available` bigint directly (no float) so it
      // can never round 1 unit over the balance and revert.
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "withdrawUSDC",
        args: [available],
      });
      const hash = await sendTransaction({ to: PREV, data });
      const rc = await publicClient!.waitForTransactionReceipt({ hash });
      if (rc.status === "reverted") throw new Error("withdrawUSDC reverted");
      setDone(
        `Withdrew ${fmtUsdc(available)} USDC from your previous terminal to your wallet.`
      );
      refetch();
    } catch (e: any) {
      setError(
        friendlyError(
          e,
          "Couldn't withdraw from your previous terminal. Please try again in a moment."
        )
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="prev-terminal" style={{ marginTop: 18 }}>
      <div
        className="wd-bal-box"
        style={{ borderStyle: "dashed", display: "block", padding: 16 }}
      >
        <div className="wd-bal-label" style={{ marginBottom: 4 }}>
          Previous terminal balance
        </div>
        <div className="wd-bal-amt">${(Number(total) / 1e6).toFixed(2)}</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Funds from your earlier terminal. They stay safe here and can be moved to
          your wallet.
          {availNum > 0
            ? ` ${fmtUsdc(available)} USDC is ready now.`
            : nextUnlock
              ? ` Unlocks in ${fmtRemaining(Number(nextUnlock.unlockTimestamp) - now)}.`
              : ""}
        </p>

        {lockedBuckets.length > 0 && availNum === 0 && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
            {fmtUsdc(pending)} USDC still settling — it becomes withdrawable when the
            lock ends.
          </p>
        )}

        <button
          className="btn"
          style={{ marginTop: 10, width: "100%" }}
          disabled={busy || available === 0n}
          onClick={withdrawAll}
        >
          {busy
            ? "Withdrawing…"
            : available === 0n
              ? "Nothing ready to withdraw yet"
              : `Withdraw ${fmtUsdc(available)} USDC to wallet`}
        </button>

        {error && (
          <p className="error" style={{ marginTop: 8, fontSize: 13 }}>
            {error}
          </p>
        )}
        {done && (
          <p style={{ marginTop: 8, fontSize: 13, color: "var(--good, #16a34a)" }}>{done}</p>
        )}
      </div>
    </div>
  );
}
