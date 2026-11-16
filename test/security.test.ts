import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import nextConfigFn from "../next.config.mjs";
import { POST as cspReport } from "../app/api/csp-report/route";
import { GET as swGet } from "../app/sw.js/route";
import { GET as buildGet } from "../app/build.json/route";
import { clearLocalUserData } from "../lib/countries";
import { serverHasNewBuild } from "../components/AppUpdate";

describe("security headers", async () => {
  const cfg: any = nextConfigFn("phase-production-server");
  const rules = await cfg.headers();
  const all = Object.fromEntries(rules.flatMap((r: any) => r.headers).map((h: any) => [h.key.toLowerCase(), h.value]));

  it("forbids framing (clickjacking) in both X-Frame-Options and CSP", () => {
    expect(all["x-frame-options"]).toBe("DENY");
    expect(all["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
  it("forces HTTPS (HSTS) and blocks MIME sniffing", () => {
    expect(all["strict-transport-security"]).toMatch(/max-age=\d{7,}/);
    expect(all["x-content-type-options"]).toBe("nosniff");
  });
  it("isolates the window from other origins but keeps sign-in popups working", () => {
    expect(all["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  });
  it("does not leak full URLs (pay-link ids) in the Referer", () => {
    expect(all["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
  it("denies camera / mic / geolocation", () => {
    expect(all["permissions-policy"]).toMatch(/camera=\(\)/);
    expect(all["permissions-policy"]).toMatch(/microphone=\(\)/);
  });
});

describe("/api/csp-report (anyone can POST here)", () => {
  const post = (body: string, headers: Record<string, string> = {}) =>
    cspReport(new Request("http://x/api/csp-report", { method: "POST", body, headers }));

  it("answers 204 to malformed JSON, never an error page", async () => {
    expect((await post("{not json")).status).toBe(204);
  });
  it("refuses an oversized body by its declared length, without buffering it", async () => {
    const r = await post("x", { "content-length": String(10 * 1024 * 1024) });
    expect(r.status).toBe(204);
  });
  it("treats script in a report as inert data", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await post(JSON.stringify({ "csp-report": { "blocked-uri": "<script>alert(1)</script>", "effective-directive": "script-src" } }));
    expect(r.status).toBe(204);
    spy.mockRestore();
  });
});

describe("service worker + build marker", () => {
  it("serves a worker that carries the build id and is never cached by the browser", async () => {
    const res = swGet();
    const body = await res.text();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(body).toContain('const CACHE = "payqr-" + BUILD');
  });
  it("never caches API routes, RSC payloads or the build marker", async () => {
    const body = await swGet().text();
    expect(body).toContain('startsWith("/api/")');
    expect(body).toContain('"/build.json"');
    expect(body).toContain('has("_rsc")');
  });
  it("only sends non-GET and non-cacheable requests to the network untouched", async () => {
    const body = await swGet().text();
    expect(body).toContain('if (req.method !== "GET") return;');
  });
  it("build.json is no-store so a CDN can't hide a new release", async () => {
    const res = buildGet();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(typeof (await res.json()).id).toBe("string");
  });
});

describe("serverHasNewBuild (what makes 'Check for updates' actually update)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const serve = (id: string | null, ok = true) => {
    globalThis.fetch = vi.fn(async () => ({ ok, json: async () => (id == null ? {} : { id }) })) as any;
  };
  it("is true when the server runs a different build", async () => {
    serve("some-other-build");
    expect(await serverHasNewBuild()).toBe(true);
  });
  it("is false for the same build, a dev server, or a bad answer", async () => {
    serve("dev"); expect(await serverHasNewBuild()).toBe(false);
    serve(null); expect(await serverHasNewBuild()).toBe(false);
    serve("x", false); expect(await serverHasNewBuild()).toBe(false);
  });
  it("is false (not a false 'update!') when offline", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as any;
    expect(await serverHasNewBuild()).toBe(false);
  });
});

describe("logout wipes the session (shared-device / hijack hygiene)", () => {
  const store = (init: Record<string, string>) => {
    const m = new Map(Object.entries(init));
    return {
      get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null,
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), _m: m,
    };
  };
  let ls: ReturnType<typeof store>, ss: ReturnType<typeof store>;
  beforeEach(() => {
    ls = store({
      "payqr.relay:0xabc": "PRIVATE-KEY", "payqr.merchantProfile:0xabc": "{}", "payqr.usdcLedger:0xabc": "[]",
      "payqr.lastAddr": "0xabc", "payqr.country": "india", "payqr.theme": "dark", "other.site": "keep",
    });
    ss = store({ "payqr.stepUp": '{"addr":"0xabc","at":1}' });
    vi.stubGlobal("localStorage", ls);
    vi.stubGlobal("sessionStorage", ss);
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("removes keys, profile, ledger and 2FA marker; keeps only the theme and unrelated data", () => {
    clearLocalUserData();
    expect(ls._m.has("payqr.relay:0xabc")).toBe(false);
    expect(ls._m.has("payqr.merchantProfile:0xabc")).toBe(false);
    expect(ls._m.has("payqr.usdcLedger:0xabc")).toBe(false);
    expect(ls._m.has("payqr.lastAddr")).toBe(false);
    expect(ss._m.size).toBe(0);
    expect(ls._m.get("payqr.theme")).toBe("dark");
    expect(ls._m.get("other.site")).toBe("keep");
  });
});
