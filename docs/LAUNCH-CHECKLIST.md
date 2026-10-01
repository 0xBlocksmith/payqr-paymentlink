# Payment links — launch checklist

The steps that have to happen **outside this repo**, in order. Everything the
review raised that could be fixed in code is fixed in code; what is left is
deployment, and two of the three steps are order-dependent.

## 1. Deploy the relayer first — and treat it as a floor

Deploy `p2pdotme/payer-relayer` with fixed-price support, then confirm:

```sh
curl -s https://<relayer>/health | jq .features
# ["fixed-price","fiat-amount","idempotency"]
```

**Why first, and why there is no going back.** A link's fixed ₹ price lives at
the relayer, not in the URL. A relayer without that route answers `404` to
`/api/links/:id/price`, and a 404 used to read as "this link has no price" —
which would have turned every fixed-price link back into a pay-anything link
the moment the relayer was rolled back.

The app no longer accepts that: `fetchLinkPrice` only believes a 404 from a
relayer whose `/health` lists `fixed-price`. Otherwise the pay page shows
"This payment link can't be opened right now" with a retry, and takes no
payment. A rollback therefore **pauses** link payments instead of silently
reopening them for any amount. That is the intended failure, but it means a
rollback is an outage: from the first fixed-price link onwards, a relayer with
`fixed-price` is the minimum version.

## 2. Merge this PR and let Netlify deploy

Nothing to change on Netlify: no new environment variables. The deploy that
failed on this branch failed in Netlify's install step, not the build — a
stale `bun.lock` that Netlify preferred over `package-lock.json`. That file is
gone, and CI now fails any PR that reintroduces a second lockfile.

## 3. Revoke the old pay-anything links

Links created in the short-lived version that carried the price in the query
string (`?fa=&fs=`) are open-amount on-chain and have no price at the relayer.
The pay page refuses them while `?fa` is in the URL, but a stripped URL opens
as a Counter QR that takes any amount. They have to be revoked.

To list them (read-only; changes nothing, needs no key):

```sh
RPC_URL=https://base-mainnet.<keyed-provider>/... \
LINK_ROUTER_ADDRESS=0x... \
RELAYER_URL=https://<relayer>/ \
FROM_BLOCK=<LinkRouter deployment block> \
node scripts/audit-open-amount-links.mjs
```

A **keyed** RPC is required — public Base RPCs refuse historical `getLogs`,
which is what blocked this during review.

Read the list before acting on it. It is every live link that accepts any
amount, so genuinely-intended Counter QRs are in it too. Revoke with
`revokeLink(bytes32)` on the LinkRouter, from each link's own owner.

## 4. One live check of each, on mainnet

- A fixed ₹ link: the placed order's on-chain `fiatAmount` equals the price.
- A BRL link: scan the Pix QR with a real bank app; amount and txid are filled.
- Tap Pay, cut the network, tap Pay again: the same order comes back, one
  order exists, and the fraud engine saw one screening — not two.

## Known follow-ups, accepted for launch

- **CSP**: the full policy still ships report-only. It now reports to
  `/api/csp-report`, so violations land in the deployment's logs instead of a
  console nobody has open — run a full flow (login, create a link, pay,
  withdraw), read what it reports, add any host it names, then move the policy
  to `Content-Security-Policy`.
- **`script-src 'unsafe-inline'`**: removing it needs per-request nonces from
  middleware plus `'strict-dynamic'` for the thirdweb and SEON loaders. That is
  its own change, with its own flow test.
