/**
 * USDC withdrawal history.
 *
 * Why this exists: a USDC withdrawal (`withdrawUSDC`) creates NO order, so the
 * subgraph-backed history never showed it — money left the account and left no
 * trace. Two sources are combined:
 *
 *  1. ON-CHAIN `WithdrawalUSDC(merchant, amount)` events, read incrementally
 *     (a cursor is kept, so a poll only scans new blocks). Authoritative for
 *     "this withdrawal happened", but the event carries no destination and the
 *     external hop (step 2) is a separate ERC-20 transfer.
 *  2. A per-device LEDGER written when the merchant sends. It records the
 *     destination, both transaction hashes and the step state — so it can show
 *     "processing" before the chain/indexer catches up and "in your wallet,
 *     transfer not completed" after a step-2 failure.
 *
 * Both are merged by step-1 transaction hash so one withdrawal is ONE row, never
 * two, however long indexing takes. The ledger never causes a send; it only
 * records. Nothing here retries a write.
 */
import { INTEGRATOR_ABI, ALL_CONTRACT_ADDRESSES } from "./contract";

export type WdStatus = "processing" | "withdrawn" | "partial" | "failed";

export interface WdRecord {
  /** Unique local id (set before any hash exists). */
  id: string;
  amount: string;                 // raw 6-dec USDC
  /** External destination, or null when paid to the merchant's own wallet. */
  destination: string | null;
  status: WdStatus;
  step1Hash?: string;             // withdrawUSDC tx
  step2Hash?: string;             // ERC-20 forward tx (external only)
  createdAt: number;              // ms
}

export interface ChainWithdrawal {
  txHash: string;
  amount: string;                 // raw
  blockNumber: string;
  ts: number | null;              // unix s
}

export interface WithdrawalRow {
  orderId: string;
  kind: "usdc_withdraw";
  amount: string;
  status: WdStatus;
  txHash: string | null;
  step2Hash: string | null;
  destination: string | null;
  createdAt: string;              // ISO
  placedAt: number;               // unix s
  integrator: null;
}

const lc = (s?: string | null) => (s ? s.toLowerCase() : "");

/**
 * Merge ledger + chain into display rows. Pure and deterministic.
 *  - same step-1 hash → one row (chain confirms; ledger supplies destination/step state)
 *  - a ledger row with status "processing" whose step-1 is confirmed on-chain
 *    and which has no external hop is "withdrawn"
 *  - chain-only rows (another device / cleared storage) → "withdrawn" to own wallet
 */
/** A send that timed out before any hash existed is given this long to show up on-chain. */
export const STALE_PROCESSING_MS = 60 * 60 * 1000;
/** How far a chain event may sit from a hashless ledger record's start time to be treated as the same send. */
const ADOPT_WINDOW_S = 30 * 60;

export function mergeUsdcWithdrawals(
  chain: ChainWithdrawal[], ledger: WdRecord[],
  opts: { scanComplete?: boolean; now?: number } = {},
): WithdrawalRow[] {
  const rows = new Map<string, WithdrawalRow>();
  const chainBy = new Map(chain.map((c) => [lc(c.txHash), c]));
  const now = opts.now ?? Date.now();

  // Chain events no ledger record claims by hash: candidates for a send that
  // timed out before its hash was recorded (otherwise it shows as two rows).
  const claimed = new Set(ledger.filter((r) => r.step1Hash).map((r) => lc(r.step1Hash)));
  const free = chain.filter((c) => !claimed.has(lc(c.txHash)) && c.ts != null);
  const adopted = new Map<string, ChainWithdrawal>(); // ledger id -> chain event
  const taken = new Set<string>();
  for (const r of [...ledger].sort((a, b) => a.createdAt - b.createdAt)) {
    if (r.step1Hash || r.status !== "processing") continue;
    const start = Math.floor(r.createdAt / 1000);
    const hit = free.find((c) => !taken.has(lc(c.txHash)) && c.amount === r.amount
      && (c.ts as number) >= start - 60 && (c.ts as number) <= start + ADOPT_WINDOW_S);
    if (hit) { adopted.set(r.id, hit); taken.add(lc(hit.txHash)); }
  }

  for (const r0 of ledger) {
    const hit = adopted.get(r0.id);
    const r = hit ? { ...r0, step1Hash: hit.txHash } : r0;
    const key = r.step1Hash ? lc(r.step1Hash) : `local:${r.id}`;
    const c = r.step1Hash ? chainBy.get(lc(r.step1Hash)) : undefined;
    let status = r.status;
    // Never confirmed and no matching chain event after a full scan: it did not go through.
    if (!r.step1Hash && status === "processing" && opts.scanComplete !== false && now - r.createdAt > STALE_PROCESSING_MS) status = "failed";
    // On-chain confirmation settles an ambiguous "processing" — but only when
    // there is no second hop still pending.
    if (c && status === "processing" && !r.destination) status = "withdrawn";
    // Adopted external send: step 1 landed, no forward was ever recorded, so the USDC sits in the wallet.
    else if (hit && status === "processing" && r.destination && !r.step2Hash) status = "partial";
    const ts = c?.ts ?? Math.floor(r.createdAt / 1000);
    rows.set(key, {
      orderId: `usdc-${r.step1Hash || r.id}`,
      kind: "usdc_withdraw",
      amount: r.amount,
      status,
      txHash: r.step1Hash || null,
      step2Hash: r.step2Hash || null,
      destination: r.destination,
      createdAt: new Date(ts * 1000).toISOString(),
      placedAt: ts,
      integrator: null,
    });
  }

  for (const c of chain) {
    const key = lc(c.txHash);
    if (rows.has(key)) continue;
    const ts = c.ts ?? 0;
    rows.set(key, {
      orderId: `usdc-${c.txHash}`,
      kind: "usdc_withdraw",
      amount: c.amount,
      status: "withdrawn",
      txHash: c.txHash,
      step2Hash: null,
      destination: null,
      createdAt: new Date(ts * 1000).toISOString(),
      placedAt: ts,
      integrator: null,
    });
  }
  return [...rows.values()].sort((a, b) => b.placedAt - a.placedAt);
}

