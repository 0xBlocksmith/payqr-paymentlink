"use client";

/**
 * Manual UPI checkout: show the payee's UPI ID and the exact amount, let the
 * customer copy each one, and show how to open a UPI app so they can type
 * them in themselves. No `upi://` link, payment intent or app-launch URL is
 * ever created here: browsers have no documented way to open another app, so
 * "Open UPI App" only shows the steps to do it by hand.
 *
 * This component NEVER reports a payment as made. Opening an app or copying a
 * value changes nothing about the order; the parent keeps its own "I've paid"
 * step, which only asks the protocol to verify — the order stays pending until
 * its on-chain status says otherwise.
 */
import { useEffect, useRef, useState } from "react";
import { usePayerT } from "../lib/payerI18n";
import { copyText } from "../lib/clipboard";

type Field = "upi" | "amount";

export function UpiManualCheckout({ upiId, amount, amountDisplay }: { upiId: string; amount: string; amountDisplay: string }) {
  const { t } = usePayerT();
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copiedField, setCopiedField] = useState<Field | null>(null);
  const [showApps, setShowApps] = useState(false);
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

      <button type="button" className="pc-man-open" onClick={() => setShowApps((v) => !v)} aria-expanded={showApps}>
        {t("pl.man.openApp")}
      </button>

      {showApps && (
        <div className="pc-man-apps" role="status">
          <div className="pc-man-apps-h">{t("pl.man.noLaunch")}</div>
          <div className="pc-man-apps-row">
            {["Google Pay", "PhonePe", "Paytm"].map((name) => (
              <span key={name} className="pc-man-app">{name}</span>
            ))}
          </div>
        </div>
      )}

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
        .pc-man-open { width: 100%; margin-top: 12px; border: none; cursor: pointer; font-family: inherit; font-size: 16px; font-weight: 600; color: #fff; padding: 15px 24px; border-radius: 999px; background: linear-gradient(180deg, #4b78ee 0%, #3a64dc 100%); box-shadow: 0 10px 22px -12px rgba(58,100,220,0.55); }
        .pc-man-open:focus-visible, .pc-man-copy:focus-visible { outline: 3px solid rgba(58,100,220,0.3); outline-offset: 2px; }
        .pc-man-apps { margin-top: 10px; }
        .pc-man-apps-h { font-size: 12.5px; color: var(--pq-muted); line-height: 1.5; margin-bottom: 8px; }
        .pc-man-apps-row { display: flex; flex-wrap: wrap; gap: 8px; }
        .pc-man-app { flex: 1 1 90px; text-align: center; border: 1px solid var(--pq-line); color: var(--pq-ink); border-radius: 12px; padding: 10px 8px; font-size: 13.5px; font-weight: 600; }
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
