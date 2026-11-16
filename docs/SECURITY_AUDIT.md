# Security audit — static review + local tests

Scope: this repository (app, components, lib, API routes, service worker, headers, dependencies).
Method: code review, grep for dangerous sinks, `npm audit`, and automated tests in `test/security.test.ts`.
Not done: no traffic was sent to any live site; no on-chain / contract review; no build-and-probe of a deployed instance.

## Fixed in this change
| # | Finding | Fix |
|---|---|---|
| 1 | "Check for updates" never updated: `sw.js` was byte-identical every release (its cache name was bumped by hand), so the browser saw no new worker. | `/sw.js` is now a route carrying the build id; `/build.json` exposes the live build; the app compares it with the running build on check / focus / every 30 min. |
| 2 | HSTS is not set by the app itself. (Production already receives the host's own one-year header, so this is defense in depth — the app value only applies where the host adds none.) | App sets `Strict-Transport-Security` (2 years + subdomains); the host's header, where present, takes precedence. |
| 3 | No cross-window isolation. | `Cross-Origin-Opener-Policy: same-origin-allow-popups` (sign-in popups still work). |
| 4 | Service worker cached every same-origin GET, including API routes and RSC payloads, and kept them after logout. | Never caches `/api/*`, RSC, `/build.json`, `/sw.js`, redirects; logout now deletes all Cache Storage. |
| 5 | Logout cleared only a hand-listed set of keys (ledgers, last address, setup state survived). | Logout removes every merchant `payqr.*` / `@P2PME:*` key and clears `sessionStorage` and Cache Storage. Kept on purpose: the theme, the local link index, and the **payer's** own keys (`payqr.customerRelay`, `payqr.linkOrder:*`, `payqr.linkClaim:*`, `payqr.linkAttempt:*`, `payqr.linkPending:*`) because the pay page shares this origin. thirdweb's own Disconnect runs the same cleanup. |
| 6 | `/api/csp-report` buffered the whole body before enforcing its size cap. | Declared `Content-Length` is checked first. |
| 7 | Ecosystem iframe sandbox combined `allow-scripts` + `allow-same-origin` unconditionally (sandbox escape if ever same-origin). | `allow-same-origin` dropped when the framed URL is our own origin. |

## Reviewed, no issue found
- XSS sinks: the only `dangerouslySetInnerHTML` is a constant theme script; the one `document.write` (statement PDF) escapes every dynamic value.
- Open redirects: no navigation target comes from a URL parameter.
- `target="_blank"` links all carry `rel="noopener noreferrer"`.
- No secrets in tracked files or in git history file names; only `.env.example` is tracked.
- Clickjacking: `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- Withdrawals: **no step-up verification** (it was removed from the withdraw flows in this PR). Dispute appeals still use it. Consider keeping a confirmation before sends to an external address.

## Open items (need your decision / a separate tested change)
1. **Next.js 14.2.35 has published advisories fixed only in 15.5.24+.** The app uses no Server Actions, no image optimizer (`unoptimized`), no rewrites and one trivial API route, so most do not apply — but upgrade to a patched 15.x on its own branch and run every flow.
2. **Transitive dependency advisories** (`npm audit`: zod, ws, axios, abitype, walletconnect/reown…) come through thirdweb / wagmi / @p2pdotme/*. `npm audit fix --force` would downgrade thirdweb — do not run it. Bump thirdweb / wagmi / viem / @p2pdotme/* to current versions and re-test.
3. **CSP `script-src` still allows `'unsafe-inline'`** and the full policy is report-only. Browser-side keys (customer relay key, thirdweb session) live in `localStorage`, so any XSS could read them. Next step: nonce-based CSP via middleware, then switch report-only to enforced after reading `/api/csp-report` logs.
4. **Withdrawals have no second factor.** A walk-up on an unlocked phone or a hijacked UI session can withdraw in one slide. Any future step-up is client-side only and would not stop someone running their own code with the live session; a real control needs an on-chain / relayer-enforced check.
5. **`NEXT_PUBLIC_*` values are public by design** (RPC URL with provider key, fraud-engine encryption key). Restrict the RPC key by allowed domain at the provider.
6. No idle auto-logout. Optional for shared POS devices.
7. iOS ignores a changing status-bar colour after install; Android honours it.
