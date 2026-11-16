"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

const TRIGGER = 72;

/**
 * Touch pull-to-refresh. When the page is scrolled to the top and the user drags
 * down, a small spinner follows the finger; releasing past the threshold runs
 * `onRefresh`. Renders no wrapper element (no transform), so fixed children keep
 * working. The browser's own pull-to-refresh is already off (overscroll-behavior).
 */
export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<unknown> | void; children: ReactNode }) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const startY = useRef<number | null>(null);
  const pullRef = useRef(0);
  const busyRef = useRef(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;

  useEffect(() => {
    /** A drag that starts inside something that scrolls on its own, inside an open
     *  overlay / dialog, or while the user is typing, belongs to THAT — never to a
     *  page refresh (which on Disputes would remount a half-filled support widget). */
    function ownsGesture(target: EventTarget | null): boolean {
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return true;
      for (let el = target as HTMLElement | null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (el.matches?.('[role="dialog"], [aria-modal="true"], .sheet, .confirm-overlay, .sm-overlay, .su-layer')) return true;
        const cs = getComputedStyle(el);
        if (cs.position === "fixed") return true;                       // overlays, sheets, bars
        const oy = cs.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) return true;
      }
      return false;
    }
    function start(e: TouchEvent) {
      if (busyRef.current || window.scrollY > 0 || ownsGesture(e.target)) { startY.current = null; return; }
      startY.current = e.touches[0].clientY;
    }
    function move(e: TouchEvent) {
      if (startY.current == null) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) { pullRef.current = 0; setPull(0); return; }
      setDragging(true);
      pullRef.current = Math.min(110, dy * 0.5);
      setPull(pullRef.current);
    }
    async function end() {
      if (startY.current == null) return;
      startY.current = null;
      setDragging(false);
      const fire = pullRef.current >= TRIGGER * 0.75;
      pullRef.current = 0;
      if (!fire) return setPull(0);
      busyRef.current = true; setBusy(true); setPull(48);
      try { await cb.current(); } catch { /* the page shows its own error state */ }
      // keep the spinner visible long enough to register
      setTimeout(() => { busyRef.current = false; setBusy(false); setPull(0); }, 400);
    }
    window.addEventListener("touchstart", start, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", end);
    window.addEventListener("touchcancel", end);
    return () => {
      window.removeEventListener("touchstart", start);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", end);
      window.removeEventListener("touchcancel", end);
    };
  }, []);

  return (
    <>
      <div className="ptr" role="status" aria-hidden={!busy && pull === 0}
        style={{ transform: `translate(-50%, ${pull - 44}px)`, opacity: Math.min(1, pull / 40), transition: dragging ? "none" : "transform 0.25s, opacity 0.25s" }}>
        <span className={`ptr-spin ${busy ? "on" : ""}`} style={busy ? undefined : { transform: `rotate(${pull * 4}deg)` }} />
      </div>
      {children}
    </>
  );
}
