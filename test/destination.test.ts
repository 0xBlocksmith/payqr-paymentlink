import { describe, expect, it } from "vitest";
import { groupAddress, validateDestination } from "../lib/destination";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // checksummed
const WALLET = "0x5B38Da6a701c568545dCfcB03FcB875f56beddC4"; // checksummed
const blocked = { token: USDC, contracts: ["0x1111111111111111111111111111111111111111"] };

describe("validateDestination", () => {
  it("accepts a checksummed address", () => {
    expect(validateDestination(WALLET, blocked).ok).toBe(true);
  });
  it("accepts an all-lowercase address (no checksum to check)", () => {
    expect(validateDestination(WALLET.toLowerCase(), blocked).ok).toBe(true);
  });
  it("trims whitespace", () => {
    expect(validateDestination("  " + WALLET + "\n", blocked).ok).toBe(true);
  });
  it("rejects empty and malformed input", () => {
    expect(validateDestination("", blocked)).toEqual({ ok: false, problem: "empty" });
    expect(validateDestination("0x1234", blocked)).toEqual({ ok: false, problem: "format" });
    expect(validateDestination("hello", blocked)).toEqual({ ok: false, problem: "format" });
  });
  it("rejects a mixed-case address whose checksum is wrong (typo)", () => {
    const bad = WALLET.replace("Da6a", "dA6a");
    expect(bad).not.toBe(WALLET);
    expect(validateDestination(bad, blocked)).toEqual({ ok: false, problem: "checksum" });
  });
  it("blocks the zero address", () => {
    expect(validateDestination("0x0000000000000000000000000000000000000000", blocked))
      .toEqual({ ok: false, problem: "zero" });
  });
  it("blocks the USDC token contract (any case)", () => {
    expect(validateDestination(USDC, blocked)).toEqual({ ok: false, problem: "token" });
    expect(validateDestination(USDC.toLowerCase(), blocked)).toEqual({ ok: false, problem: "token" });
  });
  it("blocks PayQR contract addresses", () => {
    expect(validateDestination("0x1111111111111111111111111111111111111111", blocked))
      .toEqual({ ok: false, problem: "contract" });
  });
});

describe("groupAddress", () => {
  it("shows the whole address in groups of four", () => {
    const g = groupAddress(WALLET);
    expect(g.replace(/\s/g, "")).toBe(WALLET);
    expect(g.split(" ").length).toBe(11); // "0x" + 10 groups of 4
  });
});
