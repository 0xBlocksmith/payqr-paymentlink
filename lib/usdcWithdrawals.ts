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
export function mergeUsdcWithdrawals(chain: ChainWithdrawal[], ledger: WdRecord[]): WithdrawalRow[] {
  const rows = new Map<string, WithdrawalRow>();
  const chainBy = new Map(chain.map((c) => [lc(c.txHash), c]));

  for (const r of ledger) {
    const key = r.step1Hash ? lc(r.step1Hash) : `local:${r.id}`;
    const c = r.step1Hash ? chainBy.get(lc(r.step1Hash)) : undefined;
    let status = r.status;
    // On-chain confirmation settles an ambiguous "processing" — but only when
    // there is no second hop still pending.
    if (c && status === "processing" && !r.destination) status = "withdrawn";
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

interface ScanState { lastBlock: string; events: ChainWithdrawal[] }

function loadScan(m: string): ScanState | null {
  try { return JSON.parse(localStorage.getItem(scanKey(m)) || "null"); } catch { return null; }
}
function saveScan(m: string, s: ScanState) {
  try { localStorage.setItem(scanKey(m), JSON.stringify(s)); } catch { /* ignore */ }
}

const isRangeError = (e: any) =>
  /block range|10 block|range should work|limit exceeded|too many blocks|query returned more than|exceed maximum block range|log response size/i
    .test(String(e?.details ?? e?.shortMessage ?? e?.message ?? e));

/**
 * Returns every known `WithdrawalUSDC` for `merchant` across all PayQR
 * contracts. Throws only when the very first chain read fails (so the caller can
 * keep showing the ledger and mark the list as possibly incomplete). A
 * range-limited RPC degrades to a bounded backward scan instead of failing.
 */
export async function fetchChainWithdrawals(publicClient: any, merchant: string): Promise<ChainWithdrawal[]> {
  const prior = loadScan(merchant);
  const latest: bigint = await publicClient.getBlockNumber();
  const floor = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;
  const from0 = prior ? BigInt(prior.lastBlock) + 1n : floor;
  const from = from0 > floor ? from0 : floor;
  if (from > latest) return prior?.events ?? [];

  const found: ChainWithdrawal[] = [];
  let requests = 0;

  const read = async (address: string, fromBlock: bigint, toBlock: bigint) =>
    publicClient.getContractEvents({
      address, abi: INTEGRATOR_ABI, eventName: "WithdrawalUSDC",
      args: { merchant }, fromBlock, toBlock,
    } as any);

  for (const address of ALL_CONTRACT_ADDRESSES) {
    let to = latest;
    let chunk = latest - from + 1n < START_CHUNK ? latest - from + 1n : START_CHUNK;
    while (to >= from && requests < MAX_REQUESTS) {
      const lo = to - chunk + 1n > from ? to - chunk + 1n : from;
      try {
        requests++;
        const evs = await read(address, lo, to);
        for (const e of evs) {
          found.push({
            txHash: e.transactionHash, amount: String(e.args?.amount ?? 0n),
            blockNumber: String(e.blockNumber), ts: null,
          });
        }
        if (lo === from) break;
        to = lo - 1n;
      } catch (err) {
        if (chunk > MIN_CHUNK && isRangeError(err)) { chunk = chunk / 2n > MIN_CHUNK ? chunk / 2n : MIN_CHUNK; continue; }
        // A previous (older) contract may not carry the event — skip it quietly;
        // but a failure on the CURRENT contract must surface.
        if (address !== ALL_CONTRACT_ADDRESSES[0]) break;
        throw err;
      }
    }
  }

  // Timestamps, once per unique block.
  const blocks = [...new Set(found.map((f) => f.blockNumber))];
  const tsBy = new Map<string, number>();
  await Promise.all(blocks.map(async (b) => {
    try {
      const blk = await publicClient.getBlock({ blockNumber: BigInt(b) });
      tsBy.set(b, Number(blk.timestamp));
    } catch { /* leave null → falls back to ledger time */ }
  }));
  for (const f of found) f.ts = tsBy.get(f.blockNumber) ?? null;

  // De-dupe by tx hash across scans (a re-scan after a reload must not double).
  const all = new Map<string, ChainWithdrawal>();
  for (const e of [...(prior?.events ?? []), ...found]) all.set(lc(e.txHash), { ...all.get(lc(e.txHash)), ...e });
  const events = [...all.values()];
  saveScan(merchant, { lastBlock: String(latest), events });
  return events;
}
