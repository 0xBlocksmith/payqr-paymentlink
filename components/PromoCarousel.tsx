"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Swipeable row of dashboard promo slides — native scroll-snap (touch/
 * trackpad swipe works with no drag JS), dots below track the active slide.
 */
export function PromoCarousel({ children }: { children: ReactNode[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  const onScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setActive(i);
  };

  return (
    <div>
      <div className="promo-carousel" ref={trackRef} onScroll={onScroll}>
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
