"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useLockPeriod } from "../../components/useLockPeriod";
import { useRegisteredCurrency } from "../../components/useRegisteredCurrency";
import { fill, fmtDay } from "../../lib/format";
import { resolveStatus } from "../../lib/status";
import { Countdown } from "../../components/ui/Countdown";
import { PullToRefresh } from "../../components/ui/PullToRefresh";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useReadContract, usePublicClient } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { historyQuery } from "../../components/useHistory";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Splash } from "../../components/Splash";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc } from "../../lib/contract";
import { fetchHistory, fetchWithdrawals, receiptToken } from "../../lib/history";
import { loadCountry, fmtFiat } from "../../lib/countries";
import { loadMerchantProfile } from "../../lib/cache";
import { fetchUsdcRate } from "../../lib/rates";
import { useT } from "../../lib/i18n";
import { mergeUsdcWithdrawals, fetchChainWithdrawals, loadLedger, scanIncomplete } from "../../lib/usdcWithdrawals";
import { EXPLORER_URL } from "../../lib/chain";
import { STATIC_STALE_MS } from "../../lib/cache";
import { decryptPayout } from "../../lib/payoutCrypto";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { DisputeAppeal } from "../../components/DisputeAppeal";
import { useDisputeOrderStates, OrderDisputeManager, useSupportSigner } from "../../components/OrderDisputeManager";
import { useMerchantProxies } from "../../components/useMerchantProxies";

// Partially hide a payout handle for a SHAREABLE receipt: keep the first 2 chars
// and everything from "@"/domain, mask the middle. e.g. "sheldon@upi" → "sh•••@upi",
// "9876543210" → "98•••3210". Never exposes the full identifier on a public link.
function maskHandle(h: string): string {
  const s = (h || "").trim();
  if (!s) return "";
  const at = s.indexOf("@");
  if (at > 0) {
    const user = s.slice(0, at);
    const head = user.slice(0, 2);
    return `${head}${"•".repeat(Math.max(1, Math.min(3, user.length - 2)))}${s.slice(at)}`;
  }
  if (s.length <= 4) return s[0] + "•••";
  return `${s.slice(0, 2)}•••${s.slice(-4)}`;
}

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// Date-range menu options.
const RANGES = [
  { id: "today", key: "tx.today" },
  { id: "week", key: "tx.week" },
  { id: "month", key: "tx.month" },
  { id: "all", key: "tx.all" },
];

// Menu filter options — plain words, resolved via t().
const FILTERS = [
  { id: "all", key: "tx.filterAll" },
  { id: "settled", key: "tx.fReceived" },
  { id: "settling", key: "tx.fLocked" },
  { id: "withdraw", key: "tx.fWithdrawn" },
  { id: "cancelled", key: "tx.fCancelled" },
];

