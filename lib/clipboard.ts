/**
 * Clipboard writes for the manual UPI checkout.
 *
 * Call copyText() only from a click/tap handler: browsers (Safari especially)
 * reject clipboard writes that are not tied to a user gesture, and the legacy
 * fallback below needs one too.
 */

export type CopyResult =
  | { ok: true; method: "clipboard-api" | "exec-command" }
  | { ok: false; reason: "empty" | "unsupported" | "denied" };

export interface ClipboardEnv {
  clipboard?: { writeText?: (text: string) => Promise<void> } | null;
  isSecureContext?: boolean;
  /** Legacy path; returns whether the copy command succeeded. */
  legacyCopy?: (text: string) => boolean;
}

/** Old-browser path: copy through a temporary, off-screen textarea. */
function legacyExecCommandCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}

function browserEnv(): ClipboardEnv {
  if (typeof navigator === "undefined") return {};
  return {
    clipboard: navigator.clipboard,
    isSecureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    legacyCopy: legacyExecCommandCopy,
  };
}

/** True when some copy path exists in this browser (does not prove it will succeed). */
export function canCopy(env: ClipboardEnv = browserEnv()): boolean {
  return (!!env.isSecureContext && typeof env.clipboard?.writeText === "function") || !!env.legacyCopy;
}

export async function copyText(text: string, env: ClipboardEnv = browserEnv()): Promise<CopyResult> {
  if (!text) return { ok: false, reason: "empty" };

  if (env.isSecureContext && typeof env.clipboard?.writeText === "function") {
    try {
      await env.clipboard.writeText(text);
      return { ok: true, method: "clipboard-api" };
    } catch {
      // Permission denied or no gesture: try the legacy path before giving up.
    }
  }
  if (env.legacyCopy) {
    return env.legacyCopy(text) ? { ok: true, method: "exec-command" } : { ok: false, reason: "denied" };
  }
  return { ok: false, reason: env.clipboard ? "denied" : "unsupported" };
}
