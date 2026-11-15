import { describe, expect, it } from "vitest";
import { createGuard } from "../lib/guard";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createGuard — synchronous duplicate-submission protection", () => {
  it("refuses a second call made in the same tick, and never runs fn twice", async () => {
    const g = createGuard();
    let runs = 0;
    const fn = async () => { runs++; await tick(); return "sent"; };
    const [a, b] = await Promise.all([g.run(fn), g.run(fn)]);
    expect(runs).toBe(1);
    expect(a).toEqual({ ok: true, reason: "ok", value: "sent" });
    expect(b).toEqual({ ok: false, reason: "busy" });
  });

  it("holds the lock WHILE the step-up is open (the old bug: busy was set after it)", async () => {
    const g = createGuard();
    let runs = 0;
    let release!: (v: boolean) => void;
    const stepUp = () => new Promise<boolean>((res) => { release = res; });
    const first = g.run(async () => { runs++; return 1; }, { stepUp });
    const second = await g.run(async () => { runs++; return 2; }, { stepUp });
    expect(second).toEqual({ ok: false, reason: "busy" });
    release(true);
    expect(await first).toEqual({ ok: true, reason: "ok", value: 1 });
    expect(runs).toBe(1);
  });

  it("does not run fn when step-up is declined, and unlocks afterwards", async () => {
    const g = createGuard();
    let runs = 0;
    const r = await g.run(async () => { runs++; }, { stepUp: async () => false });
    expect(r).toEqual({ ok: false, reason: "stepup" });
    expect(runs).toBe(0);
    expect(g.busy).toBe(false);
    expect((await g.run(async () => 7)).ok).toBe(true);
  });

  it("returns the error, unlocks, and does NOT retry", async () => {
    const g = createGuard();
    let runs = 0;
    const boom = new Error("boom");
    const r = await g.run(async () => { runs++; throw boom; });
    expect(r).toEqual({ ok: false, reason: "error", error: boom });
    expect(runs).toBe(1);
    expect(g.busy).toBe(false);
  });
});
