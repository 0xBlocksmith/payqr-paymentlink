import { describe, it, expect } from "vitest";
import { deriveLadderState } from "../lib/disputeLadder";

const now = 1000;
describe("deriveLadderState", () => {
  it("none when no dispute", () => expect(deriveLadderState(0, 0, 0, 0, 0, now).kind).toBe("none"));
  it("awaiting before the SLA", () => expect(deriveLadderState(1, 2000, 0, 0, 0, now).kind).toBe("awaiting"));
  it("appeal after the SLA lapses", () => expect(deriveLadderState(1, 900, 0, 0, 0, now).kind).toBe("appeal-sla"));
  it("tier 3 is never appealable", () => expect(deriveLadderState(3, 0, 0, 0, 0, now).kind).toBe("awaiting"));
  it("USER-fault decision is appealable inside the window", () =>
    expect(deriveLadderState(1, 0, 1, 1, 2000, now)).toEqual({ kind: "appeal-window", tier: 1, until: 2000 }));
  it("finalize once the window ends", () =>
    expect(deriveLadderState(2, 0, 1, 2, 900, now)).toEqual({ kind: "finalize", tier: 2 }));
});
