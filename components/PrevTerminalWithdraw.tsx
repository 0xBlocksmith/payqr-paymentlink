"use client";

/**
 * PREVIOUS-TERMINAL withdraw path — the upgrade safety net.
 *
 * When the app is repointed to a NEW integrator, any USDC a merchant still holds
 * on an OLD one stays there: funds and records live together in each integrator,
 * so the old one keeps paying out, and locked buckets unlock on their normal
 * schedule. The rest of the app talks to the current contract only, so without
 * this a merchant could not withdraw an old balance in-app.
 *
 * Handles ANY NUMBER of previous contracts (NEXT_PUBLIC_PREV_CONTRACT_ADDRESSES):
 * one row per contract that still holds funds, and — when several have
 * something ready — one "withdraw all" that moves them in a single sponsored
 * operation, so the merchant signs once however many upgrades there have been.
 *
 * Dormant by default: renders nothing and makes no calls unless a previous
 * address is configured AND the merchant holds a balance there.
 *
 * Scope is deliberately USDC-to-own-wallet only (withdrawUSDC pays msg.sender).
 * That is the safe, currency-agnostic wind-down path; a merchant who wants fiat
 * can move the funds here, then cash out normally.
 */
import { useEffect, useState } from "react";
import { encodeFunctionData } from "viem";
import { usePublicClient } from "wagmi";
import { useMerchant } from "./useMerchant";
import { usePrevBalances } from "./usePrevBalances";
import { HAS_PREV_CONTRACT, INTEGRATOR_ABI, fmtUsdc, friendlyError } from "../lib/contract";

// Always in DAYS — see withdraw/page.tsx's fmtRemaining for why.
function fmtRemaining(secs: number): string {
  if (secs <= 0) return "ready";
  const days = Math.max(1, Math.ceil(secs / 86400));
  return `${days} day${days === 1 ? "" : "s"}`;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function PrevTerminalWithdraw({ onWithdrawn }: { onWithdrawn?: () => void } = {}) {
  // Hard gate: the whole feature is inert unless a previous address is set.
  if (!HAS_PREV_CONTRACT) return null;
  return <PrevTerminalWithdrawInner onWithdrawn={onWithdrawn} />;
}

function PrevTerminalWithdrawInner({ onWithdrawn }: { onWithdrawn?: () => void }) {
  const { ready, address, sendTransaction, sendBatchTransaction } = useMerchant();
  const publicClient = usePublicClient();
  const prev = usePrevBalances(address);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null); // contract address, or "all"
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Nothing on any old contract → render nothing (the common case).
  if (prev.total === 0n) return null;

  const ready_ = prev.rows.filter((r) => r.available > 0n);

  // `available` is the exact on-chain bigint, never a float, so a full
  // withdrawal can never round one unit over the balance and revert.
  const callFor = (contract: `0x${string}`, amount: bigint) => ({
    to: contract,
    data: encodeFunctionData({ abi: INTEGRATOR_ABI, functionName: "withdrawUSDC", args: [amount] }),
  });

  async function run(key: string, send: () => Promise<`0x${string}`>, amount: bigint) {
    setError("");
    setDone("");
    if (!ready || !address) {
      setError("Still loading — try again in a moment.");
      return;
    }
    setBusy(key);
    try {
      const hash = await send();
      const rc = await publicClient!.waitForTransactionReceipt({ hash });
      if (rc.status === "reverted") throw new Error("withdrawUSDC reverted");
      setDone(`Moved ${fmtUsdc(amount)} USDC from your previous terminal${key === "all" ? "s" : ""} to your wallet.`);
      prev.refetch();
      onWithdrawn?.();
    } catch (e: any) {
      setError(friendlyError(e, "Couldn't withdraw from your previous terminal. Please try again in a moment."));
    } finally {
      setBusy(null);
    }
  }

  const withdrawOne = (contract: `0x${string}`, amount: bigint) =>
    run(contract, () => sendTransaction!(callFor(contract, amount)), amount);

  const withdrawAll = () =>
    run(
      "all",
      () =>
        sendBatchTransaction
          ? sendBatchTransaction(ready_.map((r) => callFor(r.contract, r.available)))
          : sendTransaction!(callFor(ready_[0].contract, ready_[0].available)),
      prev.available
    );

  const many = prev.rows.length > 1;

  return (
    <div className="prev-terminal" style={{ marginTop: 18 }}>
      <div className="wd-bal-box" style={{ borderStyle: "dashed", display: "block", padding: 16 }}>
        <div className="wd-bal-label" style={{ marginBottom: 4 }}>
          Previous terminal balance{many ? "s" : ""}
        </div>
        <div className="wd-bal-amt">${(Number(prev.total) / 1e6).toFixed(2)}</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          Funds from your earlier terminal{many ? "s" : ""}. They stay safe there and are included in
          your balance above. Move them to your wallet to spend or cash out.
        </p>

        {many &&
          prev.rows.map((r) => (
            <div key={r.contract} className="wd-locked-row" style={{ alignItems: "center", gap: 8 }}>
              <span>
                {fmtUsdc(r.pending + r.available)} USDC{" "}
                <small className="muted">· {short(r.contract)}</small>
              </span>
              {r.available > 0n ? (
                <button
                  className="btn ghost"
                  style={{ padding: "4px 10px", fontSize: 13 }}
                  disabled={busy !== null}
                  onClick={() => withdrawOne(r.contract, r.available)}
                >
                  {busy === r.contract ? "Moving…" : `Move ${fmtUsdc(r.available)}`}
                </button>
              ) : (
                <span className="badge locked">in {fmtRemaining(r.nextUnlock - now)}</span>
              )}
            </div>
          ))}

        {prev.pending > 0n && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            {fmtUsdc(prev.pending)} USDC still settling — it becomes withdrawable when the lock ends.
          </p>
        )}

        <button
          className="btn"
          style={{ marginTop: 10, width: "100%" }}
          disabled={busy !== null || prev.available === 0n}
          onClick={withdrawAll}
        >
          {busy === "all"
            ? "Withdrawing…"
            : prev.available === 0n
              ? "Nothing ready to withdraw yet"
              : `Withdraw ${fmtUsdc(prev.available)} USDC to wallet`}
        </button>

        {error && (
          <p className="error" style={{ marginTop: 8, fontSize: 13 }}>
            {error}
          </p>
        )}
        {done && <p style={{ marginTop: 8, fontSize: 13, color: "var(--good, #16a34a)" }}>{done}</p>}
      </div>
    </div>
  );
}
