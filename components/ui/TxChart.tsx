"use client";

import { useMemo } from "react";

type Row = { createdAt: string | number | Date; usdc: number };

/** Glass line chart of received USDC per day (last `days` days). Pure SVG. */
export function TxChart({ rows, days, title, headline, unit = "USDC" }: { rows: Row[]; days: number; title: string; headline?: string; unit?: string }) {
  const { pts, total, max } = useMemo(() => {
    const day = 86400000;
    const end = new Date(); end.setHours(0, 0, 0, 0);
    const buckets = Array.from({ length: days }, () => 0);
    for (const r of rows) {
      const d = new Date(r.createdAt); d.setHours(0, 0, 0, 0);
      const i = days - 1 - Math.round((end.getTime() - d.getTime()) / day);
      if (i >= 0 && i < days) buckets[i] += r.usdc;
    }
    const mx = Math.max(...buckets, 0.01);
    const W = 300, H = 110, P = 8;
    const p = buckets.map((v, i) => [P + (i * (W - 2 * P)) / Math.max(1, days - 1), H - P - (v / mx) * (H - 2 * P)]);
    return { pts: p, total: buckets.reduce((a, b) => a + b, 0), max: mx };
  }, [rows, days]);

  const line = pts.map(([x, y], i) => {
    if (i === 0) return `M${x},${y}`;
    const [px, py] = pts[i - 1]; const cx = (px + x) / 2;
    return `C${cx},${py} ${cx},${y} ${x},${y}`;
  }).join(" ");
  const area = `${line} L${pts[pts.length - 1][0]},110 L${pts[0][0]},110 Z`;
  const last = pts[pts.length - 1];

  return (
    <section className="tx-chart" aria-label={title}>
      <div className="tx-chart-head">
        <span>{title}</span>
        <strong>{headline ?? `${total.toFixed(2)} ${unit}`}</strong>
      </div>
      <div className="tx-chart-sub">
        <span>{total.toFixed(2)} {unit} · {days}d</span>
      </div>
      <svg viewBox="0 0 300 110" preserveAspectRatio="none" role="img" aria-label={`${title}: ${total.toFixed(2)} ${unit}`}>
        <defs>
          <linearGradient id="txg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2="300" y1={110 * f} y2={110 * f} className="tx-grid" />)}
        <path d={area} fill="url(#txg)" />
        <path d={line} className="tx-line" fill="none" />
        {max > 0.01 && <circle cx={last[0]} cy={last[1]} r="3.5" className="tx-dot" />}
      </svg>
      <div className="tx-chart-axis"><span>{days - 1}d ago</span><span>Today</span></div>
    </section>
  );
}
