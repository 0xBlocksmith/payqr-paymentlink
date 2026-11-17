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
import { USDC_ADDRESS, DIAMOND_ADDRESS } from "./p2p";
import { RPC_URL } from "./chain";

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
  /** Integrator the USDC came from (transfer history only); one tx can sweep several. */
  from?: string | null;
  /** The forward of this withdrawal to an external address, when one was found on-chain. */
  fwdHash?: string | null;
  fwdTo?: string | null;
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

/** A send that timed out before any hash existed is given this long to show up on-chain. */
export const STALE_PROCESSING_MS = 60 * 60 * 1000;
/** How far a chain event may sit from a hashless ledger record's start time to be treated as the same send. */
const ADOPT_WINDOW_S = 30 * 60;

/**
 * Merge ledger + chain into display rows. Pure and deterministic.
 *  - a ledger record and the chain withdrawal with the same step-1 hash are ONE
 *    row (one tx sweeping several terminals has one chain entry per terminal and
 *    is matched by amount)
 *  - a ledger row "processing" whose step 1 is confirmed and which has no
 *    external hop pending is "withdrawn"; a confirmed forward also settles it
 *  - chain-only rows (another device / cleared storage) are "withdrawn", with the
 *    destination when the forward was found on-chain
 *  - a send that timed out before its hash was recorded adopts the matching
 *    chain withdrawal; with none after a complete read and an hour, it "failed"
 */
