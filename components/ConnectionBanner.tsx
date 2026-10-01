"use client";

import { useEffect, useState } from "react";
import { SUBGRAPH_URL } from "../lib/p2p";
import { ACTIVE_CHAIN, RPC_URL } from "../lib/chain";

/**
 * Shows a slim banner when the device is offline or the subgraph (which powers
 * history + live rate) is unreachable — so the app never silently looks broken.
 */
export function ConnectionBanner() {
  const [offline, setOffline] = useState(false);
  const [subDown, setSubDown] = useState(false);
  // The RPC answering for a DIFFERENT chain than the app is built for — e.g. a
  // leftover Sepolia RPC URL on a mainnet build. Reads would then come from one
  // chain while wallet writes go to another, and nothing else would say so.
  const [wrongChain, setWrongChain] = useState<number | null>(null);

  useEffect(() => {
    if (!RPC_URL) return;
    let alive = true;
    fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    })
      .then((r) => r.json())
      .then((j) => {
        const id = typeof j?.result === "string" ? parseInt(j.result, 16) : NaN;
        if (!alive || !Number.isFinite(id) || id === ACTIVE_CHAIN.id) return;
        console.error(`[payqr] RPC is on chain ${id}; this build expects ${ACTIVE_CHAIN.id}`);
        setWrongChain(id);
      })
      .catch(() => undefined); // unreachable RPC is the offline/delayed case, not this one
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    if (typeof navigator !== "undefined") setOffline(!navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(() => {
    // No subgraph configured: nothing to probe (fetch("") would request this page).
    if (!SUBGRAPH_URL) return;
    let alive = true;
    async function check() {
      try {
        const res = await fetch(SUBGRAPH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
        });
        const j = await res.json();
        if (alive) setSubDown(!j?.data?._meta);
      } catch {
        if (alive) setSubDown(true);
      }
    }
    check();
    const t = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (wrongChain !== null) {
    return (
      <div className="conn-banner">
        Configuration problem: the network connection is for a different chain ({wrongChain}) than this app ({ACTIVE_CHAIN.id}). Please contact support.
      </div>
    );
  }
  if (!offline && !subDown) return null;

  return (
    <div className={`conn-banner${offline ? "" : " reconnecting"}`}>
      {offline
        ? "You're offline — changes will sync when you reconnect."
        : "Live data is delayed — reconnecting to the network…"}
    </div>
  );
}
