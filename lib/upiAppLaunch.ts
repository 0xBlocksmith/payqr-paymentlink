/**
 * Ask the OS to open a UPI app via the bare `upi://` scheme: no payee, amount
 * or order, so nothing is paid or pre-filled. On Android the system shows its
 * UPI app chooser; the customer picks an app and enters the details themselves.
 *
 * Experimental. Bare app schemes (tez://, phonepe://, paytmmp://) and Chrome
 * `intent:` launcher URLs were tried on a real Android phone and did not work
 * (see docs/UPI_MANUAL_CHECKOUT.md). Whether bare `upi://` does is unverified,
 * so the caller must handle "nothing happened".
 */

/** Bare scheme only. Must never gain a path or query. */
export const UPI_OPEN_URL = "upi://";

export type LaunchOutcome = "likely-opened" | "no-effect";

export const LAUNCH_DETECT_MS = 1600;

export interface LaunchEnv {
  navigate: (url: string) => void;
  /** Resolves true if the page was hidden/blurred within ms, else false. */
  waitForLeave: (ms: number) => Promise<boolean>;
}

function browserEnv(): LaunchEnv {
  return {
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

/** Call from a click handler: browsers ignore app launches without a user gesture. */
export async function openUpiChooser(env: LaunchEnv = browserEnv()): Promise<LaunchOutcome> {
  const left = env.waitForLeave(LAUNCH_DETECT_MS); // listen before navigating
  try {
    env.navigate(UPI_OPEN_URL);
  } catch {
    return "no-effect";
  }
  return (await left) ? "likely-opened" : "no-effect";
}
