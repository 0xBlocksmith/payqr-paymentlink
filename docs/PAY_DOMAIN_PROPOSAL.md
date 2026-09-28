# Proposal: connecting `pay.payqr.pro`

_Status: proposal, not yet implemented. No deployment config exists in this repo today (no `vercel.json`, no `next.config.mjs` deploy target)._

## What `pay.payqr.pro` should point at

**This frontend (`payqr`), not the Worker.** A payment link is a URL like `pay.payqr.pro/pay/0xabc...`, which must resolve to the `/pay/[linkId]` **page** — HTML/CSS/JS. The Worker never serves HTML; it's a JSON API the page calls client-side (`NEXT_PUBLIC_RELAYER_WORKER_URL`). Pointing the domain at the Worker instead would return a 404 for every browser request.

```
pay.payqr.pro          →  THIS Next.js app (Vercel, or equivalent)
relay.payqr.pro (or     →  the Cloudflare Worker (payment-integrators/worker)
 *.workers.dev)            — only ever called via fetch() from the browser,
                            never visited directly by a person
```

## Two ways to get there

### Option A — dedicated subdomain, this app only serves `/pay/*`

Deploy this whole Next.js app (unchanged) to its own hosting target and point `pay.payqr.pro` at it directly. Simplest option: one deploy, one domain, no routing changes needed in the app itself. The tradeoff: the merchant-facing routes (`/dashboard`, `/qr`, etc.) would also technically be reachable at `pay.payqr.pro/dashboard` unless deliberately blocked — cosmetically odd for a domain whose name implies "customer payment page," but not a security issue since those routes are already auth-gated.

### Option B — `pay.payqr.pro` as a thin proxy/rewrite in front of the same deploy

Add a `next.config.mjs` rewrite (or a host-based redirect at the DNS/CDN layer) so `pay.payqr.pro/{linkId}` maps to `/pay/{linkId}` on the main app — giving customers a shorter, payment-specific URL (`pay.payqr.pro/0xabc...` instead of `app.payqr.pro/pay/0xabc...`) while the merchant app keeps living at its own domain. Slightly more setup (one rewrite rule, or two DNS entries pointing at the same deployment with host-based routing), but a cleaner separation: customers never see `/dashboard`-shaped URLs under the payment domain.

**Recommendation: Option A first, revisit Option B once there's a real merchant-facing domain to separate from** — no reason to add routing complexity before it's needed.

## What's needed to wire it up

1. **Hosting target for this Next.js app.** Nothing in the repo commits to one yet (no `vercel.json`/`netlify.toml`/Dockerfile). Vercel is the path of least resistance for a Next.js App Router PWA — zero-config deploy, automatic preview URLs per branch/PR, built-in edge caching for the static routes. Any Node-capable host works equally well technically (the app has no Vercel-specific APIs in use); Vercel is a recommendation on ease of setup, not a requirement.
2. **DNS**: a CNAME (or A record, depending on host) for `pay.payqr.pro` → the hosting target's assigned address.
3. **Env vars set on that deployment** — critically `NEXT_PUBLIC_RELAYER_WORKER_URL` and `NEXT_PUBLIC_LINK_ROUTER_ADDRESS` (both blank today — Payment Links stays dormant/"not configured" until the Worker is actually deployed to `payment-integrators` and these point at it). See `.env.example` for the full list.
4. **The Worker itself** needs its own deploy (Cloudflare Workers, via `wrangler`) and its own domain/URL — that's entirely in `payment-integrators`, out of this repo's scope. `pay.payqr.pro` never talks to it directly (browser → Worker calls happen client-side via `fetch`, not through the domain's own routing).
5. **CORS**: the Worker's `corsHeaders()` (per its own source) must allow `pay.payqr.pro` as an origin, or every `/api/pay` and `/api/relay-tx` call from the deployed page will be blocked by the browser.

## Open question for whoever owns DNS/hosting

Is there already a hosting account (Vercel org, Cloudflare Pages project, etc.) this should deploy under, or does one need to be created? This repo has no CI/deploy workflow committed (no `.github/workflows/*deploy*`), so the first deploy will likely be manual regardless of host chosen.
