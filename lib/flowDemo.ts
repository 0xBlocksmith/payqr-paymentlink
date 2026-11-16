/**
 * Timeline for the ILLUSTRATIVE payment-journey animation on /login.
 *
 * This is a pure function of time: it only describes where the demo's tokens are
 * at second `t`. It is not connected to any transaction, wallet, contract or
 * balance, and nothing it produces is ever sent anywhere.
 *
 *   0.0 – 0.6   a local payment fades in at the left
 *   0.6 – 2.4   it travels along the track into the smart contract
 *   2.4 – 2.8   the contract absorbs it
 *   2.8 – 6.8   the settlement countdown runs (accelerated for the demo)
 *   6.8 – 7.2   the countdown reaches zero: the contract unlocks
 *   7.2 – 9.0   USDC travels out to the recipient
 *   9.0 – 10.2  the recipient confirms (a soft pulse)
 *   10.2 – 10.5 rest, then the loop restarts
 */
export const FLOW_T = 10.5;

export interface FlowFrame {
  /** 0..1 progress of the local payment along the LEFT half of the track. */
  payP: number;
  payOpacity: number;
  payScale: number;
  /** 1 → 0: the fraction of the settlement period still remaining. */
  remaining: number;
  unlocked: boolean;
  /** 0..1 progress of USDC along the RIGHT half of the track. */
  coinP: number;
  coinOpacity: number;
  /** 0..1 pulse at the recipient on arrival. */
  arrive: number;
  /** 0..1 how lit the contract is. */
  glow: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeInOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
/** A 0→1→0 bump across [a, b]. */
const bump = (t: number, a: number, b: number) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));

export function flowFrame(tSec: number): FlowFrame {
  const t = ((tSec % FLOW_T) + FLOW_T) % FLOW_T;
  const payOpacity = t < 0.6 ? clamp01(t / 0.4) : t < 2.4 ? 1 : t < 2.8 ? 1 - (t - 2.4) / 0.4 : 0;
  const payScale = t >= 2.4 && t < 2.8 ? 1 - 0.5 * ((t - 2.4) / 0.4) : 1;
  const remaining = t < 2.8 ? 1 : t < 6.8 ? 1 - (t - 2.8) / 4 : 0;
  const coinOpacity = t < 7.0 ? 0 : t < 7.2 ? (t - 7.0) / 0.2 : t < 9.0 ? 1 : t < 9.4 ? 1 - (t - 9.0) / 0.4 : 0;
  const counting = t >= 2.8 && t < 6.8;
  const glow = clamp01(Math.max(counting ? 0.4 : 0.15, bump(t, 2.2, 3.2), bump(t, 6.6, 7.6)));
  return {
    payP: easeInOut(clamp01((t - 0.6) / 1.8)),
    payOpacity,
    payScale,
    remaining,
    unlocked: t >= 6.8,
    coinP: easeInOut(clamp01((t - 7.2) / 1.8)),
    coinOpacity,
    arrive: bump(t, 9.0, 10.2),
    glow,
  };
}

/** What to show when the user prefers reduced motion: a still, readable frame. */
export const FLOW_STILL: FlowFrame = {
  payP: 0, payOpacity: 0, payScale: 1, remaining: 1, unlocked: false,
  coinP: 0, coinOpacity: 0, arrive: 0, glow: 0.3,
};
