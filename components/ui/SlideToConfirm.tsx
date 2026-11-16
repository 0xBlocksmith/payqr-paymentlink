"use client";

import { useRef, useState } from "react";

/**
 * Slide-to-confirm control in the brand colour. Drag the thumb to the end to
 * confirm (guards against accidental taps on a money action). Keyboard / screen
 * reader users activate it with Enter or Space on the thumb.
 */
export function SlideToConfirm({ label, disabled, busy, onConfirm }: {
  label: string; disabled?: boolean; busy?: boolean; onConfirm: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [x, setX] = useState(0);
  const [drag, setDrag] = useState(false);
  const start = useRef(0);
  const THUMB = 48;
  const max = () => Math.max(0, (track.current?.clientWidth || 0) - THUMB - 8);
  const off = disabled || busy;

  function down(e: React.PointerEvent) {
    if (off) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    start.current = e.clientX - x;
    setDrag(true);
  }
  function move(e: React.PointerEvent) {
    if (!drag) return;
    setX(Math.min(max(), Math.max(0, e.clientX - start.current)));
  }
  function up() {
    if (!drag) return;
    setDrag(false);
    if (max() > 0 && x >= max() * 0.88) { setX(max()); onConfirm(); setTimeout(() => setX(0), 600); }
    else setX(0);
  }
  const pct = max() ? x / max() : 0;

  return (
    <div ref={track} className={`slide ${off ? "off" : ""}`} aria-busy={busy}>
      <div className="slide-fill" style={{ width: x + THUMB + 4 }} />
      <span className="slide-label" style={{ opacity: 1 - pct * 1.3 }}>{label}</span>
      <button type="button" className="slide-thumb" disabled={off} aria-label={label}
        style={{ transform: `translateX(${x}px)`, transition: drag ? "none" : "transform 0.25s cubic-bezier(0.2,0.7,0.2,1)" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !off) { e.preventDefault(); onConfirm(); } }}>
        {busy ? <span className="slide-spin" /> : (
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        )}
      </button>
    </div>
  );
}
