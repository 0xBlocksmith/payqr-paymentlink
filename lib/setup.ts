/**
 * First-run setup state for the dashboard checklist. Pure so the "what is done /
 * what is next" logic is testable and the UI just renders it.
 *
 * Steps (in order). A step is "done" only from real signals, never assumed:
 *   learn     the merchant has seen how PayQR works (tour flag)
 *   register  registered on-chain (here or on a previous contract)
 *   payout    a payout handle is saved (non-empty on-chain blob)
 *   first     they have created a first sale or payment link
 *   track     at least one payment has been received
 */
export type SetupStepId = "learn" | "register" | "payout" | "first" | "track";

export interface SetupSignals {
  tourSeen: boolean;
  registered: boolean | undefined;
  /** getMerchantInfo[0] — the encrypted payout blob ("0x"/"" when unset). */
  payoutBlob: string | undefined;
  /** Any sale/order row exists, or a payment link was created on this device. */
  hasFirstSaleOrLink: boolean;
  receivedCount: number;
}

export interface SetupStep { id: SetupStepId; done: boolean }

export function payoutIsSet(blob: string | undefined | null): boolean {
  return !!blob && blob !== "0x" && blob.length > 2;
}

export function computeSetup(s: SetupSignals): { steps: SetupStep[]; doneCount: number; total: number; complete: boolean; next: SetupStepId | null } {
  const steps: SetupStep[] = [
    { id: "learn", done: s.tourSeen },
    { id: "register", done: s.registered === true },
    { id: "payout", done: s.registered === true && payoutIsSet(s.payoutBlob) },
    { id: "first", done: s.hasFirstSaleOrLink },
    { id: "track", done: s.receivedCount > 0 },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const next = steps.find((x) => !x.done)?.id ?? null;
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length, next };
}

const key = (a?: string | null) => `payqr.setupDismissed.${String(a || "").toLowerCase()}`;
export function setupDismissed(address?: string | null): boolean {
  if (!address) return false;
  try { return localStorage.getItem(key(address)) === "1"; } catch { return false; }
}
export function dismissSetup(address?: string | null): void {
  if (!address) return;
  try { localStorage.setItem(key(address), "1"); } catch { /* ignore */ }
}
