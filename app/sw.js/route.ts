/**
 * The service worker, served as a route so its bytes carry THIS deploy's build
 * id. A static public/sw.js never changed between releases (its cache name was
 * bumped by hand and usually wasn't), so the browser compared it, saw identical
 * bytes and reported "up to date" no matter how much had shipped — which is why
 * "Check for updates" never updated anything. With the build id baked in, every
 * deploy produces a different worker, the browser installs it, and the app's
 * update prompt appears.
 *
 * OTA model: a NEW worker does NOT auto-activate. It waits until the app posts
 * SKIP_WAITING (the merchant taps Refresh), so a release can't swap the running
 * app mid-sale.
 */
export const dynamic = "force-static";

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID || "dev";

const SW = `/* PayQR service worker — build ${BUILD} */
const BUILD = ${JSON.stringify(BUILD)};
const CACHE = "payqr-" + BUILD;
// Precache ONLY immutable static assets — NEVER HTML. HTML embeds hashed
// _next/static chunk URLs; a precached old page after a deploy would reference
// chunks that no longer exist (ChunkLoadError). Navigations are network-first.
const SHELL = ["/manifest.json", "/icon-192.png", "/icon-512.png", "/splash.png", "/logo-mark.png"];

self.addEventListener("install", (e) => {
  // No skipWaiting() here — the new worker waits so the app can prompt.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});

// What may be cached. Anything account-specific or dynamic (API routes, RSC
// payloads, the build marker) is never stored, so nothing about one merchant can
// be replayed from this device's cache for the next person.
function cacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/api/") || url.pathname === "/build.json" || url.pathname === "/sw.js") return false;
  if (url.searchParams.has("_rsc")) return false;
  return true;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!cacheable(url)) return; // let the browser handle it, uncached
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && !res.redirected) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          if (req.mode === "navigate") return caches.match("/");
          return Response.error();
        })
      )
  );
});
`;

export function GET(): Response {
  return new Response(SW, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}
