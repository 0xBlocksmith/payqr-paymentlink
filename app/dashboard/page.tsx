"use client";

import { useEffect, useState, useRef } from "react";
import { PullToRefresh } from "../../components/ui/PullToRefresh";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Splash } from "../../components/Splash";
import { Icon } from "../../components/Icons";
import { AppTour, tourSeen } from "../../components/AppTour";
import { ConnectionBanner } from "../../components/ConnectionBanner";
import { SetupChecklist } from "../../components/SetupChecklist";
import { Skeleton, LoadingState } from "../../components/ui/LoadingState";
import { ErrorPanel } from "../../components/ui/ErrorPanel";
import { Countdown } from "../../components/ui/Countdown";
import { useRegisteredCurrency } from "../../components/useRegisteredCurrency";
import { useLockPeriod } from "../../components/useLockPeriod";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc } from "../../lib/contract";
import { STATIC_STALE_MS } from "../../lib/cache";
import { fetchUsdcRate } from "../../lib/rates";
import { useHistory } from "../../components/useHistory";
import { loadCountry, fmtFiat, saveCountry, COUNTRIES } from "../../lib/countries";
import { rememberedLinks } from "../../lib/paymentLinks";
import { computeSetup, dismissSetup, setupDismissed } from "../../lib/setup";
import { resolveStatus } from "../../lib/status";
import { fill, fmtAgo, fmtDay, fmtLockWindow } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { usePrevBalances } from "../../components/usePrevBalances";
import { useMerchantProxies } from "../../components/useMerchantProxies";

