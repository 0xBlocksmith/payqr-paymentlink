"use client";

import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

/**
 * A loading indicator that is honest about waiting. After `slowAfterMs` it says
 * so; after `timeoutMs` it stops spinning and offers a retry/reload instead of
 * an endless spinner. For operations that are genuinely slow (wallet init,
 * chain confirmation, P2P matching) pass a `label` describing the stage.
 */
export function LoadingState({
  label, slowAfterMs = 8000, timeoutMs = 25000, onRetry, inline = false,
}: {
  label?: string;
  slowAfterMs?: number;
  timeoutMs?: number;
  onRetry?: () => void;
  inline?: boolean;
}) {
  const { t } = useT();
  const [phase, setPhase] = useState<"loading" | "slow" | "timeout">("loading");
  useEffect(() => {
    const a = setTimeout(() => setPhase("slow"), slowAfterMs);
    const b = setTimeout(() => setPhase("timeout"), timeoutMs);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [slowAfterMs, timeoutMs]);

  return (
    <div className={"ui-loading" + (inline ? " inline" : "")} role="status" aria-live="polite">
      {phase !== "timeout" && <span className="ui-spinner" aria-hidden="true" />}
      <span>{label ?? t("ui.loading")}</span>
      {phase === "slow" && <span className="muted"> · {t("ui.slow")}</span>}
      {phase === "timeout" && (
        <>
          <span className="muted"> · {t("ui.slow")}</span>
          <button className="btn small ghost" onClick={onRetry ?? (() => window.location.reload())}>
            {onRetry ? t("ui.retry") : t("ui.refresh")}
          </button>
        </>
      )}
    </div>
  );
}

/** Block placeholder while data loads — use instead of rendering "0.00". */
export function Skeleton({ w = "100%", h = 16, r = 8 }: { w?: number | string; h?: number; r?: number }) {
  return <span className="ui-skel" aria-hidden="true" style={{ width: w, height: h, borderRadius: r }} />;
}
