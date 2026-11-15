/**
 * Validation for an EXTERNAL USDC withdrawal destination. The old check was a
 * bare `^0x[0-9a-fA-F]{40}$` regex, which accepts a mistyped mixed-case address
 * (checksum ignored), the zero address, and the USDC token contract itself —
 * every one of which burns the funds.
 */
import { isAddress } from "viem";
import { CONTRACT_ADDRESS, PREV_CONTRACT_ADDRESSES } from "./contract";
import { USDC_ADDRESS } from "./p2p";

export type DestinationProblem = "empty" | "format" | "checksum" | "zero" | "token" | "contract";

const ZERO = "0x0000000000000000000000000000000000000000";

export function validateDestination(
  raw: string,
  /** Overridable for tests. */
  blocked: { token?: string; contracts?: string[] } = {}
): { ok: true; address: `0x${string}` } | { ok: false; problem: DestinationProblem } {
  const addr = (raw || "").trim();
  if (!addr) return { ok: false, problem: "empty" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return { ok: false, problem: "format" };
  // viem's strict mode enforces the EIP-55 checksum when the address is
  // mixed-case (an all-lower or all-upper address carries no checksum).
  if (!isAddress(addr, { strict: true })) return { ok: false, problem: "checksum" };
  const lower = addr.toLowerCase();
  if (lower === ZERO) return { ok: false, problem: "zero" };
  const token = (blocked.token ?? USDC_ADDRESS ?? "").toLowerCase();
  if (token && lower === token) return { ok: false, problem: "token" };
  const contracts = (blocked.contracts ?? [CONTRACT_ADDRESS, ...(PREV_CONTRACT_ADDRESSES ?? [])])
    .filter(Boolean)
    .map((c) => String(c).toLowerCase());
  if (contracts.includes(lower)) return { ok: false, problem: "contract" };
  return { ok: true, address: addr as `0x${string}` };
}

/** i18n key for each problem (see lib/i18n.stage.ts). */
export const DESTINATION_PROBLEM_KEY: Record<DestinationProblem, string> = {
  empty: "dest.empty",
  format: "dest.format",
  checksum: "dest.checksum",
  zero: "dest.zero",
  token: "dest.token",
  contract: "dest.contract",
};

/** The full address in groups of four, so a user can actually compare it. */
export function groupAddress(addr: string): string {
  const a = (addr || "").replace(/^0x/i, "");
  return "0x " + (a.match(/.{1,4}/g) ?? []).join(" ");
}
