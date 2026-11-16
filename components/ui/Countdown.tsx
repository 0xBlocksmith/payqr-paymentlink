"use client";

import { useEffect, useRef, useState } from "react";

/** Live countdown to a unix-seconds timestamp. Owns its own 1s timer so only this
 *  tiny node re-renders each second (never the whole page). Calls `onDone` once
 *  when it reaches zero. */
export function Countdown({ unlock, onDone, doneLabel }: { unlock: number; onDone?: () => void; doneLabel: string }) {
  const calc = () => Math.max(0, unlock - Math.floor(Date.now() / 1000));
  const [left, setLeft] = useState(calc);
  const fired = useRef(false);
  const cb = useRef(onDone);
  cb.current = onDone;

  useEffect(() => {
    fired.current = false;
    setLeft(calc());
    const id = setInterval(() => {
      const l = calc();
      setLeft(l);
      if (l === 0 && !fired.current) { fired.current = true; clearInterval(id); cb.current?.(); }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlock]);

  if (left === 0) return <span className="cd cd-done">{doneLabel}</span>;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  const text = d > 0 ? `${d}d ${p(h)}h ${p(m)}m ${p(s)}s` : `${p(h)}:${p(m)}:${p(s)}`;
  return <span className="cd" role="timer" aria-label={text}>{text}</span>;
}
