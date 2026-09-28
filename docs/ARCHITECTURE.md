# PayQR — Frontend Architecture

_Last updated: 2026-09-15. Covers `main` + `feat/payment-links-pr104-alignment-v2`._

## 1. What this repo is

`payqr` (package name `p2pm-terminal-frontend`) is a **Next.js 14 (App Router) PWA** — the merchant-facing terminal app for the p2p.me protocol, plus a newer walletless **Payment Links** feature. It is a frontend only. It owns no backend, no database, and no smart contracts.

Two other repos this app talks to:

| Repo | What it is | How this app reaches it |
|---|---|---|
| `payment-integrators` | Solidity contracts (`MerchantTerminalIntegrator`, `LinkRouter`, `PaymentLinksLib`) + a Cloudflare Worker relayer | Direct RPC reads/writes to the contracts; HTTPS calls to the deployed Worker for Payment Links |
| `@p2pdotme/sdk`, `@p2pdotme/widgets` | p2p.me's own npm packages (order SDK, `<Checkout>`/`<Cashout>` widgets) | npm dependency, used directly in components |

## 2. Stack

- **Framework**: Next.js 14.2.15, App Router, client components (`"use client"`) almost everywhere — this is a PWA, not an SSR content site.
- **Chain**: Base / Base Sepolia (`viem/chains`), selected via `NEXT_PUBLIC_CHAIN`.
- **Wallet / identity**: thirdweb v5 — merchants authenticate via an in-app wallet (email/social/phone login) wrapped in a **ERC-4337 smart account** with sponsored gas (`smartAccount({ sponsorGas: true })`). Merchants hold 0 ETH; every write is a sponsored UserOperation.
- **Chain reads**: `wagmi` (`useReadContract`, `usePublicClient`) for merchant-authenticated reads; a standalone `viem` `createPublicClient` for public, no-auth pages (`/pay/[linkId]`, `/receipt/[orderId]`).
- **State**: no global store — React state + a handful of `localStorage`-backed caches (`lib/cache.ts`, per-address relay identities, country/language prefs).
- **i18n**: `lib/i18n.tsx`, 4 languages (English, Hindi, Portuguese, Spanish).
- **Styling**: no CSS framework — hand-written CSS in `app/globals.css` plus per-component `<style jsx global>` blocks (payment-links pages use this pattern heavily for their beach-scene / glassmorphism look).

## 3. Two parallel payment systems in one app

### 3.1 The original terminal flow (QR / in-person)

