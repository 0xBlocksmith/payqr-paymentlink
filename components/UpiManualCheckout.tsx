"use client";

/**
 * UPI checkout without a payment intent: the payee's UPI ID and exact amount
 * with copy buttons, and instructions to enter them in any UPI app. No `upi://`
 * link or payee/amount-carrying URL is ever created, and no app is launched:
 * the app-scheme links tried on a real Android phone (tez://, phonepe://) did
 * nothing and paytmmp:// opened Paytm's "App upgrade required" page, so they
 * were removed (see docs/UPI_MANUAL_CHECKOUT.md).
 *
 * This component NEVER reports a payment as made. Copying a value changes
 * nothing about the order; the parent keeps its own "I've paid" step, which
 * only asks the protocol to verify — the order stays pending until its
 * on-chain status says otherwise.
 */
import { useEffect, useRef, useState } from "react";
import { usePayerT } from "../lib/payerI18n";
import { copyText } from "../lib/clipboard";

type Field = "upi" | "amount";

export function UpiManualCheckout({ upiId, amount, amountDisplay }: { upiId: string; amount: string; amountDisplay: string }) {
  const { t } = usePayerT();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copiedField, setCopiedField] = useState<Field | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function flash(kind: "ok" | "err", text: string, field?: Field) {
    setToast({ kind, text });
    setCopiedField(kind === "ok" ? field ?? null : null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setToast(null); setCopiedField(null); }, 2200);
  }

  async function onCopy(field: Field) {
    const label = field === "upi" ? t("pl.man.upiId") : t("pl.man.amount");
    const res = await copyText(field === "upi" ? upiId : amount);
    if (res.ok) flash("ok", t("pl.man.copied", { label }), field);
    else flash("err", t("pl.man.copyFailed", { label }));
  }

  return (
    <section className="pc-man" aria-labelledby="pc-man-h">
      <div id="pc-man-h" className="pc-man-h">{t("pl.man.title")}</div>

      <div className="pc-man-launchmsg">{t("pl.man.apps")}</div>

      <div className="pc-man-details">
        <div className="pc-man-row">
          <div className="pc-man-k">{t("pl.man.upiId")}</div>
          <div className="pc-man-v mono">{upiId}</div>
          <button type="button" className={`pc-man-copy${copiedField === "upi" ? " copied" : ""}`} onClick={() => onCopy("upi")}>
            {t("pl.man.copy")}
          </button>
        </div>
        <div className="pc-man-row">
          <div className="pc-man-k">{t("pl.man.amount")}</div>
          <div className="pc-man-v">{amountDisplay}</div>
          <button type="button" className={`pc-man-copy${copiedField === "amount" ? " copied" : ""}`} onClick={() => onCopy("amount")}>
            {t("pl.man.copy")}
          </button>
        </div>
      </div>

      <p className="pc-man-steps">{t("pl.man.steps")}</p>
      <p className="pc-man-warn" role="note">{t("pl.man.noAuto")}</p>

      <div className={`pc-man-toast${toast ? " show" : ""}${toast?.kind === "err" ? " err" : ""}`} role="status" aria-live="polite">
        {toast?.text}
      </div>

      <style jsx global>{`
        .pc-man { margin: 20px 0 0; padding: 16px; border: 1px solid var(--pq-line); border-radius: 16px; }
        .pc-man-h { font-size: 14.5px; font-weight: 700; color: var(--pq-ink); margin-bottom: 8px; }
        .pc-man-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid var(--pq-line); }
        .pc-man-k { flex: none; font-size: 13px; color: var(--pq-muted); font-weight: 500; min-width: 64px; }
        .pc-man-v { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--pq-ink); overflow-wrap: anywhere; }
        .pc-man-v.mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
        .pc-man-copy { flex: none; border: none; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 600; padding: 8px 12px; border-radius: 8px; background: var(--pq-blue-soft); color: var(--pq-blue); }
        .pc-man-copy:hover { background: var(--pq-blue); color: #fff; }
        .pc-man-copy.copied { background: var(--pq-success); color: #fff; }
        .pc-man-copy:focus-visible { outline: 3px solid rgba(58,100,220,0.3); outline-offset: 2px; }
                        .pc-man-details { margin-top: 12px; }
        .pc-man-launchmsg { margin-top: 8px; font-size: 12.5px; color: var(--pq-muted); line-height: 1.5; }
        .pc-man-steps { margin: 12px 0 0; font-size: 13px; color: var(--pq-ink); line-height: 1.5; }
        .pc-man-warn { margin: 8px 0 0; font-size: 12.5px; color: var(--pq-muted); line-height: 1.5; }
        .pc-man-toast { position: fixed; left: 50%; bottom: 24px; transform: translate(-50%, 12px); opacity: 0; pointer-events: none; background: var(--pq-ink); color: #fff; font-size: 13.5px; font-weight: 600; padding: 10px 16px; border-radius: 999px; transition: opacity .15s ease, transform .15s ease; z-index: 50; max-width: calc(100vw - 32px); }
        .pc-man-toast.show { opacity: 1; transform: translate(-50%, 0); }
        .pc-man-toast.err { background: var(--pq-danger); }
        @media (prefers-reduced-motion: reduce) { .pc-man-toast { transition: none; } }
      `}</style>
    </section>
  );
}
