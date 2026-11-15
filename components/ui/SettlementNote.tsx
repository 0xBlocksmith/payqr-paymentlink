"use client";

import { useT } from "../../lib/i18n";
import { fill, fmtLockWindow, fmtDay } from "../../lib/format";
import { useLockPeriod } from "../useLockPeriod";
import { Skeleton } from "./LoadingState";

/**
 * The single, reusable settlement message. Reads the REAL on-chain lock for the
 * given currency — never a hardcoded number — and degrades to an explicit
 * "unavailable" state (with a re-check) if it can't be read.
 *
 *  variant="line"  one concise sentence (forms, success screens)
 *  variant="card"  a bordered info panel (onboarding, dashboard, settings)
 *
 * Pass `completedAt` (unix s) on a success screen to show the concrete date the
 * funds become available: "Available to withdraw on 29 November".
 */
export function SettlementNote({
  currency, variant = "line", completedAt, className = "",
}: {
  currency: string | null | undefined;
  variant?: "line" | "card";
  completedAt?: number | null;
  className?: string;
}) {
  const { t, lang } = useT();
  const { secs, loading, error, refetch } = useLockPeriod(currency);
  const window = fmtLockWindow(secs, lang);
  const cls = `sn sn-${variant} ${className}`.trim();

  if (!currency) return null;
  if (loading) return <div className={cls}><Skeleton w="70%" h={14} /></div>;
  if (error || !window) {
    return (
      <div className={cls} role="status">
        <span>{t("sn.unavailable")}</span>{" "}
        <button className="linklike" onClick={() => refetch()}>{t("sn.retry")}</button>
      </div>
    );
  }
  const date = completedAt && secs ? fmtDay(completedAt + secs, lang, secs < 3 * 86400) : "";
  return (
    <div className={cls}>
      {variant === "card" && <div className="sn-title">{t("sn.window")}</div>}
      <span>
        {date
          ? fill(t("sn.availableOn"), { date })
          : fill(t(variant === "card" ? "sn.after" : "sn.afterShort"), { window })}
      </span>
    </div>
  );
}