export default function Transactions() {
  const { t, lang } = useT();
  const router = useRouter();
  const { ready, authenticated, address } = useMerchant();
  const { getIdentity } = useRelayIdentity();
  const supportSigner = useSupportSigner();
  const [country, setCountry] = useState(null);
  const { code: regCode } = useRegisteredCurrency(address);
  const { secs: lockSecs } = useLockPeriod(regCode || null);
  const nowSec = Math.floor(Date.now() / 1000);
  // The soonest still-locked payment: shown under the summary cards with a live countdown.
  const { data: bucketData, refetch: refetchBuckets } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBuckets",
    args: [address], query: { enabled: !!address, refetchInterval: 15000 },
  });
  const nextBucket = ((bucketData as any[]) || [])
    .filter((b) => b.amount > 0n && Number(b.unlockTimestamp) > nowSec)
    .sort((x, y) => Number(x.unlockTimestamp) - Number(y.unlockTimestamp))[0] || null;
  const [rate, setRate] = useState(null);
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false); // last poll failed (network/subgraph)
  const [pdfMsg, setPdfMsg] = useState("");
  const [upiMasked, setUpiMasked] = useState("");

  // Decrypt the merchant's saved payout handle (getMerchantInfo[0]) once, so
  // withdrawal receipt links can carry a MASKED version (which account received
  // the money). Best-effort: on a device without the relay key it stays "" and
  // the receipt simply omits the row.
  const { data: mInfo } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  useEffect(() => {
    const enc = (mInfo?.[0] as string) || "";
    if (!enc || enc === "0x") { setUpiMasked(""); return; }
    let alive = true;
    (async () => {
      try {
        const id = await getIdentity();
        const plain = await decryptPayout(enc, id);
        if (alive) setUpiMasked(plain ? maskHandle(plain) : "");
      } catch { if (alive) setUpiMasked(""); }
    })();
    return () => { alive = false; };
  }, [mInfo, getIdentity]);
  const [filter, setFilter] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [range, setRange] = useState("all"); // today | week | month | all
  const [rangeOpen, setRangeOpen] = useState(false);
  const [q, setQ] = useState("");
  const publicClient = usePublicClient();
  const [wdScanFailed, setWdScanFailed] = useState(false); // the on-chain USDC-withdrawal scan failed: list may be incomplete
  const PAGE = 50;
  const [shown, setShown] = useState(PAGE);                  // rows rendered; a long history is paged

  useEffect(() => { setCountry(loadCountry()); }, []);
  useEffect(() => {
    if (!country) return;
    fetchUsdcRate(country).then(setRate).catch(() => {});
  }, [country]);

  // Build the IN-APP receipt link for a transaction (no Basescan). The receipt
  // page needs the order id in the path + an access token derived from the order's
  // tx hash (see receiptToken). A row without a tx hash (still matching, no on-chain
  // hash yet) can't produce a valid token, so it isn't linked. `shop`/`fiat` are
  // display hints only — the receipt re-reads the real shop name from chain.
  const receiptHref = useCallback((tx) => {
    if (!tx?.orderId || !tx?.txHash) return "";
    // Order id + access token only: the receipt shows nothing from its URL
    // (review H1). `kind` just says which table to look in first.
    const q = new URLSearchParams({
      token: receiptToken(String(tx.orderId), tx.txHash),
      kind: tx.kind === "withdraw" ? "withdraw" : "buy",
    });
    return `/receipt/${tx.orderId}?${q.toString()}`;
  }, []);

  // The merchant's per-merchant proxy. Two different things are indexed under
  // it: fiat withdrawals (SELL orders), and — less obviously — every PAYMENT
  // LINK sale, because `relayerPlaceOrder` records the proxy as the order's
  // user where a POS sale records the merchant. So this address is needed for
  // the payments query too, not only the withdrawals one.
  // One proxy PER INTEGRATOR: an upgrade gives the merchant a new proxy, and
  // link sales / withdrawals made before it are recorded under the old one.
  const { proxies } = useMerchantProxies(address);
  const proxyKey = (proxies ?? []).join(",");

  const queryClient = useQueryClient();
  const byTime = (a, b) => b.placedAt - a.placedAt;

  // Paint INSTANTLY from the shared history cache (Home loads the same query),
  // instead of a spinner while the subgraph is asked again.
  useEffect(() => {
    if (!address || !proxies) return;
    const cached = queryClient.getQueryData(historyQuery(address, proxies).queryKey) as any[] | undefined;
    if (cached?.length) {
      setRows((cur) => (cur.length ? cur : cached.map((r) => ({ ...r, kind: "payment" })).sort(byTime)));
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, proxyKey]);

  const refresh = useCallback(async () => {
    if (!address || !proxies) return;
    // All three sources start AT ONCE and each one updates the list the moment
    // it answers — the list never waits for the slowest (the on-chain scan):
    //   payments  (shared cached query — instant when Home already loaded it)
    //   fiat withdrawals (subgraph)
    //   USDC withdrawals (chain events + this device's ledger)
    const replace = (kind: string, next: any[]) =>
      setRows((cur) => [...cur.filter((r) => r.kind !== kind), ...next].sort(byTime));
    const paymentsP = queryClient.fetchQuery(historyQuery(address, proxies)) as Promise<any[]>;
    // Settled up front so a rejection is never left unhandled if payments fail first.
    const withdrawalsP = (proxies.length ? fetchWithdrawals(proxies) : Promise.resolve([] as any[])).then(
      (r: any[]) => ({ r }), (error: unknown) => ({ error }));
    const chainP = publicClient
      ? fetchChainWithdrawals(publicClient, address).then((r) => ({ ok: true, r }), (e) => { console.error(e); return { ok: false, r: [] }; })
      : Promise.resolve({ ok: true, r: [] });
    try {
      // fetchHistory/fetchWithdrawals throw on network AND subgraph faults so a
      // failed poll never wipes real rows: keep the last good list and only flag
      // the failure, so an EMPTY list says "couldn't load", not "no transactions".
      const payments = await paymentsP;
      replace("payment", payments.map((r) => ({ ...r, kind: "payment" })));
      setLoadError(false);
      setLoaded(true);
      const w: any = await withdrawalsP;
      if ("error" in w) throw w.error;
      replace("withdraw", w.r);
    } catch (e) {
      console.error(e);
      setLoadError(true);
    } finally {
      setLoaded(true);
    }
    const chain = await chainP;
    const incomplete = !chain.ok || scanIncomplete(address);
    replace("usdc_withdraw", mergeUsdcWithdrawals(chain.r as any[], loadLedger(address), { scanComplete: !incomplete }));
    setWdScanFailed(incomplete);
    // proxyKey stands in for proxies: same content, stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, proxyKey, publicClient, queryClient]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  // map each row to a normalized shape with a "type"
  const all = useMemo(
    () => rows.map((tx) => ({ ...tx, type: "sale" })),
    [rows]
  );

  // Multi-day report: restrict to today / last 7 days / last 30 days / all.
  const items = useMemo(() => {
    if (range === "all") return all;
    const now = Date.now();
    const span = range === "today" ? 1 : range === "week" ? 7 : 30;
    // "today" = since local midnight; week/month = rolling N days.
    const cutoff = range === "today"
      ? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      : now - span * 86400_000;
    return all.filter((t) => new Date(t.createdAt).getTime() >= cutoff);
  }, [all, range]);

  const filtered = useMemo(() => {
    let list = items;
    const isWd = (t) => t.kind === "withdraw" || t.kind === "usdc_withdraw";
    if (filter === "withdraw") list = list.filter(isWd);
    else if (filter === "settled") list = list.filter((t) => !isWd(t) && t.status === "settled");
    else if (filter === "settling") list = list.filter((t) => !isWd(t) && t.status === "matching");
    else if (filter === "cancelled") list = list.filter((t) => !isWd(t) && t.status === "cancelled");
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter((t) => `#${t.orderId}`.includes(needle) || fmtUsdc(t.amount).includes(needle));
    }
    return list;
  }, [items, filter, q]);

  // Dispute Manager: batched live on-chain read for every visible PAYMENT row
  // (withdrawals aren't disputable orders, so they're excluded). One multicall
  // for the whole visible page rather than a call per row.
  // Counter (POS) sales only: p2p.me's support bridge serves the order's own
  // user, and a payment-link sale belongs to the merchant's proxy, so its chip
  // could never work there (review). Link sales get their dispute status and
  // PayQR support below instead.
  const disputableOrderIds = useMemo(
    () => filtered.filter((t) => t.kind !== "withdraw" && !t.isLink).map((t) => t.orderId),
    [filtered]
  );
  const { rows: disputeRows } = useDisputeOrderStates(disputableOrderIds);

  // Report totals are over RECEIVED sales in the chosen range (money in hand).
  const received = items.filter((t) => t.status === "settled");
  const totalUsdc = received.reduce((a, t) => a + Number(t.amount) / 1e6, 0);
  const totalFiat = rate && country ? totalUsdc * rate.rate : null;

  // Export a clean PDF statement. We render a print-ready document and trigger
  // the browser's print dialog → "Save as PDF" — works on every device with no
  // library or download of a raw file. Shopkeeper gets a real statement.
  function exportPdf() {
    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const today = new Date().toLocaleDateString(country?.locale || undefined, {
      day: "numeric", month: "long", year: "numeric",
    });
    const label = (s) =>
      s === "settled" ? "Received" : s === "cancelled" ? "Cancelled" : "Waiting";
    const rowsHtml = items.map((t) => {
      const d = new Date(t.createdAt).toLocaleString(country?.locale || undefined,
        { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      return `<tr>
        <td>#${esc(t.orderId)}</td>
        <td>${esc(d)}</td>
        <td class="r">${fmtUsdc(t.amount)} USDC</td>
        <td>${label(t.status)}</td>
      </tr>`;
    }).join("");

    const totalLine = totalFiat != null
      ? `${fmtFiat(country, totalFiat)} ${country.code} · ${totalUsdc.toFixed(2)} USDC`
      : `${totalUsdc.toFixed(2)} USDC`;

    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>PayQR statement</title>
      <style>
        * { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        body { color: #14141d; padding: 28px; }
        .top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
        .brand { font-size: 20px; font-weight: 700; color: #1488ff; }
        .sub { color: #71717f; font-size: 12px; margin-top: 2px; }
        .sum { background: #eef5ff; border: 1px solid #cfe5ff; border-radius: 10px; padding: 14px 16px; margin-bottom: 18px; }
        .sum .k { font-size: 11px; color: #71717f; text-transform: uppercase; letter-spacing: .06em; }
        .sum .v { font-size: 20px; font-weight: 700; margin-top: 2px; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th { text-align: left; color: #71717f; font-weight: 600; font-size: 10px;
             text-transform: uppercase; letter-spacing: .05em; padding: 8px 6px; border-bottom: 1.5px solid #e0e0ec; }
        td { padding: 9px 6px; border-bottom: 1px solid #ececf4; }
        td.r, th.r { text-align: right; }
        .foot { margin-top: 20px; font-size: 10px; color: #a4a4b3; }
      </style></head><body>
      <div class="top">
        <div><div class="brand">PayQR</div><div class="sub">Sales statement · ${esc(today)}</div></div>
        <div class="sub">${items.length} transaction${items.length === 1 ? "" : "s"}</div>
      </div>
      <div class="sum"><div class="k">Total received</div><div class="v">${esc(totalLine)}</div></div>
      <table>
        <thead><tr><th>Order</th><th>Date</th><th class="r">Amount</th><th>Status</th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="4" style="text-align:center;color:#a4a4b3;padding:20px">No transactions</td></tr>`}</tbody>
      </table>
      <div class="foot">Settled in USDC on Base · powered by p2p.me. Generated by the merchant from their PayQR terminal.</div>
      <script>window.onload = () => { window.print(); }</script>
      </body></html>`;

    const w = window.open("", "_blank");
    // Popup blocked (in-app browsers, strict settings) → say so instead of a
    // button that silently does nothing.
    if (!w) return setPdfMsg("Allow pop-ups for this site to download the statement.");
    setPdfMsg("");
    w.document.write(html);
    w.document.close();
  }

  // Auth gate: never flash the transactions list for a logged-out deep-link.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <PullToRefresh onRefresh={async () => { await refresh(); }}>
      <Nav back />
      <div className="screen">
        <h1 className="page-h">{t("tx.title")}</h1>

        {/* report summary for the chosen range */}
        {/* Same balance card as Home: the total received, in USDC only. */}
        <section className="bal glass-card" aria-label={t("tx.received")}>
          <div className="bal-main-label">{t("tx.received")} · {received.length}</div>
          <div className="bal-main">${totalUsdc.toFixed(2)} <span style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)" }}>USDC</span></div>
        </section>

        {nextBucket && (
          <section className="next-avail" aria-label={t("tx.nextAvail")}>
            <div className="next-avail-h">{t("tx.nextAvail")}</div>
            <div className="settle-row">
              <div className="settle-l">
                <span className="settle-amt">${fmtUsdc(nextBucket.amount)} USDC</span>
                <span className="settle-date">
                  {fill(t("dash3.availableOnDate"), { date: fmtDay(Number(nextBucket.unlockTimestamp), lang, Number(nextBucket.unlockTimestamp) - nowSec < 3 * 86400) })}
                </span>
              </div>
              <Countdown unlock={Number(nextBucket.unlockTimestamp)} doneLabel={t("dash3.availableNow")}
                onDone={() => refetchBuckets()} />
            </div>
          </section>
        )}

        {/* range + filter menus, then search */}
        <div className="hist-tools">
          {/* date-range menu */}
          <div className="hist-filter">
            <button className={`hist-filter-btn ${rangeOpen ? "on" : ""}`}
              onClick={() => { setRangeOpen((o) => !o); setFilterOpen(false); }}>
              <Icon.Clock width="15" height="15" />
              {t(RANGES.find((r) => r.id === range)?.key || "tx.all")}
              <span className="hf-car">▾</span>
            </button>
            {rangeOpen && (
              <div className="hist-filter-pop">
                {RANGES.map((r) => (
                  <button key={r.id} className={`hist-filter-item ${range === r.id ? "sel" : ""}`}
                    onClick={() => { setRange(r.id); setRangeOpen(false); }}>
                    {t(r.key)}
                    {range === r.id && <span className="hf-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* status filter menu */}
          <div className="hist-filter">
            <button className={`hist-filter-btn ${filterOpen ? "on" : ""}`}
              onClick={() => { setFilterOpen((o) => !o); setRangeOpen(false); }}>
              <Icon.Chart width="15" height="15" />
              {t(FILTERS.find((f) => f.id === filter)?.key || "tx.filterAll")}
              <span className="hf-car">▾</span>
            </button>
            {filterOpen && (
              <div className="hist-filter-pop">
                {FILTERS.map((f) => (
                  <button key={f.id} className={`hist-filter-item ${filter === f.id ? "sel" : ""}`}
                    onClick={() => { setFilter(f.id); setFilterOpen(false); }}>
                    {t(f.key)}
                    {filter === f.id && <span className="hf-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* search */}
        <input
          className="input hist-search-full"
          placeholder={t("tx.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {!ready || !loaded ? (
          <p className="muted" style={{ textAlign: "center", marginTop: 24 }}>{t("common.loading")}</p>
        ) : filtered.length === 0 ? (
          <div className="recent-empty" style={{ marginTop: 18 }}>
            {items.length === 0
              ? loadError
                ? "Couldn't load your transactions — will keep retrying…"
                : t("tx.none")
              : t("tx.noMatch")}
          </div>
        ) : (
          <div className="hist-list">
            {filtered.slice(0, shown).map((tx) => {
              const usdc = Number(tx.amount) / 1e6;
              const fiat = rate && country ? usdc * rate.rate : null;
              const isFiatWd = tx.kind === "withdraw";
              const isUsdcWd = tx.kind === "usdc_withdraw";
              const isWithdraw = isFiatWd || isUsdcWd;
              const settled = tx.status === "settled";
              const cancelled = tx.status === "cancelled";
              // ONE status vocabulary (lib/status.ts) for sales AND withdrawals.
              const st = resolveStatus(
                { status: tx.status, kind: isWithdraw ? "withdraw" : "sale", completedAt: tx.completedAt },
                lockSecs, nowSec
              );
              // money OUT (withdrawal) vs money IN (payment)
              const cls = isWithdraw ? (st.tone === "danger" ? "bad" : "out") : settled ? "ok" : cancelled ? "bad" : "wait";
              const to = isUsdcWd
                ? (tx.destination ? fill(t("tx.toAddress"), { addr: `${tx.destination.slice(0, 6)}…${tx.destination.slice(-4)}` }) : t("tx.toYourWallet"))
                : country.fiat;
              const sub = isWithdraw
                ? `${fmtUsdc(tx.amount)} USDC → ${to}${isUsdcWd ? "" : ` · #${tx.orderId}`}`
                : `${fmtUsdc(tx.amount)} USDC · #${tx.orderId}`;
              // Tapping a row opens the IN-APP receipt (not Basescan). Rows without
              // a receipt link yet (no tx hash) render as a plain, non-clickable row.
              // A USDC withdrawal is not an order: no receipt page, it links to the explorer.
              const href = isUsdcWd ? "" : receiptHref(tx);
              // Same status the dashboard shows: "Received · Available on <date>"
              // plus a live countdown while it is still settling.
              const when = st.unlockAt ? fmtDay(st.unlockAt, lang, (lockSecs ?? 0) < 3 * 86400) : "";
              const footLabel = st.key === "received_locked" && when ? fill(t("status.receivedOn"), { date: when })
                : st.key === "received_locked" ? t("status.receivedSettling") : t(st.labelKey);
              const inner = (
                <>
                  <span className={`hist-ico ${cls}`}>
                    {isWithdraw ? <Icon.Up width="18" height="18" />
                      : cancelled ? <Icon.Back width="18" height="18" />
                      : <Icon.Down width="18" height="18" />}
                  </span>
                  <div className="hist-mid">
                    <div className="hist-top">
                      <div className="hist-fiat">
                        {/* "≈": rows are valued at TODAY's buy rate for the UI
                            country — an estimate, not the historical charge. */}
                        {isWithdraw ? "− " : ""}{fiat != null ? `≈ ${fmtFiat(country, fiat, { decimals: 2 })}` : "—"}
                      </div>
                      <span className="hist-time">{timeAgo(tx.createdAt)}</span>
                    </div>
                    <div className="hist-crypto">{sub}</div>
                    <div className={`rr-foot st-${st.tone}`} title={st.estimated ? t("status.estimated") : undefined}>
                      <i aria-hidden="true" /><span className="rr-lbl">{footLabel}</span>
                    </div>
                    {st.unlockAt && !isWithdraw ? (
                      <div className="hist-cd"><Countdown unlock={st.unlockAt} doneLabel={t("dash3.availableNow")} /></div>
                    ) : null}
                  </div>
                </>
              );
              const rowEl = href ? (
                <button className="hist-row" onClick={() => router.push(href)} type="button">
                  {inner}
                </button>
              ) : (
                <div className="hist-row hist-row-static">
                  {inner}
                  {isUsdcWd && tx.txHash && (
                    <a className="hist-explorer" href={`${EXPLORER_URL}/tx/${tx.txHash}`} target="_blank" rel="noopener noreferrer"
                       aria-label={t("wd.viewOnExplorer")}>↗</a>
                  )}
                </div>
              );
              // Dispute Manager chip: payment rows only (a withdrawal isn't a
              // disputable order), and only once its live on-chain state has
              // loaded. Rendered as a sibling — never nested inside the row's
              // own <button>, which would make it an invalid/broken nested
              // control and double-fire the receipt navigation on tap.
              const disputeRow = !isWithdraw && supportSigner ? disputeRows.get(tx.orderId) : null;
              return (
                <div key={`${tx.kind}-${tx.orderId}`} className="hist-row-wrap">
                  {rowEl}
                  {disputeRow && (
                    <OrderDisputeManager
                      orderId={tx.orderId}
                      order={disputeRow.order}
                      signer={supportSigner}
                    />
                  )}
                  {disputeRow && !tx.isLink && tx.dispute === "open" && (
                    <DisputeAppeal
                      orderId={tx.orderId}
                      enabled={disputeRow.order.user?.toLowerCase() === (supportSigner?.address ?? "").toLowerCase()}
                    />
                  )}
                  {!isWithdraw && tx.isLink && tx.dispute && tx.dispute !== "none" && (
                    <div className="sub" style={{ margin: "4px 0 10px", fontSize: 12.5 }}>
                      {tx.dispute === "open" ? "Payment under review by support · " : "Review by support finished · "}
                      <a
                        href={`https://t.me/PayQRdotPRO?text=${encodeURIComponent(`Hi, I need help with payment #${tx.orderId}.`)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Contact support ↗
                      </a>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {filtered.length > shown && (
          <button className="btn ghost" style={{ width: "100%", marginTop: 12 }} onClick={() => setShown((n) => n + PAGE)}>
            {fill(t("tx.showMore"), { n: filtered.length - shown })}
          </button>
        )}
        {loaded && wdScanFailed && (
          <p className="muted tiny" style={{ textAlign: "center", marginTop: 8 }}>{t("tx.wdScanFailed")}</p>
        )}

        {items.length > 0 && (
          <button className="btn ghost act-export" onClick={exportPdf}>
            <Icon.Receipt /> {t("tx.downloadPdf")}
          </button>
        )}
        {pdfMsg && <p className="error" style={{ textAlign: "center" }}>{pdfMsg}</p>}
      </div>

    </PullToRefresh>
  );
}
