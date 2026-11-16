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
 *
 * SAFETY (same rules as /withdraw): step-up verification, an explicit
 * confirmation, a synchronous lock against double submission, receipt wait with a
 * timeout that reports "unknown" rather than "failed", and NO automatic retry.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData } from "viem";
import { usePublicClient } from "wagmi";
import { useMerchant } from "./useMerchant";
import { usePrevBalances } from "./usePrevBalances";
import { useGuardedSend } from "./useGuardedSend";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ErrorPanel } from "./ui/ErrorPanel";
import { HAS_PREV_CONTRACT, INTEGRATOR_ABI, fmtUsdc } from "../lib/contract";
import { useT } from "../lib/i18n";
import { fill, fmtRemaining } from "../lib/format";
import { ledgerBegin, ledgerUpdate, ledgerRemove } from "../lib/usdcWithdrawals";
import type { UserError } from "../lib/errors";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function PrevTerminalWithdraw({ onWithdrawn }: { onWithdrawn?: () => void } = {}) {
  // Hard gate: the whole feature is inert unless a previous address is set.
  if (!HAS_PREV_CONTRACT) return null;
  return <PrevTerminalWithdrawInner onWithdrawn={onWithdrawn} />;
}

type Target = { key: string; contracts: { contract: `0x${string}`; amount: bigint }[]; total: bigint };

function PrevTerminalWithdrawInner({ onWithdrawn }: { onWithdrawn?: () => void }) {
  const { t, lang } = useT();
  const { ready, address, sendTransaction, sendBatchTransaction } = useMerchant();
  const publicClient = usePublicClient();
  const prev = usePrevBalances(address);
  const sender = useGuardedSend({});
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<UserError | string | null>(null);
  const [done, setDone] = useState("");

  // Countdown labels are in hours/days, so a once-a-minute tick is plenty (it
  // used to re-render every second).
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
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

  function ask(tg: Target) { setError(null); setDone(""); setTarget(tg); }

  async function confirm() {
    if (!target || !address) return;
    if (!ready) { setError(t("err.network")); return; }
    const tg = target;
    // With no batch support only the FIRST contract can move in one go, so only
    // that amount is claimed afterwards (the old code reported the full total).
    const batchable = !!sendBatchTransaction || tg.contracts.length === 1;
    const moving = batchable ? tg.contracts : [tg.contracts[0]];
    const movedTotal = moving.reduce((a, c) => a + c.amount, 0n);
    const recIds = moving.map((c) => ledgerBegin(address, { amount: c.amount.toString(), destination: null }));

    const r = await sender.run(async () => {
      const hash = (moving.length > 1
        ? await sendBatchTransaction!(moving.map((c) => callFor(c.contract, c.amount)))
        : await sendTransaction!(callFor(moving[0].contract, moving[0].amount))) as `0x${string}`;
      recIds.forEach((id) => ledgerUpdate(address, id, { step1Hash: hash }));
      const rc = await publicClient!.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (rc.status === "reverted") throw new Error("withdrawUSDC reverted");
      recIds.forEach((id) => ledgerUpdate(address, id, { status: "withdrawn" }));
    }, { context: "prev-terminal", fallbackKey: "err.withdraw", uncertainKey: "err.uncertainWithdraw" });

    if (r.reason === "ok") {
      setTarget(null);
      setDone(fill(t(moving.length < tg.contracts.length ? "prev.donePartial" : "prev.done"), { amount: fmtUsdc(movedTotal) }));
      prev.refetch();
      onWithdrawn?.();
      return;
    }
    if (r.reason === "error") {
      // Nothing was sent (cancelled) → drop the placeholders; a definite failure
      // is recorded as failed; an UNCERTAIN outcome stays "processing".
      if (r.error.kind === "cancelled") recIds.forEach((id) => ledgerRemove(address, id));
      else if (!r.error.uncertain) recIds.forEach((id) => ledgerUpdate(address, id, { status: "failed" }));
      setError(r.error);
      if (!r.error.uncertain) setTarget(null);
    }
  }

  const many = prev.rows.length > 1;

  return (
    <div className="prev-terminal" style={{ marginTop: 18 }}>
      <div className="wd-bal-box" style={{ borderStyle: "dashed", display: "block", padding: 16 }}>
        <div className="wd-bal-label" style={{ marginBottom: 4 }}>
          {t(many ? "prev.titleMany" : "prev.title")}
        </div>
        <div className="wd-bal-amt">${(Number(prev.total) / 1e6).toFixed(2)}</div>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>{t("prev.body")}</p>

        {many &&
          prev.rows.map((r) => {
            const rem = fmtRemaining(r.nextUnlock - now, lang);
            return (
              <div key={r.contract} className="wd-locked-row" style={{ alignItems: "center", gap: 8 }}>
                <span>
                  {fmtUsdc(r.pending + r.available)} USDC{" "}
                  <small className="muted">· {short(r.contract)}</small>
                </span>
                {r.available > 0n ? (
                  <button
                    className="btn ghost small"
                    disabled={sender.busy}
                    onClick={() => ask({ key: r.contract, contracts: [{ contract: r.contract, amount: r.available }], total: r.available })}
                  >
                    {fill(t("prev.moveAmount"), { amount: fmtUsdc(r.available) })}
                  </button>
                ) : rem ? (
                  <span className="badge locked">{fill(t("prev.in"), { time: rem })}</span>
                ) : null}
              </div>
            );
          })}

        {prev.pending > 0n && (
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            {fill(t("prev.settling"), { amount: fmtUsdc(prev.pending) })}
          </p>
        )}

        <button
          className="btn"
          style={{ marginTop: 10, width: "100%" }}
          disabled={sender.busy || prev.available === 0n}
          onClick={() => ask({
            key: "all",
            contracts: ready_.map((r) => ({ contract: r.contract, amount: r.available })),
            total: prev.available,
          })}
        >
          {sender.busy
            ? t("wd.working")
            : prev.available === 0n
              ? t("prev.nothingReady")
              : fill(t("prev.withdrawAll"), { amount: fmtUsdc(prev.available) })}
        </button>

        {!target && <ErrorPanel error={error}
          action={typeof error === "object" && error?.uncertain ? <Link className="btn small ghost" href="/transactions">{t("wd.viewTx")}</Link> : undefined} />}
        {done && <div className="ui-ok" role="status">✓ {done}</div>}
      </div>

      <ConfirmDialog
        open={!!target}
        title={t("wd.usdcConfirmTitle")}
        confirmLabel={t("wd.usdcConfirmCta")}
        busy={sender.busy}
        error={typeof error === "string" ? error : error?.message}
        onCancel={() => { setTarget(null); setError(null); }}
        onConfirm={confirm}
      >
        {target && (
          <>
            <div className="confirm-amt">{fmtUsdc(target.total)} USDC</div>
            <p>{t("prev.confirmBody")}</p>
            <div className="confirm-row"><span>{t("dest.fullAddress")}</span></div>
            <div className="addr-full">{address}</div>
            <p className="muted" style={{ fontSize: 12.5 }}>{t("wd.gasNote")}</p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
