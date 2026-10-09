"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";
import { useSmartAccount } from "./useSmartAccount";
import { fetchHistory } from "../lib/history";
import { fmtUsdc } from "../lib/contract";
import { SUPPORT_BRIDGE_URL } from "../lib/p2p";
import { useDisputeOrderStates, OrderDisputeManager, useSupportSigner } from "./OrderDisputeManager";

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * Order picker for the header's dispute/support launcher. `ContactSupport`
 * (rendered per-row via OrderDisputeManager) only draws something when
 * computeOrderAction says a report-problem window is open OR a dispute
 * already exists for that SPECIFIC order — see OrderDisputeManager.tsx's
 * doc comment. There's no order-agnostic dispute surface in
 * @p2pdotme/widgets/support, so the header icon can't jump straight to "the"
 * dispute widget; it has to let the merchant pick which order first. This
 * fetches the same PayQR-scoped payment history Transactions uses, narrows
 * it to the last 20 rows (disputes are always time-boxed, so anything older
 * is guaranteed already outside the window), and renders each row's real
 * ContactSupport chip — rows with nothing actionable render nothing, exactly
 * like the Transactions list.
 */
function DisputePicker({ onClose }: { onClose: () => void }) {
  const { address, ready } = useSmartAccount();
  const supportSigner = useSupportSigner();
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!ready || !address) return;
    let on = true;
    fetchHistory(address)
      .then((list) => { if (on) setRows(list.sort((a, b) => b.placedAt - a.placedAt).slice(0, 20)); })
      .catch(() => { if (on) setError(true); });
    return () => { on = false; };
  }, [ready, address]);

  const orderIds = useMemo(() => (rows || []).map((r) => r.orderId), [rows]);
  const { rows: disputeRows } = useDisputeOrderStates(orderIds);

  // Only orders where a chip would actually render: an open report-problem
  // window, or a dispute already raised.
  const actionable = useMemo(
    () =>
      (rows || []).filter((r) => {
        const d = disputeRows.get(r.orderId);
        return d && (d.state.action.kind === "report-problem" || d.state.disputeState !== "none");
      }),
    [rows, disputeRows]
  );

  return (
    <div className="sm-overlay" onClick={onClose}>
      <aside className="sm-panel dispute-picker" onClick={(e) => e.stopPropagation()}>
        <div className="sm-head">
          <span className="brand">Disputes &amp; Support</span>
          <button className="sm-close" onClick={onClose} aria-label="Close"><Icon.Close /></button>
        </div>

        {!supportSigner || !SUPPORT_BRIDGE_URL ? (
          <p className="muted" style={{ padding: "16px 4px" }}>Support isn’t available yet.</p>
        ) : error ? (
          <p className="muted" style={{ padding: "16px 4px" }}>Couldn’t load your transactions. Try again shortly.</p>
        ) : rows === null ? (
          <p className="muted" style={{ padding: "16px 4px" }}>Loading…</p>
        ) : actionable.length === 0 ? (
          <p className="muted" style={{ padding: "16px 4px" }}>
            No transaction currently has an open report window or dispute. A report can
            only be filed shortly after a sale is cancelled.
          </p>
        ) : (
          <div className="dispute-picker-list">
            {actionable.map((r) => {
              const d = disputeRows.get(r.orderId)!;
              return (
                <div key={r.orderId} className="dispute-picker-row">
                  <div className="dispute-picker-row-info">
                    <span className="dispute-picker-order">#{r.orderId}</span>
                    <span className="dispute-picker-amt">{fmtUsdc(r.amount)} USDC</span>
                    <span className="hist-time">{timeAgo(r.createdAt)}</span>
                  </div>
                  <OrderDisputeManager orderId={r.orderId} order={d.order} signer={supportSigner} />
                </div>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}

/**
 * Top-nav dispute/support launcher. Opens a compact picker of recent,
 * dispute-eligible orders rather than dropping the merchant on the full
 * Transactions list — see DisputePicker's doc comment for why a single
 * order-agnostic widget isn't possible here.
 */
export function DisputeButton() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        className="theme-btn"
        aria-label={t("nav.disputes")}
        title={t("nav.disputes")}
        onClick={() => setOpen(true)}
      >
        <Icon.Headset />
      </button>
      {open && <DisputePicker onClose={onClose} />}
    </>
  );
}
