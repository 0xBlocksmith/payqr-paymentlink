/**
 * One place that turns ANY thrown value into something safe to show a merchant.
 *
 * Rules:
 *  1. Raw SDK / RPC / Worker / fetch text is NEVER returned to the UI. The only
 *     strings that pass through are ones we authored: mapped contract reverts
 *     (lib/contract.ts) and the widgets SDK's own `P2PError.userMessage`.
 *  2. A wallet cancel is not an error.
 *  3. A timeout is UNCERTAIN, not a failure — the transaction may still land.
 *     Callers must not offer "try again" for a financial write on `uncertain`.
 *  4. Technical detail goes to the console with a short reference id the user
 *     can quote to support.
 */
import { friendlyError, isUserCancel } from "./contract";
import { getLang, translate } from "./i18n";

export type ErrorKind = "cancelled" | "network" | "timeout" | "busy" | "service" | "contract" | "unknown";

export interface UserError {
  message: string;
  kind: ErrorKind;
  /** True when the action MAY have succeeded (timeout / lost connection mid-write). */
  uncertain: boolean;
  /** Short id, also written to the console with the full error. */
  ref: string;
  /**
   * The original technical message — DEVELOPMENT BUILDS ONLY (never set in
   * production). Lets a developer see the real cause on screen; users never do.
   */
  detail?: string;
}

/**
 * An error whose message WE wrote for the merchant (form validation). It is the
 * only kind of thrown text that is shown as-is.
 */
export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = "ValidationError"; }
}

const SENTINEL = "\u0000__unmapped__\u0000";

const NETWORK = /failed to fetch|network ?error|network request failed|load failed|fetch failed|err_internet|err_network|econn|enotfound|socket hang|offline|http request failed/i;
const TIMEOUT = /timed? ?out|timeout|took too long|waitfortransactionreceipt/i;
const BUSY = /\b429\b|rate.?limit|too many requests/i;
// The gas-sponsorship / bundler / account-abstraction layer failing on OUR side
// (not the merchant's money, not their input): a rejected paymaster policy, a
// bundler or UserOperation failure, an AAxx error code.
const SERVICE = /paymaster|sponsor|gas ?(policy|limit|spend)|user ?operation|bundler|\bAA\d{2}\b|policy.*(reject|denied|not allowed|violat)/i;

function refId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const tr = (key: string) => translate(key, getLang());

/** Classify without logging — exported for tests. */
export function classifyError(e: any): { kind: ErrorKind; mapped?: string } {
  const name = String(e?.name || "");
  const text = String(e?.shortMessage || e?.message || e || "");
  // A genuine wallet decline is a calm "cancelled" — but the cancel pattern also
  // matches phrases like "rejected the request", which a gas-sponsor / bundler
  // failure can contain. That is OUR side failing, not the user declining.
  if (isUserCancel(e) && !SERVICE.test(text)) return { kind: "cancelled" };
  // A submitted order whose outcome we could not read — never a plain failure.
  if (name === "OrderUncertainError") return { kind: "timeout" };
  if (name === "ValidationError") return { kind: "contract", mapped: String(e?.message || "") };
  if (name === "UnsupportedCurrencyError") {
    return { kind: "contract", mapped: translate("err.currencyUnavailable", getLang()).replace("{currency}", String(e?.currency || "")).trim() };
  }
  if (name === "AbortError" || name === "TimeoutError" || /Timeout/.test(name) || TIMEOUT.test(text)) {
    return { kind: "timeout" };
  }
  // A mapped contract revert / P2PError beats the generic patterns below (a
  // revert message can legitimately contain the word "network" or "UserOperation").
  const mapped = friendlyError(e, SENTINEL);
  if (mapped !== SENTINEL && mapped !== "Cancelled.") return { kind: "contract", mapped };
  if (BUSY.test(text)) return { kind: "busy" };
  if (SERVICE.test(text)) return { kind: "service" };
  if (NETWORK.test(text) || NETWORK.test(name)) return { kind: "network" };
  return { kind: "unknown" };
}

/**
 * @param fallbackKey i18n key used when nothing better is known (e.g.
 *        "err.createLink"). Never `e.message`.
 * @param uncertainKey i18n key used for a timeout on a WRITE, saying where to
 *        check (e.g. "err.uncertainLink").
 */
export function toUserError(
  e: any,
  opts: { fallbackKey?: string; uncertainKey?: string; context?: string } = {}
): UserError {
  const ref = refId();
  const { kind, mapped } = classifyError(e);
  // Developer-facing detail. Cancels are routine; everything else is logged.
  if (kind !== "cancelled") console.error(`[payqr:${ref}]${opts.context ? " " + opts.context : ""}`, e);

  const out = ((): UserError => {
  switch (kind) {
    case "cancelled":
      return { kind, ref, uncertain: false, message: tr("err.cancelled") };
    case "timeout":
      return { kind, ref, uncertain: true, message: tr(opts.uncertainKey || "err.timeout") };
    case "network":
      // A dropped connection during a write leaves the outcome unknown.
      return { kind, ref, uncertain: !!opts.uncertainKey, message: tr(opts.uncertainKey || "err.network") };
    case "busy":
      return { kind, ref, uncertain: false, message: tr("err.busy") };
    case "contract":
      return { kind, ref, uncertain: false, message: mapped as string };
    case "service":
      return { kind, ref, uncertain: false, message: tr("err.sponsor") };
    default:
      return { kind, ref, uncertain: false, message: tr(opts.fallbackKey || "err.unknown") };
  }
  })();
  if (process.env.NODE_ENV !== "production" && kind !== "cancelled") {
    out.detail = String(e?.shortMessage || e?.message || e || "").slice(0, 400);
  }
  return out;
}

/** "Reference: AB12CD" — appended where support may need to trace it. */
export const refLabel = (ref: string) => tr("err.ref").replace("{ref}", ref);
