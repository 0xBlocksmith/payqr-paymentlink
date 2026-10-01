"use client";

import { useCallback, useRef } from "react";
import { sha256 } from "viem";
import { RELAYER_WORKER_URL } from "../lib/paymentLinks";

/**
 * The customer-side half of the relayer's human-cost gate.
 *
 * WHAT THIS REPLACED
 * Cloudflare Turnstile and its widget. The relayer now depends on nothing but
 * Railway and Postgres, so the gate is self-hosted: the server hands out a
 * signed puzzle and we find a nonce whose SHA-256 has enough leading zero bits.
 *
 * WHY THERE IS NO WIDGET ANY MORE
 * Turnstile needed a rendered element, a script from a third party, and a
 * callback. This needs none of them — which removes the class of bug that
 * component kept hitting, where the widget mounted into an element that was not
 * in the DOM yet and silently never produced a token.
 *
 * WHAT THE CUSTOMER EXPERIENCES
 * At difficulty 18 this is about 260k hashes on average. It used to hash with
 * the browser's async SubtleCrypto, one awaited call per try — measured at
 * 0.4–1.3 s on a laptop and several seconds on a budget phone (review M6), on
 * Pay, "I've paid" and Cancel alike. It now hashes synchronously (noble's
 * SHA-256, via viem), about 14x faster, yielding to the page every few
 * thousand tries. Somebody scripting the endpoint still pays it per request.
 *
 * The difficulty comes from the server, so it is CAPPED here: above
 * MAX_DIFFICULTY a phone would grind for a minute or more, so the customer is
 * told the service is busy instead. And a solve that runs past SOLVE_TIMEOUT_MS
 * stops with a message rather than spinning forever.
 */

/** Each extra bit doubles the work: 20 is ~1M tries, a few seconds on a phone. */
const MAX_DIFFICULTY = 20;
const SOLVE_TIMEOUT_MS = 30_000;

/** Leading zero bits of a digest. Mirrors the server's check exactly — a
 *  disagreement here fails as "verification failed" with nothing to point at. */
function leadingZeroBits(digest: Uint8Array): number {
  let bits = 0;
  for (const byte of digest) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export interface HumanSolution {
  challenge: string;
  nonce: string;
}

/**
 * Fetches a challenge and solves it.
 *
 * Returns null when the gate is switched off server-side, which is how local
 * development and the e2e suite run without one. The caller sends nothing in
 * that case and the relayer waves it through.
 */
export async function solveHumanCheck(signal?: AbortSignal): Promise<HumanSolution | null> {
  if (!RELAYER_WORKER_URL) return null;

  const res = await fetch(`${RELAYER_WORKER_URL}/api/challenge`, { signal });
  if (!res.ok) {
    // Fail LOUD rather than sending nothing. Silently omitting the solution
    // would surface later as a 403 on the payment itself, which reads to the
    // customer as "my payment was rejected" rather than "we could not reach
    // the server".
    throw new Error("Could not start the payment. Please try again.");
  }
  const body = (await res.json()) as {
    enabled?: boolean;
    challenge?: string;
    difficulty?: number;
  };
  if (!body.enabled || !body.challenge) return null;

  const difficulty = Number(body.difficulty ?? 18);
  if (!Number.isFinite(difficulty) || difficulty > MAX_DIFFICULTY) {
    throw new Error("Payments are very busy right now. Please try again in a minute.");
  }
  const encoder = new TextEncoder();
  const deadline = Date.now() + SOLVE_TIMEOUT_MS;

  // Hash in short synchronous bursts, yielding between them so the tap that
  // started this keeps the page responsive.
  for (let nonce = 0; ; nonce++) {
    const digest = sha256(encoder.encode(`${body.challenge}.${nonce}`), "bytes");
    if (leadingZeroBits(digest) >= difficulty) {
      return { challenge: body.challenge, nonce: String(nonce) };
    }
    if (nonce % 5000 === 4999) {
      if (signal?.aborted) throw new Error("Cancelled.");
      if (Date.now() > deadline) throw new Error("This is taking longer than usual. Please try again.");
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

/**
 * Hook form, shaped like the `useTurnstile` it replaces so call sites did not
 * have to change: `getSolution()` where they had `getToken()`, and no widget to
 * render.
 *
 * A solution is single-use server-side, so this deliberately does NOT cache one
 * — every call solves fresh. Caching would produce a replay rejection on the
 * second payment, which looks like a broken page rather than a spent token.
 */
export function useHumanCheck() {
  const inFlight = useRef<Promise<HumanSolution | null> | null>(null);

  const getSolution = useCallback(async (): Promise<HumanSolution | null> => {
    // One solve at a time. A double-tap would otherwise burn CPU twice and
    // throw one of the two solutions away.
    if (!inFlight.current) {
      inFlight.current = solveHumanCheck().finally(() => {
        inFlight.current = null;
      });
    }
    return inFlight.current;
  }, []);

  return { getSolution };
}
