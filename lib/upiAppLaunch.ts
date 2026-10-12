/**
 * Open a UPI app WITHOUT starting a payment.
 *
 * This module never builds `upi://` URIs, payment intents or any URL that
 * carries a payee, amount or order. It can only ask the OS to open an app's
 * launcher screen; the customer enters the payee and amount themselves.
 *
 * What is (and is not) supported:
 *
 * - Android + Chrome: Chrome documents `intent:` URLs
 *   (developer.chrome.com/docs/android/intents), including `package=`. A
 *   launcher-style intent (`action=MAIN`, `category=LAUNCHER`, `package=<id>`)
 *   is built here. Chrome's docs state that only activities declaring
 *   `android.intent.category.BROWSABLE` can be invoked this way, and an app's
 *   launcher activity normally does not, so this MAY be a no-op on a given
 *   device/app version. It has NOT been verified on-device for any of the apps
 *   below. Every launch is therefore treated as best-effort: the caller must
 *   detect "nothing happened" (see launchUpiApp) and show manual steps.
 * - The package ids are the apps' Google Play listing ids.
 * - iOS: no documented, supported way for a web page to open an arbitrary
 *   third-party app's home screen. Custom URL schemes are app-private and
 *   undocumented, so none is used. iOS gets manual instructions only.
 * - Desktop / other: nothing to launch; manual instructions only.
 */

export type Platform = "android" | "ios" | "desktop";

export interface UpiApp {
  id: "gpay" | "phonepe" | "paytm";
  label: string;
  /** Google Play package id. */
  androidPackage: string;
}

export const UPI_APPS: readonly UpiApp[] = [
  { id: "gpay", label: "Google Pay", androidPackage: "com.google.android.apps.nbu.paisa.user" },
  { id: "phonepe", label: "PhonePe", androidPackage: "com.phonepe.app" },
  { id: "paytm", label: "Paytm", androidPackage: "net.one97.paytm" },
];

export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform {
  if (/android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  // iPadOS 13+ reports a desktop Mac UA; touch points tell them apart.
  if (/Macintosh/i.test(userAgent) && maxTouchPoints > 1) return "ios";
  return "desktop";
}

/** Chrome-family browsers on Android handle `intent:` URLs; others (Firefox, in-app webviews) may not. */
export function supportsAndroidIntents(userAgent: string): boolean {
  return /android/i.test(userAgent) && /Chrome\/\d+/i.test(userAgent) && !/\bwv\b|; wv\)|FBAN|FBAV|Instagram|Line\//i.test(userAgent);
}

/** Launcher intent for a package id. Carries no payee, amount or order data. */
export function buildAndroidLaunchIntent(androidPackage: string): string {
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(androidPackage)) {
    throw new Error("invalid package id");
  }
  return (
    "intent://#Intent;" +
    "action=android.intent.action.MAIN;" +
    "category=android.intent.category.LAUNCHER;" +
    `package=${androidPackage};` +
    "end"
  );
}

export type LaunchOutcome =
  /** The page lost focus/visibility after the attempt: an app probably opened. Not proof. */
  | "likely-opened"
  /** The attempt ran but the page stayed in the foreground: show manual steps. */
  | "no-effect"
  /** No supported mechanism on this platform/browser: show manual steps. */
  | "unsupported";

export interface LaunchEnv {
  userAgent: string;
  maxTouchPoints?: number;
  /** Performs the navigation to the intent URL. */
  navigate: (url: string) => void;
  isPageHidden: () => boolean;
  /** Resolves after ms, or earlier with true if the page was hidden/blurred meanwhile. */
  waitForLeave: (ms: number) => Promise<boolean>;
}

export const LAUNCH_DETECT_MS = 1600;

function browserLaunchEnv(): LaunchEnv {
  return {
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    navigate: (url) => { window.location.href = url; },
    isPageHidden: () => document.visibilityState === "hidden",
    waitForLeave: (ms) =>
      new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (left: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", onVis);
          window.removeEventListener("pagehide", onHide);
          window.removeEventListener("blur", onBlur);
          resolve(left);
        };
        const onVis = () => { if (document.visibilityState === "hidden") finish(true); };
        const onHide = () => finish(true);
        const onBlur = () => finish(true);
        const timer = setTimeout(() => finish(false), ms);
        document.addEventListener("visibilitychange", onVis);
        window.addEventListener("pagehide", onHide);
        window.addEventListener("blur", onBlur);
      }),
  };
}

/**
 * Try to open `app`. MUST be called synchronously from a click handler: Chrome
 * ignores intent launches without a user gesture.
 */
export async function launchUpiApp(app: UpiApp, env?: LaunchEnv): Promise<LaunchOutcome> {
  if (!env && typeof window === "undefined") return "unsupported";
  const e = env ?? browserLaunchEnv();
  const platform = detectPlatform(e.userAgent, e.maxTouchPoints ?? 0);
  if (platform !== "android" || !supportsAndroidIntents(e.userAgent)) return "unsupported";

  let url: string;
  try {
    url = buildAndroidLaunchIntent(app.androidPackage);
  } catch {
    return "unsupported";
  }
  // Start listening before navigating so a fast app switch is not missed.
  const left = e.waitForLeave(LAUNCH_DETECT_MS);
  try {
    e.navigate(url);
  } catch {
    return "no-effect";
  }
  return (await left) || e.isPageHidden() ? "likely-opened" : "no-effect";
}
