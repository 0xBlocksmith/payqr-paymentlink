/**
 * Locale-aware durations, dates and relative times for the merchant app.
 *
 * Replaces two hand-rolled copies of `fmtRemaining` (withdraw page and
 * PrevTerminalWithdraw) that always rounded UP to whole days — so a 36-hour
 * settlement window read "2 days", and a bucket with five minutes left read
 * "in 1 day". Everything here goes through Intl so hi / pt / es read correctly.
 */
import type { Lang } from "./i18n";

const LOCALES: Record<string, string> = { en: "en", hi: "hi-IN", pt: "pt-BR", es: "es" };
export const localeFor = (lang: string): string => LOCALES[lang] ?? "en";

function unit(n: number, u: "day" | "hour" | "minute", lang: string): string {
  try {
    return new Intl.NumberFormat(localeFor(lang), { style: "unit", unit: u, unitDisplay: "long" }).format(n);
  } catch {
    return `${n} ${u}${n === 1 ? "" : "s"}`;
  }
}

const DAY = 86400;
const HOUR = 3600;

/**
 * A settlement WINDOW length ("how long is the lock"), honest to its real size:
 * whole days read as days ("15 days"); anything shorter than three days that is
 * not a whole number of days reads in hours ("36 hours"), so 1.5 days is never
 * shown as "2 days". Returns "" for a missing / non-positive value so callers
 * can show an "unavailable" state instead of inventing a number.
 */
export function fmtLockWindow(secs: number | bigint | null | undefined, lang: Lang | string = "en"): string {
  const s = Number(secs);
  if (secs == null || !Number.isFinite(s) || s <= 0) return "";
  if (s % DAY === 0) return unit(s / DAY, "day", lang);
  if (s < 3 * DAY) return unit(Math.ceil(s / HOUR), "hour", lang);
  return unit(Math.ceil(s / DAY), "day", lang);
}

/**
 * Time REMAINING until something unlocks. Rounds up within the largest sensible
 * unit so it never reads "0": ≥2 days → days, ≥1 hour → hours, else minutes.
 * Returns "" when nothing remains — callers decide what "ready" looks like
 * (this used to return the word "ready", which rendered as "in ready").
 */
export function fmtRemaining(secs: number, lang: Lang | string = "en"): string {
  if (!Number.isFinite(secs) || secs <= 0) return "";
  if (secs >= 2 * DAY) return unit(Math.ceil(secs / DAY), "day", lang);
  if (secs >= HOUR) return unit(Math.ceil(secs / HOUR), "hour", lang);
  return unit(Math.max(1, Math.ceil(secs / 60)), "minute", lang);
}

/** "29 November" (+ time when `withTime`). `tsSec` is unix SECONDS. */
export function fmtDay(tsSec: number, lang: Lang | string = "en", withTime = false): string {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return "";
  try {
    return new Intl.DateTimeFormat(localeFor(lang), {
      day: "numeric", month: "long",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
    }).format(new Date(tsSec * 1000));
  } catch {
    return new Date(tsSec * 1000).toLocaleDateString();
  }
}

/** Full date + time for detail views. */
export function fmtDateTime(tsSec: number, lang: Lang | string = "en"): string {
  if (!Number.isFinite(tsSec) || tsSec <= 0) return "";
  try {
    return new Intl.DateTimeFormat(localeFor(lang), { dateStyle: "medium", timeStyle: "short" }).format(new Date(tsSec * 1000));
  } catch {
    return new Date(tsSec * 1000).toLocaleString();
  }
}

/** "5 minutes ago" / "just now". `tsMs` is unix MILLISECONDS. */
export function fmtAgo(tsMs: number, lang: Lang | string = "en", nowMs = Date.now()): string {
  const diff = Math.round((tsMs - nowMs) / 1000); // negative = past
  const rtf = (() => { try { return new Intl.RelativeTimeFormat(localeFor(lang), { numeric: "auto" }); } catch { return null; } })();
  const abs = Math.abs(diff);
  if (!rtf) return "";
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / DAY), "day");
}

/** Fill `{name}` placeholders. The i18n `t()` has no interpolation of its own. */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * When a received sale becomes withdrawable. `completedAtSec` is the order's
 * completion time and `lockSecs` the currency's on-chain lock. This is an
 * ESTIMATE derived from the lock — the authoritative figure is the on-chain
 * bucket's `unlockTimestamp` (use that where buckets are available). Returns
 * null when either input is unknown so nothing is invented.
 */
export function estimateUnlock(completedAtSec: number | null | undefined, lockSecs: number | null | undefined): number | null {
  if (!completedAtSec || !lockSecs || lockSecs <= 0) return null;
  return completedAtSec + lockSecs;
}

/**
 * A ticking countdown: "14d 23:59:41" when `withDays`, otherwise "36:00:00"
 * (total hours). Never negative.
 */
export function fmtCountdown(secs: number, withDays = true): string {
  const s = Math.max(0, Math.ceil(Number.isFinite(secs) ? secs : 0));
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = Math.floor(s / 86400);
  const h = withDays ? Math.floor((s % 86400) / 3600) : Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return withDays ? `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}
