"use client";

import { useT } from "../../lib/i18n";
import { fill } from "../../lib/format";
import type { UserError } from "../../lib/errors";

/**
 * An error in the soft glass style (for the glass pages): what happened in plain
 * words, then — only for real problems — a quiet "quote this code to support" line.
 * A cancel is shown as a calm note, not an error. Development builds also get an
 * expandable "developer details" line with the original technical message.
 */
export function GlassError({ error }: { error: UserError | string | null | undefined }) {
  const { t } = useT();
  if (!error) return null;
  const e: UserError = typeof error === "string"
    ? { message: error, kind: "unknown", uncertain: false, ref: "" }
    : error;
  const tone = e.kind === "cancelled" ? "calm" : e.uncertain ? "wait" : "problem";
  return (
    <div className={`lg-err lg-err--${tone}`} role={tone === "calm" ? "status" : "alert"}>
      <p className="lg-err-msg">{e.message}</p>
      {e.ref && tone !== "calm" && <p className="lg-err-ref">{fill(t("err.ref"), { ref: e.ref })}</p>}
      {e.detail && (
        <details className="lg-err-detail">
          <summary>Developer details (dev build only)</summary>
          <code>{e.detail}</code>
        </details>
      )}
    </div>
  );
}
