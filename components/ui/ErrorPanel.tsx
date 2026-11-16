"use client";

import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { fill } from "../../lib/format";
import type { UserError } from "../../lib/errors";

/**
 * One way to show an error. Takes the output of toUserError() (or a plain,
 * already-authored string) and renders: what happened, whether the outcome is
 * unknown, a support reference, and an optional recovery action.
 *
 *  - cancelled  → calm neutral note, not a red error
 *  - uncertain  → amber "we're not sure" note (never claims failure)
 *  - otherwise  → red error
 */
export function ErrorPanel({
  error, onRetry, retryLabel, action, compact = false,
}: {
  error: UserError | string | null | undefined;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra recovery action, e.g. a link to Transactions. */
  action?: ReactNode;
  compact?: boolean;
}) {
  const { t } = useT();
  if (!error) return null;
  const e: UserError = typeof error === "string"
    ? { message: error, kind: "unknown", uncertain: false, ref: "" }
    : error;
  const tone = e.kind === "cancelled" ? "neutral" : e.uncertain ? "warn" : "danger";
  return (
    <div className={`ui-err ui-err-${tone}${compact ? " ui-err-compact" : ""}`} role={tone === "neutral" ? "status" : "alert"}>
      <div className="ui-err-msg">{e.message}</div>
      {(onRetry || action) && (
        <div className="ui-err-actions">
          {onRetry && e.kind !== "cancelled" && !e.uncertain && (
            <button className="btn small ghost" onClick={onRetry}>{retryLabel ?? t("ui.retry")}</button>
          )}
          {action}
        </div>
      )}
      {e.ref && tone !== "neutral" && (
        <div className="ui-err-ref">{fill(t("err.ref"), { ref: e.ref })}</div>
      )}
      {e.detail && (
        <details className="ui-err-detail">
          <summary>Developer details (dev build only)</summary>
          <code>{e.detail}</code>
        </details>
      )}
    </div>
  );
}
