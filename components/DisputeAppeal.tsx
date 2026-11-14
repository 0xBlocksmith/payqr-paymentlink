"use client";

import { useCallback, useEffect, useState } from "react";
import { DIAMOND_ADDRESS } from "../lib/p2p";
import { friendlyError } from "../lib/contract";
import {
  readLadderState, encodeAppeal, encodeFinalize, disputeErrorMessage, type LadderState,
} from "../lib/disputeLadder";
import { useCheckoutSigner } from "./useCheckoutSigner";

const TIER = ["", "the circle", "the country admin", "P2P operations"];

function fmtWhen(unix: number) {
  const s = unix - Math.floor(Date.now() / 1000);
  if (s <= 0) return "now";
  const h = Math.floor(s / 3600);
  return h >= 1 ? `in about ${h} h` : `in ${Math.max(1, Math.ceil(s / 60))} min`;
}

/**
 * Where a dispute stands on the appeal ladder, plus the one action the Diamond
 * allows right now. Only the order's own user can appeal, so callers render
 * this for orders where `order.user` is the merchant's smart account (counter
 * sales). Link orders belong to the merchant's proxy and need an integrator
 * forwarder before they can appeal.
 */
export function DisputeAppeal({ orderId, enabled }: { orderId: string; enabled: boolean }) {
  const { signer } = useCheckoutSigner();
  const [state, setState] = useState<LadderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    readLadderState(orderId).then(setState).catch(() => setState(null));
  }, [orderId]);
  useEffect(() => { if (enabled) load(); }, [enabled, load]);

  if (!enabled || !DIAMOND_ADDRESS || !state || state.kind === "none") return null;

  const send = async (data: `0x${string}`) => {
    if (!signer) return;
    setBusy(true); setMsg("");
    try {
      await signer.sendTransaction({ to: DIAMOND_ADDRESS as `0x${string}`, data } as any);
      load();
    } catch (e) {
      setMsg(disputeErrorMessage(e) ?? friendlyError(e));
    } finally { setBusy(false); }
  };

  let text = "";
  let action: { label: string; data: `0x${string}` } | null = null;
  switch (state.kind) {
    case "awaiting":
      text = `Dispute is with ${TIER[state.tier]}.` +
        (state.tier < 3 && state.appealableAt ? ` You can escalate it if it isn't decided ${fmtWhen(state.appealableAt)}.` : "");
      break;
    case "appeal-sla":
      text = `${TIER[state.tier]} hasn't decided in time. You can escalate this dispute.`;
      action = { label: "Escalate dispute", data: encodeAppeal(orderId) };
      break;
    case "appeal-window":
      text = `Decided against you. You can appeal until ${fmtWhen(state.until)}, otherwise it becomes final.`;
      action = { label: "Appeal decision", data: encodeAppeal(orderId) };
      break;
    case "finalize":
      text = "The appeal window has ended. Finalize to close this dispute.";
      action = { label: "Finalize", data: encodeFinalize(orderId) };
      break;
  }

  return (
    <div className="sub" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
      {text}{" "}
      {action && (
        <button type="button" disabled={busy || !signer} onClick={() => send(action!.data)}
          style={{ textDecoration: "underline", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}>
          {busy ? "Sending…" : action.label}
        </button>
      )}
      {msg && <div style={{ color: "#c0392b" }}>{msg}</div>}
    </div>
  );
}
