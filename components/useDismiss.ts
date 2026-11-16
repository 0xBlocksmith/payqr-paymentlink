"use client";

import { useEffect } from "react";

/** Close a popover on an outside press or Escape. */
export function useDismiss(ref: React.RefObject<HTMLElement>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      document.removeEventListener("keydown", key);
    };
  }, [ref, open, onClose]);
}
