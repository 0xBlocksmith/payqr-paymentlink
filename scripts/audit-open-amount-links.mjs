#!/usr/bin/env node
/**
 * List the payment links that are still PAY-ANYTHING, so they can be revoked
 * (review item 2).
 *
 * WHY
 * Links made in the short-lived version that carried the price in the query
 * string (?fa=&fs=) are open-amount ON-CHAIN, and the relayer never stored a
 * price for them. The pay page refuses them while ?fa is in the URL — but
 * strip it and the link opens as a Counter QR that takes any amount. The
 * review's remedy is to revoke them before launch, and the thing that blocked
 * it was being unable to list them: public Base RPCs refuse historical
 * getLogs. This is that listing, off a keyed RPC.
 *
 * WHICH CONTRACT: THE INTEGRATOR, NOT THE LinkRouter
 * Links live on the integrator — `LinkCreated`, `LinkRevoked`, `getLink` and
 * `revokeLink` are all its (INTEGRATOR_ABI in lib/contract.ts). The LinkRouter
 * has none of them: it emits AgentRegistered/OrderPlaced/… and reads links
 * back through `integrator.getLink`. Pointed at the Router, the first version
 * of this script found zero links and reported "nothing to revoke" — the worst
 * answer a check like this can give. So it now
 *   • verifies the target actually answers `getLink` before scanning, and
 *   • treats "no LinkCreated events at all" as a failure, not an all-clear.
 * Both exit non-zero.
 *
 * WHAT IT PRINTS
 * Every link that is live (not revoked, not expired, uses left), open-amount
 * on-chain, and has no price at the relayer. That set is exactly "a stranger
 * with this URL chooses what to pay" — the genuinely-intended Counter QRs are
 * in it too, so READ THE LIST before revoking: it is a worksheet, not a
 * script. It changes nothing on-chain and needs no key.
 *
 * USE
 *   RPC_URL=https://base-mainnet.<keyed-provider>/...
 *   INTEGRATOR_ADDRESS=0xA012B6D5D6d74224C3B046780965D5EC7AAB20a5
 *   RELAYER_URL=https://<relayer>/
 *   FROM_BLOCK=<the block the integrator was deployed in>
 *   node scripts/audit-open-amount-links.mjs [--json]
 *
 * Optional: TO_BLOCK (default: latest), CHUNK (default 10000 blocks per
 * getLogs — raise it on a provider that allows wider ranges), OWNER (only
 * this merchant's links).
 */
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { base } from "viem/chains";

/** Base mainnet's integrator, named in the error messages so the fix is obvious. */
const MAINNET_INTEGRATOR = "0xA012B6D5D6d74224C3B046780965D5EC7AAB20a5";

const need = (k) => {
  const v = (process.env[k] ?? "").trim();
  if (!v) {
    console.error(`Missing ${k}. See the comment at the top of this file.`);
    process.exit(2);
  }
  return v;
};

const RPC_URL = need("RPC_URL");
// A pointed message rather than a bare "Missing INTEGRATOR_ADDRESS": the
// Router is the plausible wrong answer, and the one that used to fail quietly.
if (!process.env.INTEGRATOR_ADDRESS && process.env.LINK_ROUTER_ADDRESS) {
  console.error(
    "Links live on the INTEGRATOR, not the LinkRouter — the Router has no LinkCreated, " +
      `getLink or revokeLink. Set INTEGRATOR_ADDRESS instead (Base mainnet: ${MAINNET_INTEGRATOR}).`
  );
  process.exit(2);
}
const INTEGRATOR = getAddress(need("INTEGRATOR_ADDRESS"));
const RELAYER_URL = need("RELAYER_URL").replace(/\/+$/, "");
const FROM_BLOCK = BigInt(need("FROM_BLOCK"));
const CHUNK = BigInt(process.env.CHUNK || 10_000);
const OWNER = process.env.OWNER ? getAddress(process.env.OWNER).toLowerCase() : null;
const AS_JSON = process.argv.includes("--json");

const ABI = parseAbi([
  // What getLink reverts with for an id that does not exist. Decoding it is
  // how the preflight tells "right contract, unknown link" apart from "this
  // contract has no getLink at all".
  "error LinkNotFound()",
  "event LinkCreated(bytes32 indexed linkId, address indexed owner, uint96 amount, bytes32 currency, uint64 expiresAt, uint32 maxUses, bytes encryptedConfig)",
  "event LinkRevoked(bytes32 indexed linkId, address indexed revokedBy)",
  "function getLink(bytes32 linkId) view returns (address owner, uint96 amount, bytes32 currency, uint64 expiresAt, uint32 maxUses, uint8 status, uint32 uses, uint16 strikes)",
]);
const EVENT = (name) => ABI.find((a) => a.type === "event" && a.name === name);

const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

