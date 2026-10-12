import { describe, expect, it, vi } from "vitest";
import {
  UPI_APPS,
  buildAndroidLaunchIntent,
  detectPlatform,
  launchUpiApp,
  supportsAndroidIntents,
  type LaunchEnv,
} from "../lib/upiAppLaunch";
import { copyText } from "../lib/clipboard";

const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36";
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";

function env(userAgent: string, left: boolean): LaunchEnv & { navigate: ReturnType<typeof vi.fn> } {
  return { userAgent, navigate: vi.fn(), isPageHidden: () => false, waitForLeave: async () => left };
}

describe("platform detection", () => {
  it("classifies browsers", () => {
    expect(detectPlatform(ANDROID_CHROME)).toBe("android");
    expect(detectPlatform(IOS_SAFARI)).toBe("ios");
    expect(detectPlatform(DESKTOP)).toBe("desktop");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
  });
  it("only trusts intent URLs in Chrome-family browsers, not webviews", () => {
    expect(supportsAndroidIntents(ANDROID_CHROME)).toBe(true);
    expect(supportsAndroidIntents(ANDROID_WEBVIEW)).toBe(false);
    expect(supportsAndroidIntents(IOS_SAFARI)).toBe(false);
  });
});

describe("launch intent", () => {
  it("is a package-only launcher intent with no payment data", () => {
    for (const app of UPI_APPS) {
      const url = buildAndroidLaunchIntent(app.androidPackage);
      expect(url).toContain(`package=${app.androidPackage};`);
      expect(url).toContain("android.intent.category.LAUNCHER");
      expect(url).not.toMatch(/upi:|[?&;](pa|pn|am|cu|tr)=|;S\.|scheme=/i);
    }
  });
  it("rejects a package id that could smuggle intent fields", () => {
    expect(() => buildAndroidLaunchIntent("com.x;S.browser_fallback_url=https://evil")).toThrow();
  });
});

describe("launchUpiApp", () => {
  it("reports likely-opened when the page is left", async () => {
    const e = env(ANDROID_CHROME, true);
    expect(await launchUpiApp(UPI_APPS[1], e)).toBe("likely-opened");
    expect(e.navigate).toHaveBeenCalledOnce();
  });
  it("reports no-effect when the page stays in the foreground", async () => {
    expect(await launchUpiApp(UPI_APPS[0], env(ANDROID_CHROME, false))).toBe("no-effect");
  });
  it("never navigates on iOS, desktop or webviews", async () => {
    for (const ua of [IOS_SAFARI, DESKTOP, ANDROID_WEBVIEW]) {
      const e = env(ua, true);
      expect(await launchUpiApp(UPI_APPS[2], e)).toBe("unsupported");
      expect(e.navigate).not.toHaveBeenCalled();
    }
  });
});

describe("copyText", () => {
  it("uses the async clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText("a@upi", { clipboard: { writeText }, isSecureContext: true })).toEqual({ ok: true, method: "clipboard-api" });
    expect(writeText).toHaveBeenCalledWith("a@upi");
  });
  it("falls back to the legacy path when the API rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowed"));
    const legacyCopy = vi.fn().mockReturnValue(true);
    expect(await copyText("12.50", { clipboard: { writeText }, isSecureContext: true, legacyCopy })).toEqual({ ok: true, method: "exec-command" });
  });
  it("reports failure instead of throwing", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowed"));
    expect(await copyText("x", { clipboard: { writeText }, isSecureContext: true })).toEqual({ ok: false, reason: "denied" });
    expect(await copyText("x", {})).toEqual({ ok: false, reason: "unsupported" });
    expect(await copyText("", {})).toEqual({ ok: false, reason: "empty" });
  });
});
