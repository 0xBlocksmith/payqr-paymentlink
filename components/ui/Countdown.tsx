"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

// ONE shared 1-second timer for every countdown on screen (a long history used to
// start one timer per locked row). It runs only while at least one is mounted.
let listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let nowSec = Math.floor(Date.now() / 1000);

function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    nowSec = Math.floor(Date.now() / 1000);
    timer = setInterval(() => {
      nowSec = Math.floor(Date.now() / 1000);
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}
const getNow = () => nowSec;
const getServerNow = () => 0;

/** Live countdown to a unix-seconds timestamp. Calls `onDone` once when it
 *  reaches zero. */
export function Countdown({ unlock, onDone, doneLabel }: { unlock: number; onDone?: () => void; doneLabel: string }) {
  const now = useSyncExternalStore(subscribe, getNow, getServerNow);
  const left = Math.max(0, unlock - (now || Math.floor(Date.now() / 1000)));
  const fired = useRef(false);
  const cb = useRef(onDone);
  cb.current = onDone;

  useEffect(() => { fired.current = false; }, [unlock]);
  useEffect(() => {
    if (left === 0 && now !== 0 && !fired.current) { fired.current = true; cb.current?.(); }
  }, [left, now]);

  if (left === 0) return <span className="cd cd-done">{doneLabel}</span>;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  const text = d > 0 ? `${d}d ${p(h)}h ${p(m)}m ${p(s)}s` : `${p(h)}:${p(m)}:${p(s)}`;
  return <span className="cd" role="timer" aria-label={text}>{text}</span>;
}
