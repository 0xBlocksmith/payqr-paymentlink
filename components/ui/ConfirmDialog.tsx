"use client";

import { useEffect, useRef, useId, type ReactNode } from "react";
import { useT } from "../../lib/i18n";

/**
 * Accessible confirmation dialog — the one pattern for every irreversible
 * action (revoke a link, discard a placed order, send funds, appeal a dispute).
 *
 * Handles what the hand-rolled sheets did not: role="dialog" + aria-modal,
 * labelled title, Escape to cancel (blocked while `busy`), focus moved in and
 * restored on close, and Tab kept inside the dialog.
 *
 * Reuses the existing .confirm-overlay / .confirm-sheet styling.
 */
export function ConfirmDialog({
  open, title, children, confirmLabel, cancelLabel, tone = "default",
  busy = false, confirmDisabled = false, error, onConfirm, onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  busy?: boolean;
  confirmDisabled?: boolean;
  error?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const last = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    last.current = document.activeElement as HTMLElement | null;
    // Focus the safe action (Cancel) first for destructive dialogs.
    const t0 = setTimeout(() => {
      const sel = tone === "danger" ? "[data-cd-cancel]" : "[data-cd-confirm]";
      (sheet.current?.querySelector(sel) as HTMLElement | null)?.focus();
    }, 0);
    return () => { clearTimeout(t0); last.current?.focus?.(); };
  }, [open, tone]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) { e.stopPropagation(); onCancel(); return; }
      if (e.key !== "Tab" || !sheet.current) return;
      const f = sheet.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      const first = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, busy, onCancel]);

  if (!open) return null;
  return (
    <div className="confirm-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div
        ref={sheet}
        className="confirm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-h" id={titleId}>{title}</div>
        {children && <div className="confirm-body">{children}</div>}
        {error && <div className="ui-err-inline" role="alert">{error}</div>}
        <div className="confirm-actions">
          <button className="btn ghost" data-cd-cancel disabled={busy} onClick={onCancel}>
            {cancelLabel ?? t("ui.cancel")}
          </button>
          <button
            className={"btn" + (tone === "danger" ? " danger" : "")}
            data-cd-confirm
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
          >
            {busy ? t("ui.loading") : (confirmLabel ?? t("ui.confirm"))}
          </button>
        </div>
      </div>
    </div>
  );
}
