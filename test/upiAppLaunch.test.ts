import { describe, expect, it, vi } from "vitest";
import { UPI_APPS, detectPlatform, launchUpiApp, type LaunchEnv } from "../lib/upiAppLaunch";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36";
const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36";

function env(userAgent: string, left: boolean): LaunchEnv & { navigate: ReturnType<typeof vi.fn> } {
  return { userAgent, navigate: vi.fn(), waitForLeave: async () => left };
}

describe("platform detection", () => {
  it("classifies browsers", () => {
    expect(detectPlatform(ANDROID)).toBe("android");
    expect(detectPlatform(IOS)).toBe("ios");
    expect(detectPlatform(DESKTOP)).toBe("desktop");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
  });
});

describe("app links", () => {
  it("are bare schemes: no path, query, payee, amount, and never upi://", () => {
    for (const app of UPI_APPS) {
      expect(app.url).toMatch(/^[a-z]+:\/\/$/);
      expect(app.url).not.toMatch(/^upi:/);
    }
  });
});

describe("launchUpiApp", () => {
  it("reports likely-opened when the page is left", async () => {
    const e = env(ANDROID, true);
    expect(await launchUpiApp(UPI_APPS[1], e)).toBe("likely-opened");
    expect(e.navigate).toHaveBeenCalledWith("phonepe://");
  });
  it("reports no-effect when the page stays in the foreground", async () => {
    expect(await launchUpiApp(UPI_APPS[0], env(IOS, false))).toBe("no-effect");
  });
  it("does nothing on desktop", async () => {
    const e = env(DESKTOP, true);
    expect(await launchUpiApp(UPI_APPS[2], e)).toBe("unsupported");
    expect(e.navigate).not.toHaveBeenCalled();
  });
});
