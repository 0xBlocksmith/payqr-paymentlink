"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePublicClient } from "wagmi";
import { Nav } from "../../components/Nav";
import { Splash } from "../../components/Splash";
import { useMerchant } from "../../components/useMerchant";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, PREV_CONTRACT_ADDRESSES, CROSS_VERSION_ABI, isPrevContract, friendlyError, currencyFromBytes32 } from "../../lib/contract";
import { useMerchantProxies } from "../../components/useMerchantProxies";
import { countryForCurrency, fmtFiat } from "../../lib/countries";
import { PAYMENT_LINKS_ENABLED, LinkStatus, fetchMerchantLinkIds, fetchIndexedMerchantLinkIds, fetchMerchantLinkEvents, fetchLink, buildPayLinkUrl, rememberedLinks, type LinkPrice } from "../../lib/paymentLinks";
import { fetchPriceConfig, fiatForUsdc, type PriceConfig } from "../../lib/pricing";
import { composePosterDataUrl } from "../../components/PaymentLinkPoster";
import { fetchLinkOrders, receiptToken } from "../../lib/history";

/** One label/value line in the Summary tab. */
function StatRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className="row"
      style={{ justifyContent: "space-between", padding: "7px 0", alignItems: "baseline" }}
    >
      <span className="sub">{label}</span>
      <span
        style={{
          fontWeight: strong ? 800 : 600,
          fontSize: strong ? 17 : 15,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

type LinkRow = {
  linkId: `0x${string}`;
  amount: bigint;
  currency: string;
  expiresAt: bigint;
  maxUses: number;
  uses: number;
  status: number;
  /** The integrator this link lives on. Links on a PREVIOUS integrator are
   *  listed read-only: the relayer only drives the current one, so they can no
   *  longer be paid. */
  contract: `0x${string}`;
};

/**
 * Merchant-facing Payment Links list + revoke. Mirrors /qr's auth-gate shape.
 *
 * Enumerating a merchant's own links is genuinely hard here: links live in
 * `mapping(bytes32 => PaymentLink)`, which answers "who owns THIS link" and
 * cannot answer the reverse. No single source gets it right, so `load` below
 * MERGES four, each partial in a different direction. See
 * payment-integrators/docs/proposals/merchant-link-enumeration.md for why, and
 * for the options that were not taken.
 *
 * Whatever the ids come from, each one's LIVE state is then read via `getLink`
 * on-chain — so a revoked or expired link never renders stale as active, and an
 * id from a non-authoritative source cannot make a link claim to be something
 * it is not.
 */
export default function PaymentLinksList() {
  const router = useRouter();
  const { ready, authenticated, address, isRegistered, sendTransaction } = useMerchant();
  const publicClient = usePublicClient();

  const [links, setLinks] = useState<LinkRow[] | null>(null);
  // Each fixed-price link's price, from the relayer's link index — so it shows
  // on every device, not only the one that created the link.
  const [linkPrices, setLinkPrices] = useState<Map<string, LinkPrice>>(new Map());
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  // Keyed by currency code — a fixed link's on-chain `amount` is 6-dec
  // USDC-equivalent (what usdcForFiat priced it at, at creation time), not
  // fiat, so it must be converted back through the live price to show what
  // the link will actually charge (mirrors /pay/[linkId]'s same fix).
  const [priceCfgs, setPriceCfgs] = useState<Record<string, PriceConfig>>({});
  // Payment-link SALES, which are a different thing from the links themselves:
  // a link is an invitation, an order is someone acting on it. The merchant had
  // no way to see the second from here.
  const [orders, setOrders] = useState<any[] | null>(null);
  const [ordersError, setOrdersError] = useState(false);
  const [tab, setTab] = useState<"links" | "payments" | "summary">("links");

  // Link orders are indexed under the merchant PROXY, not the merchant — and
  // there is one proxy per integrator, so every one is needed to show link
  // sales from before a contract upgrade. See fetchLinkOrders.
  const { proxies } = useMerchantProxies(address);
  const proxyKey = (proxies ?? []).join(",");

  useEffect(() => {
    if (!proxies) return;
    if (proxies.length === 0) { setOrders([]); return; }
    let alive = true;
    fetchLinkOrders(proxies)
      .then((rows) => { if (alive) { setOrders(rows); setOrdersError(false); } })
      // Keep whatever was last shown. An index outage must not render as
      // "no payments yet", which a merchant cannot tell from a real zero.
      .catch(() => { if (alive) setOrdersError(true); });
    return () => { alive = false; };
    // proxyKey stands in for proxies: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyKey]);

  useEffect(() => {
    if (ready && isRegistered === false) router.replace("/onboarding");
  }, [ready, isRegistered, router]);


  const load = useCallback(async () => {
    if (!address || !publicClient) return;
    setError("");
    try {
      // FOUR sources, merged, because no single one is reliable here:
      //
      //   1. getMerchantLinks — the trustless view, and the right answer. Not
      //      deployed on every integrator, so it may simply revert.
      //   2. The relayer worker's merchant→link index. Direct lookup, no
      //      scanning, cannot silently truncate — but it only knows links
      //      minted through the worker since the index shipped.
      //   3. The LinkCreated log scan — bounded by the RPC. Alchemy's free tier
      //      caps eth_getLogs at TEN blocks, so the scan reaches roughly two
      //      hours back on Base and older links fall off the end.
      //   4. Ids this device recorded at creation time.
      //
      // (2) covers what (3) cannot reach and (4) cannot know — links this
      // merchant made on a DIFFERENT device, older than the scan window. All
      // four run regardless of each other's success, rather than one standing
      // in as another's fallback: each is partial in a different direction, so
      // stopping at the first that answers just picks one blind spot to keep.
      //
      // Index only: every field below still comes from getLink on-chain, so an
      // id that was revoked elsewhere still reads as revoked, and one that
      // never existed resolves to a zero owner and is dropped.
      const discovered = new Set<`0x${string}`>(rememberedLinks(address));
      const prices = new Map<string, LinkPrice>();
      const [onChainIds, indexedIds] = await Promise.all([
        fetchMerchantLinkIds(publicClient, address).catch(() => [] as `0x${string}`[]),
        fetchIndexedMerchantLinkIds(address, prices).catch(() => [] as `0x${string}`[]),
      ]);
      setLinkPrices(prices);
      for (const id of onChainIds) discovered.add(id);
      for (const id of indexedIds) discovered.add(id);
      // The scan is the expensive one — hundreds of sequential eth_getLogs on a
      // narrow-range RPC — so only pay for it when the cheap sources came back
      // with nothing. When they did answer, it can add only links older than
      // the worker index, which the scan's own lookback rarely reaches anyway.
      if (discovered.size === 0) {
        try {
          const events = await fetchMerchantLinkEvents(publicClient, address);
          for (const ev of events) discovered.add((ev as any).args.linkId as `0x${string}`);
        } catch {
          // Every discovery path failed. Whatever this device remembers is
          // still better than an empty list, so carry on rather than throwing.
        }
      }
      const linkIds = Array.from(discovered);

      // PREVIOUS integrators. Their own getMerchantLinks where they have it (the
      // oldest does not), and every id discovered above is ALSO probed against
      // them — which is how links on the oldest contract are still found. One
      // multicall per contract; each id fails on its own.
      const prevIdLists = await Promise.all(
        PREV_CONTRACT_ADDRESSES.map((c) =>
          fetchMerchantLinkIds(publicClient, address, c).catch(() => [] as `0x${string}`[])
        )
      );
      const prevRows: LinkRow[] = [];
      await Promise.all(
        PREV_CONTRACT_ADDRESSES.map(async (contract, i) => {
          const ids = Array.from(new Set([...prevIdLists[i], ...linkIds]));
          if (ids.length === 0) return;
          const res = await publicClient
            .multicall({
              contracts: ids.map((id) => ({
                address: contract, abi: CROSS_VERSION_ABI, functionName: "getLink", args: [id],
              })),
              allowFailure: true,
            } as any)
            .catch(() => [] as any[]);
          (res as any[]).forEach((r, j) => {
            if (r?.status !== "success") return;
            const [owner, amount, currency, expiresAt, maxUses, status, uses] = r.result as any[];
            if (String(owner).toLowerCase() !== address.toLowerCase()) return;
            prevRows.push({
              linkId: ids[j], amount, currency: currencyFromBytes32(currency),
              expiresAt, maxUses: Number(maxUses), status: Number(status), uses: Number(uses), contract,
            });
          });
        })
      );
      // allSettled, NOT all — and this is the bug that made the whole page read
      // "Could not load your payment links".
      //
      // A remembered id whose link does not exist on THIS integrator (created on
      // an earlier deployment, on another device, or a create that never
      // landed) does not come back as a zero owner. `getLink` REVERTS with
      // LinkNotFound. Under Promise.all a single such id rejected the entire
      // list, so one stale entry in localStorage — which every merchant has the
      // moment the contract address changes — blanked every real link too.
      //
      // Each id now fails on its own and is simply dropped. The zero-owner check
      // stays as a second line of defence for a contract that returns rather
      // than reverts.
      const settled = await Promise.allSettled(
        linkIds.map(async (linkId) => {
          const link = await fetchLink(publicClient, linkId);
          if (/^0x0+$/i.test(link.owner)) return null;
          return {
            linkId,
            amount: link.amount,
            currency: currencyFromBytes32(link.currency),
            expiresAt: link.expiresAt,
            maxUses: link.maxUses,
            status: link.status,
            uses: link.uses,
            contract: CONTRACT_ADDRESS,
          };
        })
      );
      const rows = settled
        .map((s) => (s.status === "fulfilled" ? s.value : null))
        .filter((r): r is LinkRow => r !== null);
      rows.reverse(); // newest first
      setLinks([...rows, ...prevRows]);
    } catch (e: any) {
      setError(friendlyError(e, "Could not load your payment links."));
      setLinks([]);
    }
  }, [address, publicClient]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!links) return;
    const codes = Array.from(
      new Set(links.filter((l) => l.amount !== 0n).map((l) => l.currency).filter(Boolean))
    ).filter((code) => !(code in priceCfgs));
    if (codes.length === 0) return;
    Promise.all(codes.map((code) => fetchPriceConfig(code).then((cfg) => [code, cfg] as const))).then(
      (results) => {
        setPriceCfgs((prev) => {
          const next = { ...prev };
          for (const [code, cfg] of results) if (cfg) next[code] = cfg;
          return next;
        });
      }
    );
    // priceCfgs intentionally omitted — it's only read to compute `codes`, and
    // including it would refetch on every state update it caused itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links]);

  // A link that is revoked, expired or used up can never be paid again. It
  // cannot be DELETED — it lives on-chain and removing it would mean a
  // transaction that buys nothing — but showing it alongside live links invited
  // the merchant to hand out a QR that every customer would be turned away from.
  // So: hidden from the list, counted in the summary, still on-chain.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const isLive = (l: LinkRow) =>
    !isPrevContract(l.contract) &&
    l.status === LinkStatus.ACTIVE &&
    !(l.expiresAt !== 0n && nowSec > l.expiresAt) &&
    !(l.maxUses !== 0 && l.uses >= l.maxUses);
  const liveLinks = (links ?? []).filter(isLive);
  // Links on a previous integrator: history, not something to hand out.
  const prevLinks = (links ?? []).filter((l) => isPrevContract(l.contract));
  const hiddenCount = (links?.length ?? 0) - liveLinks.length - prevLinks.length;

  // Only SETTLED orders count as paid. An order that has been marked paid but
  // not yet released is not money the merchant has, and calling it "paid" here
  // would repeat the bug the link status had.
  const paidOrders = (orders ?? []).filter((o) => o.status === "settled");
  const totalReceived = paidOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);

  // "matching" covers everything before settlement: placed, matched with an LP,
  // even marked paid. None of it is money the merchant has yet.
  const pendingOrders = (orders ?? []).filter((o) => o.status === "matching");
  const totalPending = pendingOrders.reduce((sum, o) => sum + Number(o.amount || 0), 0);
  const cancelledOrders = (orders ?? []).filter((o) => o.status === "cancelled");

  // Why a link is dead matters to the merchant: used up means it worked, expired
  // means nobody used it in time, revoked means they stopped it themselves.
  const deadLinks = (links ?? []).filter((l) => !isLive(l) && !isPrevContract(l.contract));
  const revokedCount = deadLinks.filter((l) => l.status !== LinkStatus.ACTIVE).length;
  const expiredCount = deadLinks.filter(
    (l) => l.status === LinkStatus.ACTIVE && l.expiresAt !== 0n && nowSec > l.expiresAt
  ).length;
  const usedUpCount = deadLinks.length - revokedCount - expiredCount;

  /** How long the oldest unfinished payment has been sitting, in plain words. */
  const oldestPendingAge = (() => {
    const oldest = pendingOrders.reduce(
      (min, o) => (o.placedAt && (!min || o.placedAt < min) ? o.placedAt : min),
      0 as number
    );
    if (!oldest) return "";
    const mins = Math.floor((Date.now() / 1000 - oldest) / 60);
    if (mins < 1) return "under a minute";
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"}`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days === 1 ? "" : "s"}`;
  })();

  /**
   * The in-app receipt link for a settled order.
   *
   * The receipt page is token-gated: the token is derived from the order id and
   * its transaction hash (receiptToken), so a merchant cannot browse to a
   * stranger's receipt by guessing an order number. An order with no tx hash
   * cannot produce a valid token, so it simply is not linked.
   */
  function receiptHref(o: any): string {
    if (!o?.orderId || !o?.txHash) return "";
    const q = new URLSearchParams({
      token: receiptToken(String(o.orderId), o.txHash),
      kind: "buy",
    });
    return `/receipt/${o.orderId}?${q.toString()}`;
  }

  /** Download the QR poster (same template as after creation) for a link. */
  async function downloadQr(linkId: string, url: string) {
    setQrFor(linkId);
    try {
      const a = document.createElement("a");
      a.href = await composePosterDataUrl(url);
      a.download = `payqr-${linkId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError("Could not create the QR image. Please try again.");
    } finally {
      setQrFor(null);
    }
  }

  /** Re-share a link: the native sheet where there is one, clipboard otherwise. */
  async function share(url: string) {
    const text = `Hi! Please complete your payment securely with PayQR.

Scan the QR code or tap the link below to pay:

${url}`;
    // Same poster image as on the create screen, attached where the device can
    // share files alongside text.
    if (navigator.share && navigator.canShare) {
      try {
        const blob = await (await fetch(await composePosterDataUrl(url))).blob();
        const file = new File([blob], "payqr-payment-link.png", { type: "image/png" });
        const payload = { files: [file], title: "PayQR payment link", text };
        if (navigator.canShare(payload)) {
          await navigator.share(payload);
          navigator.clipboard?.writeText(url).catch(() => {});
          return;
        }
      } catch (e: any) {
        if (e?.name === "AbortError") return;
      }
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: "PayQR payment link", text, url });
        return;
      } catch (e: any) {
        // Closing the sheet is a choice, not a failure — don't fall through to
        // a second action the merchant did not ask for.
        if (e?.name === "AbortError") return;
      }
    }
    navigator.clipboard?.writeText(url).catch(() => {});
  }

  if (!ready || !authenticated) return <Splash />;

  async function revoke(linkId: string, contract: `0x${string}` = CONTRACT_ADDRESS) {
    setBusyId(linkId);
    setError("");
    try {
      const { encodeFunctionData } = await import("viem");
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "revokeLink",
        args: [linkId as `0x${string}`],
      });
      const hash = await sendTransaction({ to: contract, data });
      await publicClient!.waitForTransactionReceipt({ hash });
      await load();
    } catch (e: any) {
      setError(friendlyError(e, "Could not revoke this link."));
    } finally {
      setBusyId(null);
    }
  }

  if (!PAYMENT_LINKS_ENABLED) {
    return (
      <>
        <Nav back backHref="/dashboard" />
        <div className="screen">
          <div className="card">
            <div className="label">Payment Links</div>
            <div className="sub">This feature isn't configured on this deployment yet.</div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Nav back backHref="/dashboard" />
      <div className="screen">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 16 }}>
          <div className="label" style={{ fontSize: 18, fontWeight: 700 }}>Payment Links</div>
          <Link href="/payment-links/create" className="btn small">+ New link</Link>
        </div>

        {error && <div className="sub" style={{ color: "var(--warn)", marginBottom: 12 }}>{error}</div>}

        {/* Three questions, three tabs. They were previously answered by one
            list that mixed them: which links can I hand out right now, what has
            actually been paid, and how is the whole thing doing. */}
        <div className="seg" style={{ marginBottom: 16 }}>
          <button
            type="button"
            className={`seg-opt ${tab === "links" ? "on" : ""}`}
            onClick={() => setTab("links")}
          >
            Links
          </button>
          <button
            type="button"
            className={`seg-opt ${tab === "payments" ? "on" : ""}`}
            onClick={() => setTab("payments")}
          >
            Payments
          </button>
          <button
            type="button"
            className={`seg-opt ${tab === "summary" ? "on" : ""}`}
            onClick={() => setTab("summary")}
          >
            Summary
          </button>
        </div>

        {tab === "summary" && (
          <>
            {/* EVERY link ever created, not just the payable ones. The Links tab
                deliberately hides dead links so a merchant cannot hand out a QR
                that will be refused — but "how many have I made" is a different
                question, and hiding the answer there made it unanswerable. */}
            <div className="card" style={{ marginBottom: 12 }}>
              <div className="sub" style={{ marginBottom: 10, fontWeight: 700 }}>Links</div>
              <StatRow label="Created (all time)" value={String(links?.length ?? 0)} />
              <StatRow label="Active now" value={String(liveLinks.length)} />
              <StatRow label="Used up" value={String(usedUpCount)} />
              <StatRow label="Expired" value={String(expiredCount)} />
              <StatRow label="Revoked" value={String(revokedCount)} />
              {prevLinks.length > 0 && (
                <StatRow label="On earlier versions" value={String(prevLinks.length)} />
              )}
            </div>

            <div className="card" style={{ marginBottom: 12 }}>
              <div className="sub" style={{ marginBottom: 10, fontWeight: 700 }}>Money</div>
              {/* Paid and pending are kept apart on purpose. Pending is not a
                  smaller kind of paid — it is money that may never arrive, and
                  adding the two into one "total" is how a merchant ends up
                  shipping goods against a payment that gets cancelled. */}
              <StatRow
                label={`Received (${paidOrders.length})`}
                value={`${(totalReceived / 1e6).toFixed(2)} USDC`}
                strong
              />
              <StatRow
                label={`Pending (${pendingOrders.length})`}
                value={`${(totalPending / 1e6).toFixed(2)} USDC`}
              />
              <StatRow label={`Cancelled (${cancelledOrders.length})`} value="—" />
              {oldestPendingAge && (
                <div className="sub" style={{ marginTop: 10, opacity: 0.75 }}>
                  Oldest pending payment started {oldestPendingAge} ago. A payment that
                  never completes is cancelled by the protocol and the money never leaves
                  the customer.
                </div>
              )}
            </div>
          </>
        )}

        {tab === "links" && (
          <>
        {/* SUMMARY. Answers the three things a merchant opens this page to ask
            — how many links are live, how many have been paid, and how much has
            actually arrived — without making them count rows. "Received" counts
            SETTLED orders only: money that is in the balance, not money someone
            has started paying. */}
        {links !== null && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="value" style={{ fontSize: 22 }}>{liveLinks.length}</div>
                <div className="sub">Active links</div>
              </div>
              <div>
                <div className="value" style={{ fontSize: 22 }}>{paidOrders.length}</div>
                <div className="sub">Paid</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="value" style={{ fontSize: 22 }}>
                  {(totalReceived / 1e6).toFixed(2)}
                </div>
                <div className="sub">USDC received</div>
              </div>
            </div>
            {hiddenCount > 0 && (
              <div className="sub" style={{ marginTop: 10, opacity: 0.7 }}>
                {hiddenCount} expired, used-up or revoked link{hiddenCount === 1 ? "" : "s"} hidden.
                They stay on-chain and can never be paid again.
              </div>
            )}
          </div>
        )}

        {links !== null && liveLinks.length === 0 && (
          <div className="card">
            <div className="sub">No active payment links. Create one to share with a customer.</div>
          </div>
        )}

        {liveLinks.map((l) => {
          const country = countryForCurrency(l.currency);
          // A fixed local price, held and charged by the relayer.
          const fixedLocal = l.amount === 0n ? linkPrices.get(l.linkId.toLowerCase()) ?? null : null;
          const url = buildPayLinkUrl(l.linkId);
          const isActive = l.status === LinkStatus.ACTIVE;
          const expired = l.expiresAt !== 0n && BigInt(Math.floor(Date.now() / 1000)) > l.expiresAt;
          // maxUses 0 means unlimited, so it can never be exhausted — a counter
          // QR stays payable however many times it is used.
          const exhausted = l.maxUses !== 0 && l.uses >= l.maxUses;
          return (
            <div className="card" key={l.linkId} style={{ marginBottom: 12 }}>
              <div className="value" style={{ fontSize: 20 }}>
                {fixedLocal
                  ? fmtFiat(country, Number(fixedLocal.amount6) / 1e6)
                  : l.amount === 0n
                    ? "Any amount"
                    : priceCfgs[l.currency]
                      ? fmtFiat(country, fiatForUsdc(l.amount, priceCfgs[l.currency]))
                      : "…"}
                {/* "Any amount" alone did not say WHY, and the two link types
                    behave differently enough that the merchant needs to know
                    which one they are looking at: one is an invoice, the other
                    is a standing counter QR. */}
                {l.amount === 0n && !fixedLocal && (
                  <span className="sub" style={{ fontSize: 13, marginLeft: 8, opacity: 0.8 }}>
                    Counter QR — customer enters it
                  </span>
                )}
              </div>
              <div className="sub">
                {l.maxUses === 0 ? "Multi-use" : l.maxUses === 1 ? "Single use" : `Up to ${l.maxUses} uses`}
                {l.maxUses !== 0 && ` (${l.uses}/${l.maxUses} used)`} ·{" "}
                {/* "Used up" is a THIRD dead state, and it was missing. The check
                    was revoked / expired / Active, so a single-use link that had
                    already been paid still read "Active" here — while the pay page
                    correctly refused it as "already been used the maximum number
                    of times". The merchant was told a link worked when every
                    customer scanning it was turned away. Same condition the
                    contract enforces in PaymentLinksLib.consume and that
                    linkBlockedReason already implements. */}
                {!isActive ? "Revoked" : expired ? "Expired" : exhausted ? "Used up" : "Active"}
              </div>
              {/* Expiry was read from chain into state and then never shown, so
                  a merchant could not tell a link with an hour left from one
                  that never expires — which for a printed counter QR is the
                  difference between working tomorrow and not. */}
              <div className="sub" style={{ marginTop: 2, opacity: 0.75 }}>
                {l.expiresAt === 0n
                  ? "Never expires"
                  : (expired ? "Expired " : "Expires ") +
                    new Date(Number(l.expiresAt) * 1000).toLocaleString()}
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn small ghost" disabled={qrFor === l.linkId} onClick={() => downloadQr(l.linkId, url)}>
                  {qrFor === l.linkId ? "Preparing…" : "Download QR"}
                </button>
                {/* Re-share. The create screen offers this once, at the moment
                    a link is made, and never again — so sending the same link to
                    a second customer meant copying a 66-character hex id out of
                    the row by hand. */}
                <button className="btn small ghost" onClick={() => share(url)}>
                  Share
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => navigator.clipboard?.writeText(url).catch(() => {})}
                >
                  Copy link
                </button>
                {isActive && (
                  <button
                    className="btn small ghost"
                    disabled={busyId === l.linkId}
                    onClick={() => revoke(l.linkId)}
                  >
                    {busyId === l.linkId ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {/* LINKS FROM EARLIER VERSIONS of the contract. Shown so a merchant's
            history does not vanish on an upgrade — but read-only: the relayer
            only drives the current contract, so these can no longer be paid,
            and offering Share / QR would hand customers a dead link. Revoke
            still works (it is sent to the link's own contract). */}
        {prevLinks.length > 0 && (
          <>
            <div className="label" style={{ fontSize: 15, fontWeight: 700, margin: "22px 0 4px" }}>
              Earlier links ({prevLinks.length})
            </div>
            <div className="sub" style={{ marginBottom: 10, opacity: 0.75 }}>
              Created on an earlier version of PayQR. They no longer accept payments —
              create a new link to replace one.
            </div>
            {prevLinks.map((l) => {
              const country = countryForCurrency(l.currency);
              const expired = l.expiresAt !== 0n && nowSec > l.expiresAt;
              const exhausted = l.maxUses !== 0 && l.uses >= l.maxUses;
              const active = l.status === LinkStatus.ACTIVE;
              return (
                <div className="card" key={`${l.contract}:${l.linkId}`} style={{ marginBottom: 10, opacity: 0.85 }}>
                  <div className="value" style={{ fontSize: 17 }}>
                    {l.amount === 0n
                      ? "Any amount"
                      : priceCfgs[l.currency]
                        ? fmtFiat(country, fiatForUsdc(l.amount, priceCfgs[l.currency]))
                        : "…"}
                  </div>
                  <div className="sub">
                    {l.maxUses === 0 ? "Multi-use" : `${l.uses}/${l.maxUses} used`} ·{" "}
                    {!active ? "Revoked" : expired ? "Expired" : exhausted ? "Used up" : "Retired"}
                  </div>
                  {active && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <button
                        className="btn small ghost"
                        disabled={busyId === l.linkId}
                        onClick={() => revoke(l.linkId, l.contract)}
                      >
                        {busyId === l.linkId ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

          </>
        )}

        {tab === "payments" && (
          <>
        {/*
          PAYMENT-LINK SALES.

          Separate from the Transactions page on purpose: that one merges POS
          sales, link sales and fiat withdrawals into one timeline, which is
          right for "what happened to my money" and wrong for "is my QR working".
          A merchant who just printed a counter QR wants to see only what that
          QR brought in.

          The split needs no tagging of ours — the contract already makes it:
          a POS sale records the MERCHANT as the order's user, a link sale
          records the merchant's PROXY. See fetchLinkOrders.
        */}
        <div className="row" style={{ justifyContent: "space-between", margin: "26px 0 12px" }}>
          <div className="label" style={{ fontSize: 16, fontWeight: 700 }}>Payments received</div>
          {paidOrders.length > 0 && <span className="sub">{paidOrders.length}</span>}
        </div>

        {ordersError && (
          <div className="sub" style={{ color: "var(--warn)", marginBottom: 12 }}>
            Couldn&apos;t load payments right now.
          </div>
        )}

        {/* Only SETTLED orders appear. An order that is placed, or marked paid
            but not yet released, is not money the merchant has — listing it
            alongside real payments invites shipping goods against a payment that
            may still be cancelled. Those orders are not lost: they are on the
            Transactions page, which is the full timeline. */}
        {orders !== null && paidOrders.length === 0 && !ordersError && (
          <div className="card">
            <div className="sub">
              No payments received yet. A payment appears here once the customer&apos;s
              money has actually settled.
            </div>
          </div>
        )}

        {paidOrders.map((o) => {
          const href = receiptHref(o);
          const body = (
            <>
              <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                <div className="value" style={{ fontSize: 18 }}>
                  {/* The flag names the currency the CUSTOMER paid in; the USDC
                      is what actually settled. Both matter and they are not the
                      same number, so neither is dropped. */}
                  {/* The currency the customer paid in, read with the order. */}
                  {o.currency && (
                    <span style={{ marginRight: 8 }} title={o.currency}>
                      {countryForCurrency(o.currency).flag}
                    </span>
                  )}
                  {(Number(o.amount) / 1e6).toFixed(2)} USDC
                </div>
                <div className="sub" style={{ color: "var(--ok, #0f9d6f)", fontWeight: 600 }}>Paid</div>
              </div>
              {/* A dispute can be opened even after a payment settled. The
                  receipt has the support link for it. */}
              {o.dispute === "open" && (
                <div className="sub" style={{ marginTop: 4, color: "var(--warn, #b45309)", fontWeight: 600 }}>
                  Payment under review by support
                </div>
              )}
              {o.dispute === "resolved" && (
                <div className="sub" style={{ marginTop: 4, opacity: 0.8 }}>Review by support finished</div>
              )}
              <div className="sub" style={{ marginTop: 4, opacity: 0.8 }}>
                Order #{o.orderId} ·{" "}
                {new Date((o.completedAt || o.placedAt) * 1000).toLocaleString()}
                {href ? " · View receipt ›" : ""}
              </div>
            </>
          );
          // A receipt needs the order's tx hash to derive its access token, so a
          // row without one cannot be linked — render it plain rather than as a
          // link that would 404.
          return href ? (
            <Link
              key={o.orderId}
              href={href}
              className="card"
              style={{ marginBottom: 10, display: "block", textDecoration: "none", color: "inherit" }}
            >
              {body}
            </Link>
          ) : (
            <div className="card" key={o.orderId} style={{ marginBottom: 10 }}>{body}</div>
          );
        })}
          </>
        )}
      </div>
    </>
  );
}