export function mergeUsdcWithdrawals(
  chain: ChainWithdrawal[], ledger: WdRecord[],
  opts: { scanComplete?: boolean; now?: number } = {},
): WithdrawalRow[] {
  const now = opts.now ?? Date.now();
  const used = new Set<number>();                 // chain indexes already matched
  const match = new Map<string, number>();        // ledger id -> chain index

  // 1. by hash (amount breaks ties inside a multi-terminal sweep)
  for (const r of ledger) {
    if (!r.step1Hash) continue;
    const same = chain.map((c, i) => ({ c, i })).filter(({ c, i }) => !used.has(i) && lc(c.txHash) === lc(r.step1Hash));
    const hit = same.find(({ c }) => c.amount === r.amount) ?? same[0];
    if (hit) { used.add(hit.i); match.set(r.id, hit.i); }
  }
  // 2. hashless "processing" records adopt an unclaimed chain withdrawal of the same amount
  const claimedHashes = new Set(ledger.filter((r) => r.step1Hash).map((r) => lc(r.step1Hash)));
  const adopted = new Set<string>();
  for (const r of [...ledger].sort((a, b) => a.createdAt - b.createdAt)) {
    if (r.step1Hash || r.status !== "processing") continue;
    const start = Math.floor(r.createdAt / 1000);
    const i = chain.findIndex((c, k) => !used.has(k) && !claimedHashes.has(lc(c.txHash)) && c.ts != null
      && c.amount === r.amount && c.ts >= start - 60 && c.ts <= start + ADOPT_WINDOW_S);
    if (i >= 0) { used.add(i); match.set(r.id, i); adopted.add(r.id); }
  }

  const rows: WithdrawalRow[] = [];
  const ids = new Set<string>();
  const uniq = (base: string) => { let id = base, n = 2; while (ids.has(id)) id = `${base}-${n++}`; ids.add(id); return id; };

  for (const r of ledger) {
    const ci = match.get(r.id);
    const c = ci != null ? chain[ci] : undefined;
    const step1 = r.step1Hash || c?.txHash || null;
    const step2 = r.step2Hash || c?.fwdHash || null;
    const destination = r.destination ?? c?.fwdTo ?? null;
    let status = r.status;
    // Never confirmed and no matching chain withdrawal after a complete read: it did not go through.
    if (!step1 && status === "processing" && opts.scanComplete !== false && now - r.createdAt > STALE_PROCESSING_MS) status = "failed";
    if (c && (status === "processing" || status === "partial")) {
      if (!r.destination || c.fwdHash) status = "withdrawn";       // nothing left to forward / forward confirmed
      else if (adopted.has(r.id) && !r.step2Hash) status = "partial"; // landed, never forwarded
    }
    const ts = c?.ts ?? Math.floor(r.createdAt / 1000);
    rows.push({
      orderId: uniq(`usdc-${step1 || r.id}`),
      kind: "usdc_withdraw",
      amount: r.amount,
      status,
      txHash: step1,
      step2Hash: step2,
      destination,
      createdAt: new Date(ts * 1000).toISOString(),
      placedAt: ts,
      integrator: null,
    });
  }

  chain.forEach((c, i) => {
    if (used.has(i)) return;
    const ts = c.ts ?? 0;
    rows.push({
      orderId: uniq(`usdc-${c.txHash}`),
      kind: "usdc_withdraw",
      amount: c.amount,
      status: "withdrawn",
      txHash: c.txHash,
      step2Hash: c.fwdHash ?? null,
      destination: c.fwdTo ?? null,
      createdAt: new Date(ts * 1000).toISOString(),
      placedAt: ts,
      integrator: null,
    });
  });
  return rows.sort((a, b) => b.placedAt - a.placedAt);
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

// ─── Transfer history (Alchemy) ──────────────────────────────────────────
//
// eth_getLogs needs a block range and the app's Alchemy key caps that range, so
// a full history by log scan costs thousands of calls. Alchemy's
// alchemy_getAssetTransfers is indexed by ADDRESS instead: two paged calls on
// the same RPC URL return every USDC transfer into and out of the merchant's
// wallet, with no block range. A withdrawal is USDC moving from one of our
// integrators to the merchant; its forward is the next transfer of the same
// amount out to an external address. Non-Alchemy RPCs fall back to the scan.

/** Thrown when the configured RPC is not an Alchemy endpoint: use fetchChainWithdrawals instead. */
export class TransferHistoryUnsupported extends Error {
  constructor() { super("RPC does not support alchemy_getAssetTransfers"); this.name = "TransferHistoryUnsupported"; }
}

export function transferHistorySupported(url: string | undefined = RPC_URL): boolean {
  return !!url && /\.alchemy(api)?\.(com|io)\//i.test(url);
}

/** A forward is accepted this long after its withdrawal (both txs run back to back from the app). */
const FWD_WINDOW_S = 30 * 60;
const MAX_PAGES = 10;

interface AlchemyTransfer {
  hash: string; from: string; to: string | null; blockNum: string;
  rawContract?: { value?: string | null };
  metadata?: { blockTimestamp?: string };
}

async function assetTransfers(url: string, filter: Record<string, unknown>): Promise<AlchemyTransfer[]> {
  const out: AlchemyTransfer[] = [];
  let pageKey: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers",
        params: [{
          fromBlock: "0x0", toBlock: "latest", category: ["erc20"],
          contractAddresses: [USDC_ADDRESS], withMetadata: true, excludeZeroValue: true,
          order: "desc", maxCount: "0x3e8", ...filter, ...(pageKey ? { pageKey } : {}),
        }],
      }),
    });
    if (!res.ok) throw new Error(`alchemy_getAssetTransfers HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`alchemy_getAssetTransfers: ${body.error.message ?? "error"}`);
    out.push(...(body.result?.transfers ?? []));
    pageKey = body.result?.pageKey;
    if (!pageKey) break;
  }
  return out;
}

const rawOf = (t: AlchemyTransfer) => { try { return BigInt(t.rawContract?.value ?? "0x0").toString(); } catch { return "0"; } };
const tsOf = (t: AlchemyTransfer) => { const ms = Date.parse(t.metadata?.blockTimestamp ?? ""); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };

/**
 * Every USDC withdrawal for `merchant` (merchant = the wallet the integrator pays
 * out to), with its external forward when one exists. Two indexed calls, no
 * block scan. Throws TransferHistoryUnsupported on a non-Alchemy RPC.
 */
export async function fetchTransferHistory(merchant: string, url: string | undefined = RPC_URL): Promise<ChainWithdrawal[]> {
  if (!url || !transferHistorySupported(url)) throw new TransferHistoryUnsupported();
  if (!/^0x[0-9a-fA-F]{40}$/.test(USDC_ADDRESS)) throw new Error("NEXT_PUBLIC_USDC_ADDRESS is not set");
  const contracts = new Set(ALL_CONTRACT_ADDRESSES.map(lc));
  const [ins, outs] = await Promise.all([
    assetTransfers(url, { toAddress: merchant }),
    assetTransfers(url, { fromAddress: merchant }),
  ]);

  const wds: ChainWithdrawal[] = ins
    .filter((t) => contracts.has(lc(t.from)))
    .map((t) => ({
      txHash: t.hash, amount: rawOf(t), blockNumber: String(BigInt(t.blockNum)), ts: tsOf(t),
      from: t.from, fwdHash: null, fwdTo: null,
    }));

  // Forwards: out to an address that is not one of ours (an integrator or the P2P diamond).
  const ours = new Set([...contracts, lc(DIAMOND_ADDRESS), lc(merchant)]);
  const fwds = outs
    .filter((t) => t.to && !ours.has(lc(t.to)))
    .map((t) => ({ hash: t.hash, to: t.to as string, amount: rawOf(t), ts: tsOf(t) }));
  const taken = new Set<number>();
  for (const w of [...wds].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    if (w.ts == null) continue;
    let best = -1;
    fwds.forEach((f, i) => {
      if (taken.has(i) || f.ts == null || f.amount !== w.amount) return;
      if (f.ts < w.ts! || f.ts > w.ts! + FWD_WINDOW_S) return;
      if (best < 0 || (f.ts as number) < (fwds[best].ts as number)) best = i;
    });
    if (best >= 0) { taken.add(best); w.fwdHash = fwds[best].hash; w.fwdTo = fwds[best].to; }
  }
  return wds;
}
