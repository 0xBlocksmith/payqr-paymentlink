/**
 * Synchronous in-flight guard for irreversible actions.
 *
 * React state (`busy`) updates on the NEXT render, so two taps in the same tick
 * — or a tap while a step-up modal is open — both see `busy === false` and both
 * fire. The lock here is a plain closure variable flipped BEFORE the first
 * `await` (including the step-up), so a second call is refused immediately.
 *
 * It never retries and never re-runs `fn`: a refused call is simply dropped.
 */
export type GuardResult<T> =
  | { ok: true; reason: "ok"; value: T }
  | { ok: false; reason: "busy" | "stepup" | "error"; error?: unknown };

export function createGuard() {
  let inFlight = false;
  return {
    get busy() { return inFlight; },
    async run<T>(fn: () => Promise<T>, opts: { stepUp?: () => Promise<boolean> } = {}): Promise<GuardResult<T>> {
      if (inFlight) return { ok: false, reason: "busy" };
      inFlight = true;
      try {
        if (opts.stepUp && !(await opts.stepUp())) return { ok: false, reason: "stepup" };
        return { ok: true, reason: "ok", value: await fn() };
      } catch (error) {
        return { ok: false, reason: "error", error };
      } finally {
        inFlight = false;
      }
    },
  };
}