The merchant opens `/qr`, picks/enters an amount, and the customer pays through the official **`@p2pdotme/widgets` `<Checkout>`** component — a pre-built UI this app does not control the internals of. This app only supplies:
- a `placeOrder` callback (`lib/p2p.ts`'s `makePlaceOrder`) that encodes a call to the integrator's `userPlaceOrder`
- a `CheckoutSigner` adapter (`components/useCheckoutSigner.ts`) that lets the merchant's ERC-4337 smart account satisfy the widget's signing interface — including a special-cased **admin EOA signature** for B2B fraud screening, since a smart account can't produce a plain EIP-191 signature the fraud engine can `ecrecover`

This is the "old" flow — fully live, e2e through the widget, the merchant's own registered currency and circle.

### 3.2 Payment Links (new — this session's focus)

A **walletless** flow: a merchant creates a shareable link once; any customer opens it with **no wallet, no login, no connect prompt**. This app builds its own UI for it (not the widget) because the widget has no non-authenticated checkout mode.

This is aligned to `payment-integrators` **PR #104**, which replaced a funded relayer EOA with a **per-link, funds-free ERC-4337 wallet** — see §5 for the full flow.

## 4. Where requests go

```
┌─────────────────────────────────────────────────────────────────────┐
│                            Browser (this app)                       │
│                                                                       │
│  Merchant pages          Customer pages (/pay/[linkId])             │
│  (wagmi + thirdweb)      (plain viem publicClient, no wallet)       │
└───────┬───────────────────────────┬──────────────────┬──────────────┘
        │ direct RPC reads/writes   │ direct RPC reads  │ HTTPS (fetch)
        ▼                           ▼                    ▼
┌───────────────────┐      ┌───────────────────┐  ┌─────────────────────┐
│  Base / Base       │◄─────────────────────────┘  │  Cloudflare Worker   │
│  Sepolia RPC        │                             │  (payment-integrators│
│  (Alchemy)           │◄────────────────────────────│  /worker/)           │
│                      │      writes as the link's   │  POST /api/pay/:id  │
│  MerchantTerminal-   │      own AA wallet          │  POST /api/relay-tx │
│  Integrator          │                             │  POST /api/links/   │
│  + LinkRouter        │                             │       :id/wallet    │
└───────────────────┘      └───────────────────┘  └─────────────────────┘
```

**Rule of thumb used throughout this app**: reads always go straight to chain (never trust a cache or a backend's word for balances/status); only *writes that need relaying* (because the caller has no wallet, or needs a sponsored/batched operation) go through the Worker.

## 5. Payment Links — full request flow

### Step 1 — Merchant creates a link (`/payment-links/create`)

Two on-chain-adjacent steps, both merchant-signed, both sponsored:

1. **`provisionLinkWallet()`** (`lib/paymentLinks.ts`) — an off-chain HTTPS call to the Worker's `POST /api/links/:linkId/wallet`, authorized by an EIP-712 signature (`domain: "P2P Merchant Terminal Admin"`, type `LinkWallet{linkId,expiry}`) signed by the merchant's smart account. The Worker mints a **funds-free AA wallet** scoped to this one link and returns its address.
2. **One batched transaction**: `createLink(linkId, amount, currency, expiresAt, maxUses, encryptedConfig)` on the integrator, immediately followed by `registerAgent(linkId, account)` on the LinkRouter — **in that exact order, in the same UserOperation** (`registerAgent` reads `getLink` to check ownership, so `createLink` must land first within the batch).

`linkId` itself is computed client-side before either call: `computeLinkId(merchant, salt) = keccak256(abi.encode(merchant, salt))` — the contract no longer returns it.

### Step 2 — Customer opens the link (`/pay/[linkId]`)

Pure chain read, no backend call: `getLink(linkId)` off the integrator via a public RPC client. The page classifies the result into `verified` / `notFound` / `unverified` (fail-open on a transient RPC error, fail-closed on a real ABI/contract error — the same pattern `/receipt/[orderId]` uses). The customer's browser also silently generates a local ECIES keypair (`lib/customerRelayIdentity.ts`) — used later to receive the merchant's encrypted payout address and to sign the mark-paid/cancel actions. Nothing is sent anywhere yet.

### Step 3 — Customer taps Pay

`makeRelayerPlaceOrder()` POSTs to the Worker's `/api/pay/:linkId` with `{quantity, pubKey, circleId, turnstileToken}`. The Worker re-reads the link fresh from chain (never trusts the request body for financial terms), simulates the call, then drives `LinkRouter.place(...)` **as the link's own AA wallet** — not a funded relayer. Response: `{orderId, txHash, claimToken}`.

The frontend never trusts this response alone — it independently waits for the transaction receipt and decodes the `LinkOrderPlaced` event itself before treating the order as real.

`claimToken` is persisted in `localStorage`, keyed by `orderId` — it's what proves to the Worker, later, that a mark-paid/cancel request came from the same browser that placed the order.

### Step 4 — LP accepts, customer pays fiat, customer confirms

Once an LP (liquidity provider) accepts the order, its `encUpi` (payout address, ECIES-encrypted to the customer's relay pubkey) becomes readable on-chain. The customer decrypts it client-side (`lib/customerOrder.ts`), pays outside the system (UPI/PIX/bank transfer), then taps **"I've paid."**

This triggers `markOrderPaid()`: the customer's browser signs an **EIP-712 `MarkPaid{linkId, orderId}`** digest (domain `"P2P LinkRouter"`, verifyingContract = `LINK_ROUTER_ADDRESS`) with their local relay key, and POSTs `{to, data, claimToken, signature}` to `/api/relay-tx`. The Worker forwards this to `LinkRouter.markPaid(...)`, which verifies the signature **on-chain** — the Worker itself can never advance or cancel a payment unilaterally; it only relays a signature it cannot forge.

### Why this design (from PR #104)

No funded key exists anywhere on the payment path:
- the link's AA wallet holds **zero balance** always
- the customer's signing key **never leaves their browser**
- a full compromise of the Worker cannot settle, withdraw, or redirect a payout — it can only relay signatures it doesn't hold

## 6. Error handling

`lib/contract.ts`'s `friendlyError()` is the single place every contract revert / SDK error passes through before reaching a user:
1. User-cancelled wallet prompt → `"Cancelled."`
2. `P2PError` from the SDK (fraud screening rejection, no-eligible-merchant, etc.) → its own `userMessage`, verbatim
3. A decodable Solidity custom error name → a curated human message (`ERROR_MESSAGES`)
4. An undecodable 4-byte selector → looked up in a manually-maintained `ERROR_SIGNATURES` map (kept in sync with the Worker's own `REVERT_MESSAGES`)
5. Otherwise → a generic fallback

## 7. Page-by-page

_Screenshot each of these from the running dev server (`http://localhost:3000`) and drop them under the matching heading._

### Public (no login)

| Route | Purpose |
|---|---|
| `/login` | Phone/email + social login via thirdweb, country/language selection |
| `/pay/[linkId]` | Customer payment-link screen — amount entry (if variable), QR/UPI-deeplink/Pix-code by rail, live status polling, mark-paid/cancel |
| `/receipt/[orderId]` | Shareable, token-gated public receipt for a completed order |

`![login](screenshots/login.png)`

`![pay-link](screenshots/pay-link.png)`

### Merchant (authenticated)

| Route | Purpose |
|---|---|
| `/dashboard` | Home — balance, recent activity, quick actions |
| `/qr` | Accept payment via the official `<Checkout>` widget (original flow) |
| `/payment-links` | List of the merchant's created links, revoke, QR |
| `/payment-links/create` | Create a fixed or variable-amount link (this session's fix: provisions the link wallet + batches `createLink`+`registerAgent`) |
| `/transactions` | Order/withdrawal history, filters, PDF export, dispute manager |
| `/withdraw` | Cash out settled balance; previous-integrator drain card on upgrade |
| `/settings` | Theme, language, payout details, account |
| `/campaign` | Promotional banner / volume-challenge progress |
| `/onboarding` | First-time merchant registration |

`![dashboard](screenshots/dashboard.png)`

`![qr](screenshots/qr.png)`

`![payment-links-list](screenshots/payment-links-list.png)`

`![payment-links-create](screenshots/payment-links-create.png)`

`![transactions](screenshots/transactions.png)`

`![withdraw](screenshots/withdraw.png)`

`![settings](screenshots/settings.png)`

## 8. Environment configuration

All config is `NEXT_PUBLIC_*` env vars (client-exposed by design — see `.env.example` for the authoritative, commented list). The Payment Links feature is **dormant by default**: every page that depends on it checks `PAYMENT_LINKS_ENABLED` (`RELAYER_WORKER_URL && CONTRACT_ADDRESS && LINK_ROUTER_ADDRESS` all set) and renders a "not configured" placeholder otherwise — no partial/broken state is reachable from a missing env var.

## 9. Known gaps (as of this doc)

- **pubKey format conflict** — **closed.** The Worker's `/api/pay` demanded the `04`-prefixed uncompressed SEC1 form (it derives the customer's signing address from the key, which needs the tag), while the SDK's `encryptPaymentAddress` — how the LP puts the payout handle on the order — re-adds `04` itself and so requires the unprefixed 128-char form. Sending the tagged form satisfied the Worker and left every order placeable and then permanently unpayable, because the LP could never deliver payment details. The Worker now normalises: it accepts either spelling, derives from the tagged form, and writes the **untagged** form on-chain. This repo sends what `createRelayIdentity()` produces, unchanged.
- **`registerAgent` batching** — implemented (§5, Step 1). Previously the create-link flow only sent `createLink`, leaving every link permanently unpayable.
- **Counter QRs (variable amount, unlimited uses)** are supported as of the ceiling changes in `payment-integrators` — see that repo's `docs/integrators/merchant-terminal.md` §4. On this side, `/pay/[linkId]` reads the merchant's live `perTxCap` for a variable link and refuses an over-cap amount **before** the relayer round-trip, since on a counter QR nothing else stands between the customer's typing and a revert.
- **Link orders in Transactions** — a link sale is recorded on-chain with the merchant's **proxy** as the order's user (`relayerPlaceOrder` → `_placeOrder(merchant, userIsProxy: true, …)`), where a POS sale records the merchant. `lib/history.ts` now queries both addresses; keying on the merchant alone showed the balance rising with no row to explain it.
