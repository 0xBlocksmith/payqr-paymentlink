# Proposal: a separate domain for payment pages

_Updated 2026-10-01. Hosting is Netlify (`netlify.toml`: `npm ci && npm run build`, Next.js runtime). The relayer is `p2pdotme/payer-relayer`, a Node service on Railway._

## What the payment domain should point at

**This frontend (`payqr`), not the relayer.** A payment link is a URL like `pay.payqr.pro/p/<id>`, which must resolve to the `/pay/[linkId]` **page** — HTML/CSS/JS. The relayer never serves HTML; it is a JSON API the page calls from the browser (`NEXT_PUBLIC_RELAYER_WORKER_URL`).

```
pay.payqr.pro     →  THIS Next.js app (a Netlify site)
<relayer URL>     →  payer-relayer on Railway — only ever called via fetch()
                     from the browser, never visited directly by a person
```

## Why a separate domain (review M7)

The customer's payment key and the merchant's keys are both kept in the browser's `localStorage`, and storage is shared by everything on one origin. Serving customer payment pages from their own origin (`pay.payqr.pro`) and the merchant app from another (`app.payqr.pro`) means a problem on one can't reach the other's keys. It also gives customers a short, payment-only URL.

## Two ways to get there

### Option A — a second Netlify site for `pay.payqr.pro` (recommended)

Deploy the same repo as a second Netlify site with `pay.payqr.pro` as its domain, and set `NEXT_PUBLIC_PAY_BASE_URL=https://pay.payqr.pro` on the merchant site so every shared link points there. The merchant routes are reachable on the pay domain too, but they are login-gated and the keys stay separate per origin.

### Option B — one site, both domains

Point both domains at one Netlify site. Simpler, but both domains then serve the same origin's code; the key separation only holds because browsers key storage by domain — so this still separates keys, with one deploy instead of two.

## What's needed to wire it up

1. **DNS**: a CNAME for `pay.payqr.pro` → the Netlify site.
2. **Env vars on the site** — see `.env.example`: `NEXT_PUBLIC_RELAYER_WORKER_URL`, `NEXT_PUBLIC_LINK_ROUTER_ADDRESS`, and `NEXT_PUBLIC_PAY_BASE_URL`.
3. **CORS on the relayer**: add the pay domain to the relayer's `ALLOWED_ORIGINS` (Railway env), or the browser blocks every `/api/pay` and `/api/relay-tx` call from the page.
4. **thirdweb**: add the pay domain to Allowed Domains on the frontend's thirdweb project.
