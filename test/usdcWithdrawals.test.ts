import { describe, expect, it } from "vitest";
import { mergeUsdcWithdrawals, ledgerBegin, ledgerUpdate, loadLedger, type ChainWithdrawal, type WdRecord } from "../lib/usdcWithdrawals";

const M = "0xAbC0000000000000000000000000000000000001";
const chain = (txHash: string, ts: number, amount = "25000000"): ChainWithdrawal => ({ txHash, amount, blockNumber: "1", ts });
const rec = (o: Partial<WdRecord>): WdRecord => ({ id: "x", amount: "25000000", destination: null, status: "processing", createdAt: 1_000_000, ...o });

describe("mergeUsdcWithdrawals", () => {
  it("one withdrawal is ONE row even when both chain and ledger know it (no duplicates)", () => {
    const rows = mergeUsdcWithdrawals([chain("0xAA", 2000)], [rec({ id: "a", step1Hash: "0xaa", status: "processing" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("withdrawn"); // confirmed on chain, no external hop pending
  });

  it("matches hashes case-insensitively", () => {
    expect(mergeUsdcWithdrawals([chain("0xABCD", 5)], [rec({ step1Hash: "0xabcd" })])).toHaveLength(1);
  });

  it("shows 'processing' while the chain/indexer has not caught up", () => {
    const rows = mergeUsdcWithdrawals([], [rec({ id: "p", step1Hash: "0xbb", status: "processing" })]);
    expect(rows[0].status).toBe("processing");
  });

  it("a processing row that never got a hash still appears (tab closed mid-send)", () => {
    const rows = mergeUsdcWithdrawals([], [rec({ id: "nohash", status: "processing" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBeNull();
  });

  it("keeps step-2 failure visible even though step 1 is confirmed on chain", () => {
    const rows = mergeUsdcWithdrawals(
      [chain("0xcc", 10)],
      [rec({ step1Hash: "0xcc", destination: "0xDEST", status: "partial" })]
    );
    expect(rows[0].status).toBe("partial");
    expect(rows[0].destination).toBe("0xDEST");
  });

  it("an external withdrawal whose step 2 is unconfirmed stays 'processing' (not claimed as done)", () => {
    const rows = mergeUsdcWithdrawals([chain("0xdd", 10)], [rec({ step1Hash: "0xdd", destination: "0xDEST", status: "processing" })]);
    expect(rows[0].status).toBe("processing");
  });

  it("chain-only withdrawals (another device) appear as withdrawn to own wallet", () => {
    const rows = mergeUsdcWithdrawals([chain("0xee", 99)], []);
    expect(rows[0]).toMatchObject({ status: "withdrawn", destination: null, txHash: "0xee", placedAt: 99 });
  });

  it("is newest-first", () => {
    const rows = mergeUsdcWithdrawals([chain("0x1", 10), chain("0x2", 30), chain("0x3", 20)], []);
    expect(rows.map((r) => r.txHash)).toEqual(["0x2", "0x3", "0x1"]);
  });
});

describe("ledger", () => {
  it("records before sending and updates in place", () => {
    const id = ledgerBegin(M, { amount: "1000000", destination: "0xD" });
    expect(loadLedger(M)).toHaveLength(1);
    expect(loadLedger(M)[0].status).toBe("processing");
    ledgerUpdate(M, id, { step1Hash: "0xh", status: "withdrawn" });
    const [r] = loadLedger(M);
    expect(r).toMatchObject({ id, step1Hash: "0xh", status: "withdrawn" });
    expect(loadLedger(M)).toHaveLength(1);
  });

  it("is scoped per merchant address", () => {
    ledgerBegin(M, { amount: "1", destination: null });
    expect(loadLedger("0xAbC0000000000000000000000000000000000002")).toHaveLength(0);
  });
});

describe("hashless 'processing' ledger rows", () => {
  const t0 = 1_700_000_000_000;
  const rec = { id: "a", amount: "5000000", destination: "0xabc", status: "processing" as const, createdAt: t0 };
  it("adopts a matching chain event instead of showing two rows", () => {
    const chain = [{ txHash: "0xh", amount: "5000000", blockNumber: "1", ts: Math.floor(t0 / 1000) + 20 }];
    const rows = mergeUsdcWithdrawals(chain, [rec], { now: t0 + 5000 });
    expect(rows).toHaveLength(1);
    expect(rows[0].txHash).toBe("0xh");
    expect(rows[0].destination).toBe("0xabc");
  });
  it("marks an unmatched stale row failed after a complete scan, not after an incomplete one", () => {
    expect(mergeUsdcWithdrawals([], [rec], { now: t0 + 2 * 3600_000 })[0].status).toBe("failed");
    expect(mergeUsdcWithdrawals([], [rec], { now: t0 + 2 * 3600_000, scanComplete: false })[0].status).toBe("processing");
    expect(mergeUsdcWithdrawals([], [rec], { now: t0 + 60_000 })[0].status).toBe("processing");
  });
});

describe("fetchChainWithdrawals gap handling", () => {
  const store: Record<string, string> = {};
  (globalThis as any).localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } };
  const mk = (latest: bigint, limit: bigint) => {
    const c: { calls: number; latest: bigint } = { calls: 0, latest };
    return Object.assign(c, {
      getBlockNumber: async () => c.latest,
      getBlock: async () => ({ timestamp: 1n }),
      getContractEvents: async ({ fromBlock, toBlock }: any) => {
        c.calls++;
        if (toBlock - fromBlock + 1n > limit) throw new Error("block range limit exceeded");
        return [];
      },
    });
  };
  it("timer ticks read only new blocks; backfill makes per-contract progress", async () => {
    const { fetchChainWithdrawals, scanIncomplete } = await import("../lib/usdcWithdrawals");
    const m = "0xAbC0000000000000000000000000000000000009";
    const c = mk(5_000_000n, 10n);
    await fetchChainWithdrawals(c, m, { backfill: true });
    expect(scanIncomplete(m)).toBe(true);
    c.latest += 8n; c.calls = 0;
    await fetchChainWithdrawals(c, m, { backfill: false });
    expect(c.calls).toBeLessThanOrEqual(3); // new blocks only, no 60-call backfill
    c.calls = 0;
    await fetchChainWithdrawals(c, m, { backfill: true });
    expect(c.calls).toBeLessThanOrEqual(60);
  });
});