// ─── Ledger (per device, per merchant) ───────────────────────────────────

const ledgerKey = (m: string) => `payqr.wd.${lc(m)}`;
const MAX_RECORDS = 100;

export function loadLedger(merchant?: string | null): WdRecord[] {
  if (!merchant) return [];
  try {
    const raw = JSON.parse(localStorage.getItem(ledgerKey(merchant)) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function saveLedger(merchant: string, list: WdRecord[]) {
  try { localStorage.setItem(ledgerKey(merchant), JSON.stringify(list.slice(0, MAX_RECORDS))); } catch { /* storage full/blocked */ }
}

/** Record a withdrawal BEFORE it is sent, so it is visible even if the tab dies mid-flight. */
export function ledgerBegin(merchant: string, rec: Omit<WdRecord, "id" | "createdAt" | "status">): string {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const list = loadLedger(merchant);
  saveLedger(merchant, [{ ...rec, id, status: "processing", createdAt: Date.now() }, ...list]);
  return id;
}

export function ledgerUpdate(merchant: string, id: string, patch: Partial<WdRecord>) {
  const list = loadLedger(merchant).map((r) => (r.id === id ? { ...r, ...patch } : r));
  saveLedger(merchant, list);
}

/** Drop a record — used when the merchant cancelled before anything was sent. */
export function ledgerRemove(merchant: string, id: string) {
  saveLedger(merchant, loadLedger(merchant).filter((r) => r.id !== id));
}

// ─── On-chain scan (incremental, range-limit tolerant) ───────────────────

const scanKey = (m: string) => `payqr.wdscan.${lc(m)}`;
/** ~70 days on Base (2 s blocks). Older history lives only in the ledger. */
const LOOKBACK_BLOCKS = 3_000_000n;
const START_CHUNK = 1_000_000n;
const MIN_CHUNK = 10n;
const MAX_REQUESTS = 60;

/** A block range of ONE contract that has not been read yet. */
interface Gap { a: string; lo: string; hi: string }

interface ScanState {
  lastBlock: string;
  events: ChainWithdrawal[];
  /** Unread ranges (range-limited RPC / request budget), per contract so progress is kept. Backfilled on open / pull-to-refresh. */
  gaps?: Gap[];
  /** Largest log range the RPC accepted last time; the next scan starts there instead of re-halving. */
  chunk?: string;
}

function loadScan(m: string): ScanState | null {
  try {
    const st = JSON.parse(localStorage.getItem(scanKey(m)) || "null");
    // Older builds stored gaps as [lo, hi] pairs without a contract: drop them, a fresh lookback is cheap to redo.
    if (st && Array.isArray(st.gaps)) st.gaps = st.gaps.filter((g: any) => g && typeof g === "object" && !Array.isArray(g) && g.a);
    return st;
  } catch { return null; }
}
function saveScan(m: string, s: ScanState) {
  try { localStorage.setItem(scanKey(m), JSON.stringify(s)); } catch { /* ignore */ }
}

/** True when the last scan left block ranges unread, so the list may be missing withdrawals. */
export function scanIncomplete(merchant?: string | null): boolean {
  if (!merchant) return false;
  return (loadScan(merchant)?.gaps?.length ?? 0) > 0;
}

const isRangeError = (e: any) =>
  /block range|10 block|range should work|limit exceeded|too many blocks|query returned more than|exceed maximum block range|log response size/i
    .test(String(e?.details ?? e?.shortMessage ?? e?.message ?? e));

/**
 * Returns every known `WithdrawalUSDC` for `merchant` across all PayQR
 * contracts. Throws only when the very first chain read fails (so the caller can
 * keep showing the ledger and mark the list as possibly incomplete). A
 * range-limited RPC degrades to a bounded newest-first scan; what could not be
 * read is remembered PER CONTRACT as a gap.
 *
 * `backfill` (page open / pull-to-refresh) also works on the stored gaps. The
 * 15-second timer passes false and reads only new blocks, so a range-limited
 * key is not hit with a full request budget on every tick.
 */
export async function fetchChainWithdrawals(
  publicClient: any, merchant: string, opts: { backfill?: boolean } = {},
): Promise<ChainWithdrawal[]> {
  const prior = loadScan(merchant);
  const latest: bigint = await publicClient.getBlockNumber();
  const floor = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
  const from0 = prior ? BigInt(prior.lastBlock) + 1n : floor;
  const from = from0 > floor ? from0 : floor;

  const keptGaps: Gap[] = [];          // gaps not worked on this call
  const work: { a: string; lo: bigint; hi: bigint }[] = [];
  if (from <= latest) for (const a of ALL_CONTRACT_ADDRESSES) work.push({ a, lo: from, hi: latest });
  for (const g of prior?.gaps ?? []) {
    const lo = BigInt(g.lo) > floor ? BigInt(g.lo) : floor;
    const hi = BigInt(g.hi);
    if (lo > hi) continue;
    if (opts.backfill) work.push({ a: g.a, lo, hi }); else keptGaps.push({ a: g.a, lo: String(lo), hi: String(hi) });
  }
  if (!work.length) return prior?.events ?? [];
  // newest ranges first; the new-blocks range of the current contract leads
  work.sort((x, y) => (x.hi === y.hi ? 0 : x.hi > y.hi ? -1 : 1));

  const found: ChainWithdrawal[] = [];
  const budget = { left: MAX_REQUESTS };
  let chunk0 = prior?.chunk ? BigInt(prior.chunk) : START_CHUNK;
  if (chunk0 < MIN_CHUNK) chunk0 = MIN_CHUNK;
  let learned = chunk0;

  const read = async (address: string, fromBlock: bigint, toBlock: bigint) =>
    publicClient.getContractEvents({
      address, abi: INTEGRATOR_ABI, eventName: "WithdrawalUSDC",
      args: { merchant }, fromBlock, toBlock,
    } as any);

  /** Reads [lo0, hi] newest-first. Returns the highest block NOT read (budget ran out), or null when done. */
  const scan = async (address: string, lo0: bigint, hi: bigint): Promise<bigint | null> => {
    let to = hi;
    let chunk = learned < hi - lo0 + 1n ? learned : hi - lo0 + 1n;
    while (to >= lo0) {
      if (budget.left <= 0) return to;
      const lo = to - chunk + 1n > lo0 ? to - chunk + 1n : lo0;
      try {
        budget.left--;
        const evs = await read(address, lo, to);
        for (const e of evs) {
          found.push({
            txHash: e.transactionHash, amount: String(e.args?.amount ?? 0n),
            blockNumber: String(e.blockNumber), ts: null,
          });
        }
        if (lo === lo0) break;
        to = lo - 1n;
      } catch (err) {
        if (chunk > MIN_CHUNK && isRangeError(err)) {
          chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK;
          if (chunk < learned) learned = chunk;
          continue;
        }
        // A previous (older) contract may not carry the event: skip it quietly;
        // but a failure on the CURRENT contract must surface.
        if (address !== ALL_CONTRACT_ADDRESSES[0]) return null;
        throw err;
      }
    }
    return null;
  };

  const gaps: Gap[] = [...keptGaps];
  for (const w of work) {
    const rem = await scan(w.a, w.lo, w.hi);
    if (rem !== null) gaps.push({ a: w.a, lo: String(w.lo), hi: String(rem) });
  }
  // Bound the stored list: more than 3 gaps for one contract collapse into their span.
  const merged: Gap[] = [];
  for (const a of new Set(gaps.map((g) => g.a))) {
    const mine = gaps.filter((g) => g.a === a);
    if (mine.length <= 3) { merged.push(...mine); continue; }
    const lo = mine.reduce((m, g) => (BigInt(g.lo) < m ? BigInt(g.lo) : m), BigInt(mine[0].lo));
    const hi = mine.reduce((m, g) => (BigInt(g.hi) > m ? BigInt(g.hi) : m), BigInt(mine[0].hi));
    merged.push({ a, lo: String(lo), hi: String(hi) });
  }

  // Timestamps, once per unique block.
  const blocks = [...new Set(found.map((f) => f.blockNumber))];
  const tsBy = new Map<string, number>();
  await Promise.all(blocks.map(async (b) => {
    try {
      const blk = await publicClient.getBlock({ blockNumber: BigInt(b) });
      tsBy.set(b, Number(blk.timestamp));
    } catch { /* leave null -> falls back to ledger time */ }
  }));
  for (const f of found) f.ts = tsBy.get(f.blockNumber) ?? null;

  // De-dupe by tx hash across scans (a re-scan after a reload must not double).
  const all = new Map<string, ChainWithdrawal>();
  for (const e of [...(prior?.events ?? []), ...found]) all.set(lc(e.txHash), { ...all.get(lc(e.txHash)), ...e });
  const events = [...all.values()];
  const lastBlock = from <= latest ? latest : BigInt(prior!.lastBlock);
  saveScan(merchant, { lastBlock: String(lastBlock), events, gaps: merged, chunk: String(learned) });
  return events;
}
