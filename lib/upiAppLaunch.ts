/**
 * Open a UPI app WITHOUT starting a payment.
 *
 * Each app is opened with its bare URL scheme (`phonepe://`), with no path,
 * payee, amount or order. It is not a payment intent and never a `upi://` link.
 *
 * STATUS: these schemes are registered by the apps and are recognised as UPI
 * app schemes by payment SDKs (e.g. Cashfree's WebView/iOS handlers), but no
 * app documents a bare "just open me" link, so behaviour is device- and
 * app-version-dependent. Launching therefore reports an outcome and the UI
 * falls back to "open it yourself" when the page never leaves the foreground.
 * Do NOT try `intent:` launcher URLs instead: on Android Chrome they open the
 * app's Play Store page (Chrome only resolves BROWSABLE activities).
 */

export type Platform = "android" | "ios" | "desktop";

export interface UpiApp {
  id: "gpay" | "phonepe" | "paytm";
  label: string;
  /** Bare scheme URL: scheme + "://" and nothing else. */
  url: string;
}

export const UPI_APPS: readonly UpiApp[] = [
  { id: "gpay", label: "Google Pay", url: "tez://" },
  { id: "phonepe", label: "PhonePe", url: "phonepe://" },
  { id: "paytm", label: "Paytm", url: "paytmmp://" },
];

export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform {
  if (/android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  // iPadOS 13+ reports a desktop Mac UA; touch points tell them apart.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return "desktop";
}

export type LaunchOutcome =
  /** The page lost focus/visibility after the attempt: an app probably opened. Not proof. */
  | "likely-opened"
  /** The attempt ran but the page stayed in the foreground: show manual steps. */
  | "no-effect"
  /** Not a phone/tablet: nothing to launch. */
  | "unsupported";

export interface LaunchEnv {
  userAgent: string;
  maxTouchPoints?: number;
  navigate: (url: string) => void;
  /** Resolves after ms, or earlier with true if the page was hidden/blurred meanwhile. */
  waitForLeave: (ms: number) => Promise<boolean>;
}

export const LAUNCH_DETECT_MS = 1600;

function browserLaunchEnv(): LaunchEnv {
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    navigate: (url) => { window.location.href = url; },
    waitForLeave: (ms) =>
      new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (left: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", onVis);
          window.removeEventListener("pagehide", onLeave);
          window.removeEventListener("blur", onLeave);
          resolve(left);
        };
        const onVis = () => { if (document.visibilityState === "hidden") finish(true); };
        const onLeave = () => finish(true);
        const timer = setTimeout(() => finish(false), ms);
        document.addEventListener("visibilitychange", onVis);
        window.addEventListener("pagehide", onLeave);
        window.addEventListener("blur", onLeave);
      }),
  };
}

/** Call synchronously from a click handler; browsers ignore app launches without a user gesture. */
export async function launchUpiApp(app: UpiApp, env?: LaunchEnv): Promise<LaunchOutcome> {
  if (!env && typeof window === "undefined") return "unsupported";
  const e = env ?? browserLaunchEnv();
  if (detectPlatform(e.userAgent, e.maxTouchPoints ?? 0) === "desktop") return "unsupported";
  const left = e.waitForLeave(LAUNCH_DETECT_MS); // listen before navigating
  try {
    e.navigate(app.url);
  } catch {
    return "no-effect";
  }
  return (await left) ? "likely-opened" : "no-effect";
}
