/**
 * What the withdraw result page may offer after a failure. The rule is that a
 * retry must never repeat a money move that already happened.
 *
 *  • uncertain (timeout / lost connection)  → "unknown", NO retry (it may have landed)
 *  • step 1 (pull into the wallet) confirmed:
 *      – external destination               → retry ONLY the forward
 *      – own wallet                         → nothing left to do, no retry
 *  • nothing confirmed, definite failure    → safe to start over ("whole")
 */
export type RetryKind = "whole" | "forward" | undefined;

export function withdrawFailurePolicy(o: { uncertain: boolean; step1Confirmed: boolean; external: boolean }): {
  status: "unknown" | "error";
  retry: RetryKind;
} {
  if (o.uncertain) return { status: "unknown", retry: undefined };
  if (o.step1Confirmed) return { status: "error", retry: o.external ? "forward" : undefined };
  return { status: "error", retry: "whole" };
}
