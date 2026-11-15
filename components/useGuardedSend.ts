"use client";

import { useCallback, useRef, useState } from "react";
import { createGuard, type GuardResult } from "../lib/guard";
import { toUserError, type UserError } from "../lib/errors";

/**
 * The shared wrapper for every action that moves money or cannot be undone.
 *
 *  - The in-flight lock is a plain ref set BEFORE the first await (including
 *    the step-up prompt), so a double tap or a tap while the verification modal
 *    is open can never start a second send. `busy` (state) drives the UI only.
 *  - Optional step-up verification runs inside the lock.
 *  - Errors come back already translated for the user (never raw), with an
 *    `uncertain` flag when the outcome is unknown.
 *  - It NEVER retries. A refused or failed call is simply reported.
 *
 *  const send = useGuardedSend({ stepUp: requireStepUp });
 *  const r = await send.run(async () => { ...irreversible work... },
 *                           { context: "withdraw", uncertainKey: "err.uncertainWithdraw" });
 *  if (!r.ok && r.reason === "error") show(r.error)
 */
export type SendOutcome<T> =
  | { ok: true; reason: "ok"; value: T }
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "stepup" }
  | { ok: false; reason: "error"; error: UserError; raw: unknown };

export function useGuardedSend(defaults: { stepUp?: () => Promise<boolean> } = {}) {
  const guard = useRef(createGuard()).current;
  const [busy, setBusy] = useState(false);
  const stepUpRef = useRef(defaults.stepUp);
  stepUpRef.current = defaults.stepUp;

  const run = useCallback(
    async <T,>(
      fn: () => Promise<T>,
      opts: { context?: string; fallbackKey?: string; uncertainKey?: string; skipStepUp?: boolean } = {}
    ): Promise<SendOutcome<T>> => {
      if (guard.busy) return { ok: false, reason: "busy" };
      setBusy(true);
      let r: GuardResult<T>;
      try {
        r = await guard.run(fn, { stepUp: opts.skipStepUp ? undefined : stepUpRef.current });
      } finally {
        setBusy(false);
      }
      if (r.reason === "ok") return { ok: true, reason: "ok", value: r.value };
      if (r.reason === "error") {
        return { ok: false, reason: "error", raw: r.error, error: toUserError(r.error, opts) };
      }
      return r.reason === "busy" ? { ok: false, reason: "busy" } : { ok: false, reason: "stepup" };
    },
    [guard]
  );

  return { run, busy };
}
