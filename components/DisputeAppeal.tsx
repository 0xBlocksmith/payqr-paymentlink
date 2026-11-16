"use client";

import { useCallback, useEffect, useState } from "react";
import { DIAMOND_ADDRESS } from "../lib/p2p";
import {
  readLadderState, encodeAppeal, encodeFinalize, disputeErrorMessage, type LadderState,
} from "../lib/disputeLadder";
import { useCheckoutSigner } from "./useCheckoutSigner";
import { useStepUp } from "./useStepUp";
import { useGuardedSend } from "./useGuardedSend";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ErrorPanel } from "./ui/ErrorPanel";
import { useT } from "../lib/i18n";
import { fill, fmtDateTime } from "../lib/format";
import type { UserError } from "../lib/errors";

/**
 * Where a dispute stands on the appeal ladder, plus the one action the Diamond
 * allows right now. Only the order's own user can appeal, so callers render
 * this for orders where `order.user` is the merchant's smart account (counter
 * sales). Link orders belong to the merchant's proxy and need an integrator
 * forwarder before they can appeal.
 *
 * Every action here is irreversible (escalate, appeal, finalize), so each goes
 * through: a confirmation that states the consequence, step-up verification, a
 * synchronous lock against double submission, and a wait for the chain before
 * the status is re-read (so the same button can't reappear while the old state
 * is still showing). Never retried.
 */
export function DisputeAppeal({ orderId, enabled }: { orderId: string; enabled: boolean }) {
  const { t, lang } = useT();
  const { signer, publicClient } = useCheckoutSigner();
  const { requireStepUp, stepUpModal } = useStepUp();
  const sender = useGuardedSend({ stepUp: requireStepUp });
  const [state, setState] = useState<LadderState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [err, setErr] = useState<UserError | null>(null);
  const [pendingAction, setPendingAction] = useState<null | { kind: "escalate" | "appeal" | "finalize"; data: `0x${string}` }>(null);

  const load = useCallback(() => {
    readLadderState(orderId)
      .then((s) => { setState(s); setLoadFailed(false); })
      .catch(() => setLoadFailed(true)); // keep the last good state; say it's stale
  }, [orderId]);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  // A dispute moves on its own clock (SLA timers, decisions) — re-read while open
  // and the tab is visible, so the card never goes stale under the merchant.
  const live = !!state && state.kind !== "none";
  useEffect(() => {
    if (!enabled || !live) return;
    const id = setInterval(() => { if (document.visibilityState === "visible") load(); }, 30_000);
    return () => clearInterval(id);
  }, [enabled, live, load]);

  if (!enabled || !DIAMOND_ADDRESS) return null;
  if (!state) {
    return loadFailed ? (
      <ErrorPanel compact error={t("dispute.loadFailed")} onRetry={load} />
    ) : null;
  }
  if (state.kind === "none") return null;

  const tierName = (n: number) => t(`dispute.tier${Math.min(3, Math.max(1, n))}`);

  async function confirm() {
    if (!pendingAction || !signer) return;
    setErr(null);
    const { data } = pendingAction;
    const r = await sender.run(async () => {
      const out: any = await signer.sendTransaction({ to: DIAMOND_ADDRESS as `0x${string}`, data } as any);
      const hash = out?.hash ?? out;
      if (publicClient && hash) {
        const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
        if (rc.status === "reverted") throw new Error("dispute action reverted");
      }
    }, { context: "dispute-action", fallbackKey: "err.unknown", uncertainKey: "err.timeout" });
    if (r.reason === "ok") { setPendingAction(null); load(); return; }
    if (r.reason === "stepup") { setErr({ message: t("err.stepUp"), kind: "unknown", uncertain: false, ref: "" }); return; }
    if (r.reason === "error") {
      // The Diamond's own known reverts have specific, authored explanations.
      const known = disputeErrorMessage(r.raw);
      setErr(known ? { ...r.error, kind: "contract", message: known } : r.error);
      if (!r.error.uncertain) load();
    }
  }

  let text = "";
  let action: { kind: "escalate" | "appeal" | "finalize"; label: string; data: `0x${string}` } | null = null;
  switch (state.kind) {
    case "awaiting":
      text = fill(t("dispute.awaiting"), { tier: tierName(state.tier) }) +
        (state.tier < 3 && state.appealableAt
          ? " " + fill(t("dispute.awaitingEscalate"), { when: fmtDateTime(state.appealableAt, lang) })
          : "");
      break;
    case "appeal-sla":
      text = fill(t("dispute.appealSla"), { tier: tierName(state.tier) });
      action = { kind: "escalate", label: t("dispute.escalate"), data: encodeAppeal(orderId) };
      break;
    case "appeal-window":
      text = fill(t("dispute.appealWindow"), { when: fmtDateTime(state.until, lang) });
      action = { kind: "appeal", label: t("dispute.appeal"), data: encodeAppeal(orderId) };
      break;
    case "finalize":
      text = t("dispute.finalize");
      action = { kind: "finalize", label: t("dispute.finalizeBtn"), data: encodeFinalize(orderId) };
      break;
  }

  return (
    <div className="sub" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
      {text}{" "}
      {action && (
        <button type="button" className="linklike" disabled={sender.busy || !signer}
          onClick={() => { setErr(null); setPendingAction({ kind: action!.kind, data: action!.data }); }}>
          {action.label}
        </button>
      )}
      {loadFailed && <ErrorPanel compact error={t("dispute.loadFailed")} onRetry={load} />}
      {!pendingAction && <ErrorPanel compact error={err} />}

      <ConfirmDialog
        open={!!pendingAction}
        tone="danger"
        title={action?.label ?? ""}
        confirmLabel={action?.label}
        busy={sender.busy}
        error={err?.message}
        onCancel={() => { setPendingAction(null); setErr(null); }}
        onConfirm={confirm}
      >
        <p>{pendingAction ? t(`dispute.confirm.${pendingAction.kind}`) : ""}</p>
        <p className="muted tiny">#{orderId}</p>
      </ConfirmDialog>
      {stepUpModal}
    </div>
  );
}
