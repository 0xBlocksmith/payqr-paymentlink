"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Clipboard copy that tells the truth. The old call sites did
 * `navigator.clipboard?.writeText(x).catch(() => {})` and showed "Copied"
 * regardless — a blocked clipboard (insecure context, in-app browser, denied
 * permission) looked like success.
 *
 *   const { copy, copiedKey, failedKey } = useCopy();
 *   <button onClick={() => copy(url, "row-1")}>{copiedKey === "row-1" ? "Copied" : "Copy"}</button>
 *
 * Falls back to a hidden-textarea execCommand copy before reporting failure.
 */
export function useCopy(resetMs = 1600) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((ok: boolean, key: string) => {
    if (timer.current) clearTimeout(timer.current);
    setCopiedKey(ok ? key : null);
    setFailedKey(ok ? null : key);
    timer.current = setTimeout(() => { setCopiedKey(null); setFailedKey(null); }, resetMs);
  }, [resetMs]);

  const copy = useCallback(async (text: string, key = "default"): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        flash(true, key);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      flash(ok, key);
      return ok;
    } catch {
      flash(false, key);
      return false;
    }
  }, [flash]);

  return { copy, copiedKey, failedKey };
}
