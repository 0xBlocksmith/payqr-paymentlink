import { describe, expect, it, vi } from "vitest";
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
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
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

describe("transfer history (alchemy_getAssetTransfers)", () => {
  const M2 = "0x00000000000000000000000000000000000000aa";
  const USDC = "0x00000000000000000000000000000000000000cc";
  const ts = (s: number) => new Date(s * 1000).toISOString();
  const tr = (hash: string, from: string, to: string, value: bigint, s: number) =>
    ({ hash, from, to, blockNum: "0x10", rawContract: { value: "0x" + value.toString(16) }, metadata: { blockTimestamp: ts(s) } });

  it("finds withdrawals from our integrators and pairs the forward", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_CONTRACT_ADDRESS", "0x00000000000000000000000000000000000000c1");
    vi.stubEnv("NEXT_PUBLIC_USDC_ADDRESS", USDC);
    const C1 = "0x00000000000000000000000000000000000000c1";
    const ext = "0x00000000000000000000000000000000000000e1";
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: any) => {
      const p = JSON.parse(init.body).params[0];
      calls.push(p);
      const transfers = p.toAddress
        ? [tr("0xw1", C1, M2, 5_000_000n, 1000), tr("0xpay", "0x0000000000000000000000000000000000000077", M2, 9n, 1100), tr("0xw2", C1, M2, 7_000_000n, 2000)]
        : [tr("0xf1", M2, ext, 5_000_000n, 1010)];
      return { ok: true, json: async () => ({ result: { transfers } }) } as any;
    });
    const mod = await import("../lib/usdcWithdrawals");
    const rows = await mod.fetchTransferHistory(M2, "https://base-mainnet.g.alchemy.com/v2/k");
    expect(calls).toHaveLength(2);
    expect(calls[0].fromBlock).toBe("0x0");
    expect(rows.map((r) => r.txHash).sort()).toEqual(["0xw1", "0xw2"]);
    const w1 = rows.find((r) => r.txHash === "0xw1")!;
    expect(w1.fwdTo).toBe(ext);
    expect(rows.find((r) => r.txHash === "0xw2")!.fwdTo).toBeNull();
    const merged = mod.mergeUsdcWithdrawals(rows, []);
    expect(merged.find((r) => r.txHash === "0xw1")!.destination).toBe(ext);
    await expect(mod.fetchTransferHistory(M2, "https://mainnet.base.org")).rejects.toThrow(mod.TransferHistoryUnsupported);
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it("a multi-terminal sweep in one tx stays one row per terminal", () => {
    const chain = [
      { txHash: "0xs", amount: "1", blockNumber: "1", ts: 10 },
      { txHash: "0xs", amount: "2", blockNumber: "1", ts: 10 },
    ];
    const ledger = [
      { id: "a", amount: "1", destination: null, status: "withdrawn" as const, step1Hash: "0xs", createdAt: 1 },
      { id: "b", amount: "2", destination: null, status: "withdrawn" as const, step1Hash: "0xs", createdAt: 1 },
    ];
    const rows = mergeUsdcWithdrawals(chain, ledger);
    expect(rows.map((r) => r.amount).sort()).toEqual(["1", "2"]);
    expect(new Set(rows.map((r) => r.orderId)).size).toBe(2);
  });
});
