/**
 * A payment link whose creation transaction has been (or is about to be)
 * submitted but whose outcome is not yet known.
 *
 * The link id is derived up front (computeLinkId(merchant, salt)), so it can be
 * written down BEFORE the transaction goes out. If the receipt wait then times
 * out or the connection drops, the merchant is not told "failed" — which would
 * invite creating a second link for the same intent — the record is kept and the
 * page checks the chain for that exact link id until it appears.
 *
 * Scoped per wallet. Holds only the id and URL (public by design).
 */
export interface PendingLink {
  linkId: string;
  url: string;
  at: number; // ms
}

const key = (a?: string | null) => `payqr.pendingLink.${String(a || "").toLowerCase()}`;
/** A record older than this is stale: a never-landed batch won't land after a day. */
export const PENDING_LINK_TTL_MS = 24 * 3600 * 1000;

export function savePendingLink(address: string | null | undefined, rec: PendingLink): void {
  if (!address) return;
  try { localStorage.setItem(key(address), JSON.stringify(rec)); } catch { /* storage blocked */ }
}

export function loadPendingLink(address: string | null | undefined, now = Date.now()): PendingLink | null {
  if (!address) return null;
  try {
    const raw = localStorage.getItem(key(address));
    if (!raw) return null;
    const rec = JSON.parse(raw) as PendingLink;
    if (!rec?.linkId || now - (rec.at || 0) > PENDING_LINK_TTL_MS) { localStorage.removeItem(key(address)); return null; }
    return rec;
  } catch { return null; }
}

export function clearPendingLink(address: string | null | undefined): void {
  if (!address) return;
  try { localStorage.removeItem(key(address)); } catch { /* ignore */ }
}
