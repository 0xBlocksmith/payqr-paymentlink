"use client";

import { useEffect, useState } from "react";
import { Nav } from "../../components/Nav";
import { Splash } from "../../components/Splash";
import { useMerchant } from "../../components/useMerchant";
import { fetchHistory } from "../../lib/history";
import { loadCountry, fmtFiat } from "../../lib/countries";
import { fetchUsdcRate } from "../../lib/rates";
import { useT } from "../../lib/i18n";
import { useMerchantProxies } from "../../components/useMerchantProxies";

// Challenge window: Sep 1–15, 2026, inclusive, in the MERCHANT'S LOCAL TIME.
// Only successful (settled) orders PLACED in this window count — nothing from
// before Sep 1 carries over into the $500 goal.
//
// Local, not UTC: the window has to line up with the shopkeeper's trading days.
// Anchored to UTC midnight it opened at 05:30 on Sep 1 for a merchant in IST
// (and, worse, closed mid-morning on the 15th), so a full first and last day of
// real sales fell outside the window. `new Date(y, m, d)` builds LOCAL midnight,
// which is exactly the boundary a merchant means by "the 1st to the 15th".
const WINDOW_START = new Date(2026, 8, 1).getTime();        // Sep 1, 00:00 local
const WINDOW_END = new Date(2026, 8, 16).getTime();         // Sep 16, 00:00 local — exclusive
const GOAL_USDC = 500;
const REWARD_USDC = 5;

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function Campaign() {
  const { t } = useT();
  const { ready, authenticated, address } = useMerchant();
  // Every integrator's proxy: link sales, and history from before a contract
  // upgrade, are recorded under them rather than under the merchant.
  const { proxies } = useMerchantProxies(address);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [country, setCountry] = useState(null);
  const [rate, setRate] = useState(null);

  useEffect(() => { setCountry(loadCountry()); }, []);
  useEffect(() => {
    if (!country) return;
    let on = true;
    // Same rate the dashboard uses for "your balance is worth ≈ X" — the
    // merchant's actual sell/payout rate, not an external FX quote.
    fetchUsdcRate(country, "sell").then((r) => on && setRate(r)).catch(() => {});
    return () => { on = false; };
  }, [country]);

  useEffect(() => {
    if (!address || !proxies) return;
    let cancelled = false;
    fetchHistory(address, proxies)
      .then((data) => { if (!cancelled) setRows(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, (proxies ?? []).join(",")]);

  if (!ready || !authenticated) return <Splash />;

  const toFiat = (usdc: number) =>
    country && rate ? `≈ ${fmtFiat(country, usdc * rate.rate)}` : null;

  // Only settled orders placed inside the challenge window count toward the
  // goal — no prior transactions, and nothing still matching/cancelled.
  const qualifying = rows
    .filter((t) => t.status === "settled")
    .filter((t) => {
      const ts = new Date(t.createdAt).getTime();
      return ts >= WINDOW_START && ts < WINDOW_END;
    })
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const totalUsdc = qualifying.reduce((sum, t) => sum + Number(t.amount) / 1e6, 0);
  const pct = Math.min(100, (totalUsdc / GOAL_USDC) * 100);
  const goalHit = totalUsdc >= GOAL_USDC;

  return (
    <>
      <Nav back backHref="/dashboard" />
      <div className="screen">
        <div className="camp-hero">
          <div className="promo-tag">{t("camp.tag")}</div>
          <h1>{t("camp.bannerH")}</h1>
          <p>{t("camp.heroText")}</p>
          <div className="camp-window">{t("camp.window")}</div>
        </div>

        <div className="camp-progress-card">
          <div className="camp-progress-top">
            <span className="camp-progress-amt">${totalUsdc.toFixed(2)} <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>/ ${GOAL_USDC}</span></span>
            <span className="camp-progress-pct">{pct.toFixed(0)}%</span>
          </div>
          <div className="camp-bar-track">
            <div className="camp-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          {toFiat(totalUsdc) && (
            <div className="camp-fiat-sub">{toFiat(totalUsdc)} / {toFiat(GOAL_USDC)}</div>
          )}
        </div>

        <div className="camp-reward">
          <span className="camp-reward-ico">$5</span>
          <div className="camp-reward-text">
            {goalHit
              ? t("camp.goalReached").replace("{fiat}", toFiat(REWARD_USDC) ? ` (${toFiat(REWARD_USDC)})` : "")
              : t("camp.rewardPending")
                  .replace("{fiat}", toFiat(GOAL_USDC) ? ` (${toFiat(GOAL_USDC)})` : "")
                  .replace("{rewardFiat}", toFiat(REWARD_USDC) ? ` (${toFiat(REWARD_USDC)})` : "")}
          </div>
        </div>

        <div className="camp-list-title">{t("camp.qualifyingOrders").replace("{n}", String(qualifying.length))}</div>
        {loading ? (
          <p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p>
        ) : qualifying.length === 0 ? (
          <p className="muted" style={{ textAlign: "center" }}>{t("camp.none")}</p>
        ) : (
          <div className="recent-list">
            {qualifying.map((row) => {
              const usdc = Number(row.amount) / 1e6;
              return (
                <div className="camp-order-row" key={row.orderId}>
                  <div>
                    <div className="camp-order-id">{t("camp.order").replace("{id}", row.orderId)}</div>
                    <div className="camp-order-date">{fmtDate(row.createdAt)}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="camp-order-amt">+${usdc.toFixed(2)}</div>
                    {toFiat(usdc) && <div className="camp-order-fiat">{toFiat(usdc)}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
