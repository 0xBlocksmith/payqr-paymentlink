/**
 * ONE status vocabulary for every merchant screen (transactions, receipt,
 * dashboard, wallet). Previously "Locked (settling)" meant both "customer hasn't
 * paid yet" and "paid, in the hold period", and "Received" was used for money
 * that could not be withdrawn.
 *
 *   waiting          customer has not completed payment (order still matching)
 *   received_locked  paid; inside the settlement hold — has an unlock date
 *   received_unknown paid; hold period could not be determined (never guess a date)
 *   available        paid and past its unlock time
 *   cancelled        order cancelled
 *   wd_processing    a withdrawal we submitted that is not yet confirmed
 *   wd_partial       USDC reached the wallet but the onward transfer did not complete
 *   wd_failed        a withdrawal that did not go through
 *   withdrawn        a completed withdrawal
 *
 * NOTE: "available" on a sale row is DERIVED (completion + lock). USDC is
 * fungible, so it does not mean this specific sale has not already been
 * withdrawn. The Withdraw page, which reads real on-chain buckets, remains the
 * source of truth for what can be withdrawn.
 */
import { estimateUnlock } from "./format";

export type StatusKey =
  | "waiting" | "received_locked" | "received_unknown" | "available" | "cancelled"
  | "wd_processing" | "wd_partial" | "wd_failed" | "withdrawn";

export type StatusTone = "neutral" | "warn" | "success" | "danger" | "info";

export interface StatusRow {
  /** 'matching' | 'settled' | 'cancelled' (orders) or 'withdrawn' | 'processing' | 'partial' | 'failed' (withdrawals) */
  status: string;
  kind?: string;
  completedAt?: number | null;
  /** Real on-chain unlock time (unix s), when known — beats the estimate. */
  unlockAt?: number | null;
}

export interface ResolvedStatus {
  key: StatusKey;
  tone: StatusTone;
  /** Unix seconds when the funds become withdrawable, if known. */
  unlockAt: number | null;
  /** i18n key for the label. `status.receivedOn` takes a {date}. */
  labelKey: string;
  /** True when `unlockAt` is derived from the lock period rather than a bucket. */
  estimated: boolean;
}

const LABEL: Record<StatusKey, string> = {
  waiting: "status.waiting",
  received_locked: "status.receivedOn",
  received_unknown: "status.receivedSettling",
  available: "status.available",
  cancelled: "status.cancelled",
  wd_processing: "status.wdProcessing",
  wd_partial: "status.wdPartial",
  wd_failed: "status.wdFailed",
  withdrawn: "status.withdrawn",
};

const TONE: Record<StatusKey, StatusTone> = {
  waiting: "info",
  received_locked: "warn",
  received_unknown: "warn",
  available: "success",
  cancelled: "neutral",
  wd_processing: "info",
  wd_partial: "danger",
  wd_failed: "danger",
  withdrawn: "neutral",
};

const make = (key: StatusKey, unlockAt: number | null = null, estimated = false): ResolvedStatus =>
  ({ key, tone: TONE[key], unlockAt, labelKey: LABEL[key], estimated });

export function resolveStatus(row: StatusRow, lockSecs: number | null | undefined, nowSec: number): ResolvedStatus {
  const isWithdrawal = !!row.kind && row.kind !== "sale";
  if (isWithdrawal || row.status === "withdrawn" || row.status === "processing" || row.status === "partial" || row.status === "failed") {
    if (row.status === "processing") return make("wd_processing");
    if (row.status === "partial") return make("wd_partial");
    if (row.status === "failed") return make("wd_failed");
    return make("withdrawn");
  }
  if (row.status === "cancelled") return make("cancelled");
  if (row.status !== "settled") return make("waiting");

  const real = row.unlockAt && row.unlockAt > 0 ? row.unlockAt : null;
  const unlockAt = real ?? estimateUnlock(row.completedAt, lockSecs);
  if (unlockAt == null) return make("received_unknown");
  return unlockAt > nowSec ? make("received_locked", unlockAt, real == null) : make("available", unlockAt, real == null);
}