export default function Dashboard() {
  const router = useRouter();
  const { t, lang } = useT();
  const { ready, authenticated, address, isRegistered } = useMerchant();
  // Every integrator's proxy: link sales, and history from before a contract
  // upgrade, are recorded under them rather than under the merchant.
  const { proxies } = useMerchantProxies(address);
  const [country, setCountry] = useState(null);
  const [rate, setRate] = useState(null);
  const [rateFailed, setRateFailed] = useState(false);
  const [tourForce, setTourForce] = useState(false);
  const [toast, setToast] = useState("");       // settlement-ready banner
  const [welcome, setWelcome] = useState(false); // just registered
  const [dismissed, setDismissed] = useState<string[]>([]); // locally-hidden stuck orders
  const [setupHidden, setSetupHidden] = useState(true);     // true until we know (no flash)

  useEffect(() => { setCountry(loadCountry()); }, []);
  useEffect(() => {
    try { setDismissed(JSON.parse(localStorage.getItem("payqr.dismissedStuck") || "[]")); } catch {}
  }, []);

  // One-shot query flags: ?welcome=1 (just registered) and ?wallet=1 (deep link
  // from the withdraw recovery panel). Read from location, then cleaned off the
  // URL so a refresh doesn't replay them.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      if (q.get("welcome") === "1") { setWelcome(true); setTimeout(() => setWelcome(false), 7000); }
      if (q.has("welcome") || q.has("wallet")) window.history.replaceState(null, "", window.location.pathname);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { if (address) setSetupHidden(setupDismissed(address)); }, [address]);

  // Registration is checked lazily: the dashboard opens for everyone, and we
  // route to /onboarding only when the merchant tries to accept a payment.
  // (isRegistered comes from useMerchant, which also counts a merchant
  // registered on a PREVIOUS integrator — carried over, never onboarded again.)
  function acceptPayment() {
    // Not ready yet (including a returning merchant's carry-over in flight) —
    // don't bounce a registered merchant to /onboarding on a pending read.
    if (!address || !ready) return;
    router.push(isRegistered ? "/qr" : "/onboarding");
  }

  const { data: balance, isError: balanceError, refetch: refetchBalance } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBalance",
    args: [address],
    query: { enabled: !!address, refetchInterval: 20000 },
  });

  // Settlement buckets — each received sale is locked for the currency's
  // settlement window before it's withdrawable. The REAL unlock times come from
  // here (not from a hardcoded period).
  const { data: buckets, refetch: refetchBuckets } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBuckets",
    args: [address],
    query: { enabled: !!address, refetchInterval: 15000 },
  });
  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  const { code: regCode } = useRegisteredCurrency(address);
  const { secs: lockSecs } = useLockPeriod(regCode || null);
  // The REGISTERED currency is immutable and is what the contract settles in, so it
  // overrides a stale UI pick in localStorage (e.g. an old Brazil choice on a device
  // where the merchant registered in India).
  useEffect(() => {
    if (!regCode) return;
    const reg = COUNTRIES.find((c) => c.code === regCode);
    if (reg) { saveCountry(reg.id); setCountry((cur) => (cur?.id === reg.id ? cur : reg)); }
  }, [regCode]);

  // Labels read in days / hours, so a half-minute tick is plenty. (This used to
  // tick every second and re-render the whole page — carousel and list included.)
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!country) return;
    let on = true;
    setRateFailed(false);
    // "sell" price: the dashboard values the merchant's USDC balance at what
    // they'd RECEIVE cashing out to fiat (not the customer-facing buy price).
    fetchUsdcRate(country, "sell").then((r) => on && setRate(r)).catch(() => on && setRateFailed(true));
    return () => { on = false; };
  }, [country]);

  // Shared, cached history (same query the Transactions page uses): instant on
  // navigation, polled while visible, and a failed refresh keeps the last rows.
  const hist = useHistory(address, proxies);
  const rows = (hist.data ?? []) as any[];
  const historyLoaded = !hist.isLoading;
  const historyFailed = hist.isError;
  const loadHistory = { current: () => { hist.refetch(); } };

  const balanceLoaded = balance !== undefined;
  const [pending, available, totalDeposited, isFrozen] = balance ?? [0n, 0n, 0n, false];
  // Includes every PREVIOUS contract, so a contract upgrade never makes the
  // merchant's balance look like it dropped to zero. Moving old funds happens
  // on the withdraw page.
  const prevBal = usePrevBalances(address);
  const availUsdc = (Number(available) + Number(prevBal.available)) / 1e6;
  const settlingUsdc = (Number(pending) + Number(prevBal.pending)) / 1e6;
  const totalUsdc = Number(totalDeposited) / 1e6;
  const fiatOf = (usdc: number) => (rate && country ? fmtFiat(country, usdc * rate.rate) : null);

  // Settlement-ready notification: when the available balance JUMPS UP between
  // refetches, a locked bucket just cleared. (Skips the first read so we don't
  // toast on page load.)
  const prevAvail = useRef(null);
  useEffect(() => {
    if (balance === undefined) return;
    const cur = available;
    if (prevAvail.current != null && cur > prevAvail.current) {
      const cleared = Number(cur - prevAvail.current) / 1e6;
      const label = rate && country ? `≈ ${fmtFiat(country, cleared * rate.rate, { decimals: 2 })}` : `${cleared.toFixed(2)} USDC`;
      setToast(fill(t("dash2.cleared"), { amount: label }));
      const id = setTimeout(() => setToast(""), 6000);
      prevAvail.current = cur;
      return () => clearTimeout(id);
    }
    prevAvail.current = cur;
  }, [available, balance, rate, country, t]);

  // Still-locked buckets: each one gets its own countdown row.
  const lockedBuckets = ((buckets as any[]) || []).filter((b) => b.amount > 0n && Number(b.unlockTimestamp) > now);

  const recent = rows.slice(0, 4);

  // Stuck order: a sale still "Waiting" (no payment partner accepted) more than
  // 3 minutes after it was placed. NOTE: there is NO merchant-callable on-chain
  // cancel (the protocol cancels an unmatched order itself after a timeout), so
  // "Dismiss" is a LOCAL hide — the order still resolves on-chain on its own.
  const stuck = rows.find(
    (r) =>
      r.status === "matching" &&
      !dismissed.includes(String(r.orderId)) &&
      (now * 1000 - new Date(r.createdAt).getTime()) > 180_000
  );
  function dismissStuck(orderId) {
    const next = [...dismissed, String(orderId)];
    setDismissed(next);
    try { localStorage.setItem("payqr.dismissedStuck", JSON.stringify(next)); } catch {}
  }

  // First-run checklist signals — all from real data, nothing assumed.
  const setup = computeSetup({
    tourSeen: tourSeen(),
    registered: isRegistered,
    payoutBlob: (info?.[0] as string) || "",
    hasFirstSaleOrLink: rows.length > 0 || rememberedLinks(address).length > 0,
    receivedCount: rows.filter((r) => r.status === "settled").length,
  });
  // Existing merchants who have already done everything never see the card; it
  // is retired silently so it never nags (and so it disappears for new ones too).
  useEffect(() => {
    if (address && historyLoaded && info && setup.complete && !setupDismissed(address)) {
      dismissSetup(address); setSetupHidden(true);
    }
  }, [address, historyLoaded, info, setup.complete]);
  const showSetup = !setupHidden && !setup.complete && ready && isRegistered !== undefined && historyLoaded;

  const queryClient = useQueryClient();
  // Hide-balances toggle (remembered on this device).
  const [hidden, setHidden] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  useEffect(() => { try { setHidden(localStorage.getItem("payqr.hideBal") === "1"); } catch {} }, []);
  const toggleHidden = () => setHidden((h) => { const n = !h; try { localStorage.setItem("payqr.hideBal", n ? "1" : "0"); } catch {} return n; });

  // Auth gate: a logged-out deep-link/refresh must NOT flash the real dashboard
  // before useMerchant's redirect-to-login effect fires.
  if (!ready || !authenticated) return <Splash />;
  if (!country) return <><Nav home /><div className="screen"><LoadingState label={t("common.loading")} /></div></>;

  const mask = (v: React.ReactNode) => (hidden ? "••••" : v);
  const amountFiat = (usdc: number) => fiatOf(usdc) ?? (rateFailed ? t("dash2.rateUnavailable") : "—");

  return (
    <PullToRefresh onRefresh={async () => { await queryClient.invalidateQueries(); await Promise.allSettled([refetchBalance(), hist.refetch()]); }}>
      <Nav home />
      <AppTour force={tourForce} onClose={() => setTourForce(false)} />
      <ConnectionBanner />
      {toast && (
        <Link href="/withdraw" className="settle-toast" role="status">
          <span className="st-ico"><Icon.Check width="16" height="16" /></span>
          <span>{toast}</span>
          <span className="st-cta">{t("dash2.withdrawCta")}</span>
        </Link>
      )}
      <div className="screen">
        {welcome && (
          <div className="ui-ok" role="status" style={{ marginTop: 0 }}>✓ {t("ob.success")}</div>
        )}
        {isFrozen && (
          <div className="frozen-banner" role="alert">
            {t("dash.frozen")}
          </div>
        )}

        {/* BALANCE — what the merchant can use now, what is still settling, and
            the lifetime total. "Received" is never used as a synonym for
            "available". While the read is loading these are skeletons, and if it
            fails they say so — never a made-up $0.00. */}
        <div className="bal-wrap">
        <section className="bal glass-card" aria-label={t("wd.accountBalance")}>
          <button className="bal-eye" onClick={toggleHidden} aria-pressed={hidden}
            aria-label={hidden ? t("dash3.showBal") : t("dash3.hideBal")}>
            {hidden ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.5 7.6C3.9 9.4 2 12 2 12s4 6 10 6c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>
            )}
          </button>
          <div className="bal-main-label">{t("dash2.available")}</div>
          {balanceLoaded ? (
            <>
              <div className="bal-main">{mask(`$${availUsdc.toFixed(2)}`)} <span style={{ fontSize: 14, fontWeight: 600, color: "var(--muted)" }}>USDC</span></div>
              <div className="bal-fiat">{availUsdc > 0 || rate ? mask(`≈ ${amountFiat(availUsdc)}`) : ""} · {t("dash2.availableHint")}</div>
            </>
          ) : balanceError ? (
            <ErrorPanel compact error={t("dash2.loadFailed")} onRetry={() => refetchBalance()} />
          ) : (
            <><Skeleton w={150} h={34} r={8} /><div style={{ marginTop: 6 }}><Skeleton w={110} h={14} /></div></>
          )}

          <div className="bal-row">
            <div className="bal-cell">
              <div className="bal-cell-label">
                {t("dash2.settling")}
                <button type="button" className="info-btn" aria-expanded={infoOpen} aria-label={t("dash3.infoLabel")}
                  onClick={() => setInfoOpen((o) => !o)}>i</button>
              </div>
              <div className="bal-cell-amt">{balanceLoaded ? mask(`$${settlingUsdc.toFixed(2)}`) : <Skeleton w={70} h={18} />}</div>
              <div className="bal-cell-hint">{t("dash2.settlingHint")}</div>
            </div>
            <div className="bal-cell">
              <div className="bal-cell-label">{t("dash2.total")}</div>
              <div className="bal-cell-amt">{balanceLoaded ? mask(`$${totalUsdc.toFixed(2)}`) : <Skeleton w={70} h={18} />}</div>
              <div className="bal-cell-hint">{t("dash2.totalHint")}</div>
            </div>
          </div>

          {infoOpen && (
            <div className="info-pop" role="note">
              <b>{t("dash3.infoTitle")}</b>
              <p>{lockSecs && fmtLockWindow(lockSecs, lang)
                ? fill(t("dash3.infoBody"), { window: fmtLockWindow(lockSecs, lang) })
                : t("dash3.infoBodyNoWin")}</p>
            </div>
          )}

          {/* One countdown per settling payment. Each timer is its own tiny
              component; when it reaches zero the balance is re-read and the
              amount moves into Available. */}
          {balanceLoaded && lockedBuckets.length > 0 && (
            <div className="settle-list" aria-label={t("dash3.settlingList")}>
              {[...lockedBuckets]
                .sort((x, y) => Number(x.unlockTimestamp) - Number(y.unlockTimestamp))
                .map((b, i) => {
                  const unlock = Number(b.unlockTimestamp);
                  return (
                    <div key={`${unlock}-${i}`} className="settle-row">
                      <div className="settle-l">
                        <span className="settle-amt">{mask(`$${fmtUsdc(b.amount)}`)}</span>
                        <span className="settle-date">{fill(t("dash3.availableOnDate"), { date: fmtDay(unlock, lang, unlock - now < 3 * 86400) })}</span>
                      </div>
                      <Countdown unlock={unlock} doneLabel={t("dash3.availableNow")}
                        onDone={() => { refetchBalance(); refetchBuckets(); }} />
                    </div>
                  );
                })}
            </div>
          )}
        </section>
        </div>

        {prevBal.total > 0n && (
          <Link href="/withdraw" className="muted" style={{ display: "block", fontSize: 12.5, margin: "6px 2px 0", textDecoration: "none" }}>
            {fill(t(prevBal.rows.length > 1 ? "dash2.prevMany" : "dash2.prevOne"), { amount: (Number(prevBal.total) / 1e6).toFixed(2) })}
          </Link>
        )}

        {/* First-run guide: only what is left to do, one clear next action. */}
        {showSetup && (
          <SetupChecklist
            signals={{
              tourSeen: tourSeen(), registered: isRegistered, payoutBlob: (info?.[0] as string) || "",
              hasFirstSaleOrLink: rows.length > 0 || rememberedLinks(address).length > 0,
              receivedCount: rows.filter((r) => r.status === "settled").length,
            }}
            currency={regCode || country.code}
            onOpenTour={() => setTourForce(true)}
            onDismiss={() => { dismissSetup(address); setSetupHidden(true); }}
          />
        )}

        {/* quick access — Accept · Withdraw · Payment links */}
        <div className="quick" role="group" aria-label={t("dash2.moreFaster")}>
          <button className="quick-item" onClick={acceptPayment}>
            <span className="quick-ico"><Icon.Down /></span>
            <span>{t("nav.accept")}</span>
          </button>
          <Link className="quick-item" href="/withdraw">
            <span className="quick-ico"><Icon.Up /></span>
            <span>{t("nav.withdraw")}</span>
          </Link>
          <Link className="quick-item" href="/payment-links">
            <span className="quick-ico"><Icon.Link /></span>
            <span>{t("nav.paymentLinks")}</span>
          </Link>
        </div>

        {/* stuck sale — waiting too long for a payment partner. */}
        {stuck && (
          <div className="ui-err ui-err-warn" role="status" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="stuck-ico"><Icon.Clock /></span>
            <div style={{ flex: 1, minWidth: 160 }}>
              <div style={{ fontWeight: 700 }}>{t("dash.stuckTitle")}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                #{stuck.orderId} · {fmtUsdc(stuck.amount)} USDC · {fmtAgo(new Date(stuck.createdAt).getTime(), lang)}
              </div>
            </div>
            <button className="btn small secondary" onClick={acceptPayment}>{t("dash.newSale")}</button>
            <button className="btn small ghost" onClick={() => dismissStuck(stuck.orderId)}>{t("dash.dismiss")}</button>
          </div>
        )}

        {/* recent payments */}
        <div className="recent-head">
          <b>{t("dash.recent")}</b>
          <Link href="/transactions" className="see-all">{t("dash.seeAll")} ›</Link>
        </div>
        {historyFailed && (
          <ErrorPanel compact error={t("err.load")} onRetry={() => loadHistory.current()} />
        )}
        {!historyLoaded && !historyFailed ? (
          <div className="recent-list" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="recent-row"><Skeleton w="100%" h={38} r={10} /></div>)}
          </div>
        ) : recent.length === 0 && !historyFailed ? (
          <div className="dash-empty">
            <b>{t("dash2.empty.title")}</b>
            <p className="muted">{t("dash2.empty.body")}</p>
          </div>
        ) : (
          <div className="recent-list">
            {recent.map((tx) => {
              const usdc = Number(tx.amount) / 1e6;
              const fiat = rate && country ? usdc * rate.rate : null;
              // ONE shared vocabulary (lib/status.ts) — the same labels as the
              // Transactions page and receipts.
              const st = resolveStatus({ status: tx.status, kind: "sale", completedAt: tx.completedAt }, lockSecs, now);
              const when = st.unlockAt ? fmtDay(st.unlockAt, lang, (lockSecs ?? 0) < 3 * 86400) : "";
              const label = st.key === "received_locked" && when ? fill(t("status.receivedOn"), { date: when })
                : st.key === "received_locked" ? t("status.receivedSettling") : t(st.labelKey);
              return (
                <div key={tx.orderId} className="recent-row">
                  <span className={`rr-ico ${st.tone === "success" ? "in" : st.key === "waiting" ? "wait" : "pend"}`}>
                    {st.key === "cancelled" ? <Icon.Back /> : <Icon.Down />}
                  </span>
                  <div className="rr-mid">
                    <div className="rr-amt">
                      {/* "≈": valued at TODAY's sell rate, not the historical charge. */}
                      {fiat != null ? `≈ ${fmtFiat(country, fiat, { decimals: 2 })}` : `${fmtUsdc(tx.amount)} USDC`}
                    </div>
                    <div className="rr-sub">
                      {fmtUsdc(tx.amount)} USDC · #{tx.orderId} · {fmtAgo(new Date(tx.createdAt).getTime(), lang)}
                    </div>
                    <div className={`rr-foot st-${st.tone}`} title={st.estimated ? t("status.estimated") : undefined}>
                      <i aria-hidden="true" />{label}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PullToRefresh>
  );
}