/** bytes32 → "INR", the way the app reads a link's currency. */
function currencyOf(b32) {
  const hex = b32.slice(2).replace(/(00)+$/, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out || "(none)";
}

/**
 * Refuse to scan an address that cannot answer `getLink`. A wrong address has
 * to fail loudly: an empty list from the wrong contract reads as "all clear".
 */
async function preflight() {
  const code = await client.getCode({ address: INTEGRATOR }).catch(() => undefined);
  if (!code || code === "0x") {
    console.error(`${INTEGRATOR} has no contract code on Base mainnet. Check INTEGRATOR_ADDRESS.`);
    process.exit(2);
  }
  const unknownId = `0x${"00".repeat(32)}`;
  try {
    await client.readContract({ address: INTEGRATOR, abi: ABI, functionName: "getLink", args: [unknownId] });
    return; // it answered even for the zero id: certainly the right contract
  } catch (err) {
    // LinkNotFound is the right contract saying "no such link". Anything else
    // — no matching selector, a decode failure — means this is not it.
    const text = `${err?.shortMessage ?? ""} ${err?.message ?? ""}`;
    if (/LinkNotFound/.test(text)) return;
    console.error(
      `${INTEGRATOR} did not answer getLink(bytes32). This script reads links from the INTEGRATOR, ` +
        `not the LinkRouter (Base mainnet: ${MAINNET_INTEGRATOR}).\n` +
        `The chain said: ${err?.shortMessage ?? err?.message ?? err}`
    );
    process.exit(2);
  }
}

/** getLogs in ranges a keyed provider will actually serve. */
async function scan(event, fromBlock, toBlock) {
  const found = [];
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n > toBlock ? toBlock : from + CHUNK - 1n;
    process.stderr.write(`\r  ${event.name}: blocks ${from}–${to}…   `);
    found.push(...(await client.getLogs({ address: INTEGRATOR, event, fromBlock: from, toBlock: to })));
  }
  process.stderr.write("\r".padEnd(60) + "\r");
  return found;
}

/** Does the relayer hold a price for this link? A 404 means it does not. */
async function hasStoredPrice(linkId) {
  const res = await fetch(`${RELAYER_URL}/api/links/${linkId}/price`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`relayer answered ${res.status} for ${linkId}`);
  const body = await res.json();
  return typeof body?.amount6 === "string";
}

async function main() {
  // A relayer that cannot hold prices answers 404 to every link, which would
  // report every link as pay-anything. Refuse rather than print that.
  const health = await fetch(`${RELAYER_URL}/health`).then((r) => r.json());
  if (!Array.isArray(health?.features) || !health.features.includes("fixed-price")) {
    console.error(
      `${RELAYER_URL} does not report the "fixed-price" feature, so it cannot say which links have a price.\n` +
        "Point RELAYER_URL at the deployed payer-relayer that does."
    );
    process.exit(2);
  }

  await preflight();

  const latest = await client.getBlockNumber();
  const toBlock = process.env.TO_BLOCK ? BigInt(process.env.TO_BLOCK) : latest;
  console.error(`Scanning ${INTEGRATOR} for links, blocks ${FROM_BLOCK}–${toBlock}…`);

  const created = await scan(EVENT("LinkCreated"), FROM_BLOCK, toBlock);
  // Zero links across the whole range is not an all-clear: it is a wrong
  // address, a wrong FROM_BLOCK, or an RPC quietly dropping ranges.
  if (created.length === 0) {
    console.error(
      `No LinkCreated events at all between blocks ${FROM_BLOCK} and ${toBlock}. That is not "no links" — ` +
        "check INTEGRATOR_ADDRESS and FROM_BLOCK, and that this RPC serves historical getLogs."
    );
    process.exit(1);
  }
  const revoked = new Set(
    (await scan(EVENT("LinkRevoked"), FROM_BLOCK, toBlock)).map((l) => l.args.linkId.toLowerCase())
  );

  const now = BigInt(Math.floor(Date.now() / 1000));
  const candidates = created.filter(
    (l) =>
      l.args.amount === 0n && // open-amount on-chain
      !revoked.has(l.args.linkId.toLowerCase()) &&
      (!OWNER || l.args.owner.toLowerCase() === OWNER)
  );
  console.error(`${created.length} links created, ${candidates.length} open-amount and not revoked. Checking each…`);

  const open = [];
  for (const [i, log] of candidates.entries()) {
    process.stderr.write(`\r  ${i + 1}/${candidates.length}   `);
    const linkId = log.args.linkId;
    // Current on-chain state, not the state at creation: the link may have
    // expired or used up its uses since.
    const [owner, amount, currency, expiresAt, maxUses, status, uses] = await client.readContract({
      address: INTEGRATOR,
      abi: ABI,
      functionName: "getLink",
      args: [linkId],
    });
    const live = status === 0 && (expiresAt === 0n || expiresAt > now) && (maxUses === 0 || uses < maxUses);
    if (!live || amount !== 0n) continue;
    if (await hasStoredPrice(linkId)) continue; // the relayer charges a fixed price: safe
    open.push({
      linkId,
      owner,
      currency: currencyOf(currency),
      expiresAt: expiresAt === 0n ? "never" : new Date(Number(expiresAt) * 1000).toISOString(),
      usesLeft: maxUses === 0 ? "unlimited" : maxUses - uses,
      createdInBlock: Number(log.blockNumber),
    });
  }
  process.stderr.write("\r".padEnd(40) + "\r");

  if (AS_JSON) {
    console.log(JSON.stringify(open, null, 2));
  } else if (open.length === 0) {
    console.log(`No live pay-anything links among the ${created.length} links found. Nothing to revoke.`);
  } else {
    console.log(`\n${open.length} live link(s) that accept ANY amount — review, then revokeLink each:\n`);
    console.table(open);
    console.log("\nrevokeLink(bytes32) on the INTEGRATOR, from each link's owner.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
