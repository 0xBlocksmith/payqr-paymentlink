"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** How long each slide stays before auto-advancing. */
const AUTO_MS = 4500;

/**
 * Swipeable row of dashboard promo slides — native scroll-snap (touch/
 * trackpad swipe works with no drag JS), dots below track the active slide.
 *
 * Auto-advances every few seconds, looping back to the first slide. It holds
 * still while the merchant is touching, hovering or focused on it, while the
 * tab is hidden, and always for visitors who prefer reduced motion.
 */
export function PromoCarousel({ children }: { children: ReactNode[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = children.length;

  const onScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setActive(i);
  };

  useEffect(() => {
    if (count < 2 || paused) return;
    let reduced = false;
    try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch {}
    if (reduced) return;
    const id = window.setInterval(() => {
      const el = trackRef.current;
      if (!el || document.hidden) return;
      const next = (Math.round(el.scrollLeft / el.clientWidth) + 1) % count;
      el.scrollTo({ left: next * el.clientWidth, behavior: "smooth" });
    }, AUTO_MS);
    return () => window.clearInterval(id);
  }, [count, paused]);

  // A finger on the carousel pauses it; resume a moment after the swipe settles.
  const resumeTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(resumeTimer.current), []);
  const hold = () => { window.clearTimeout(resumeTimer.current); setPaused(true); };
  const release = (delay = 0) => {
    window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setPaused(false), delay);
  };

  return (
    <div>
      <div
        className="promo-carousel"
        ref={trackRef}
        onScroll={onScroll}
        onMouseEnter={hold}
        onMouseLeave={() => release()}
        onTouchStart={hold}
        onTouchEnd={() => release(AUTO_MS)}
        onTouchCancel={() => release(AUTO_MS)}
        onFocus={hold}
        onBlur={() => release()}
      >
        {children.map((child, i) => (
          <div key={i}>{child}</div>
        ))}
      </div>
      <div className="promo-dots">
        {children.map((_, i) => (
          <span key={i} className={`promo-dot${i === active ? " active" : ""}`} />
        ))}
      </div>
    </div>
  );
}
