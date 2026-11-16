"use client";

import { useT } from "../../lib/i18n";
import { fill, fmtDay } from "../../lib/format";
import { resolveStatus, type StatusRow } from "../../lib/status";

/**
 * Status badge for any sale or withdrawal, in the one shared vocabulary.
 * `lockSecs` is the on-chain lock for the row's currency (null if unknown —
 * the badge then says "Received · settling" rather than guessing a date).
 */
export function OrderStatus({
  row, lockSecs, nowSec, showDate = true,
}: {
  row: StatusRow;
  lockSecs: number | null | undefined;
  nowSec: number;
  showDate?: boolean;
}) {
  const { t, lang } = useT();
  const s = resolveStatus(row, lockSecs, nowSec);
  const date = s.unlockAt ? fmtDay(s.unlockAt, lang, (lockSecs ?? 0) < 3 * 86400) : "";
  const label = s.key === "received_locked" && date && showDate
    ? fill(t("status.receivedOn"), { date })
    : s.key === "received_locked" ? t("status.receivedSettling") : t(s.labelKey);
  return (
    <span className={`st-badge st-${s.tone}`} title={s.estimated ? t("status.estimated") : undefined}>
      {label}
    </span>
  );
}
