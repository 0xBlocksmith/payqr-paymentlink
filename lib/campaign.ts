/**
 * The running Volume Challenge — one place for its goal, reward, window and
 * audience, so the dashboard banner and the /campaign page can't disagree.
 *
 * One campaign per country (Venezuela, Argentina): the banner and page show
 * for merchants in that country, and only orders charged in that country's
 * currency count.
 */
export interface Campaign {
  countryId: string;
  currency: string;
  goalUsdc: number;
  rewardUsdc: number;
  /** Inclusive first day, local midnight. */
  start: number;
  /** Exclusive end (00:00 the day after the last day). */
  end: number;
}

// Windows are in the MERCHANT'S LOCAL time: `new Date(y, m, d)` is local
// midnight, so a shopkeeper's first and last trading days both count in full.
export const CAMPAIGNS: Campaign[] = [
  {
    // Oct 5 – Nov 4, 2026 inclusive.
    countryId: "venezuela",
    currency: "VEN",
    goalUsdc: 300,
    rewardUsdc: 5,
    start: new Date(2026, 9, 5).getTime(),
    end: new Date(2026, 10, 5).getTime(),
  },
  {
    // Oct 16 – Oct 31, 2026 inclusive (launch day to month end).
    countryId: "argentina",
    currency: "ARS",
    goalUsdc: 500,
    rewardUsdc: 5,
    start: new Date(2026, 9, 16).getTime(),
    end: new Date(2026, 10, 1).getTime(),
  },
];

/** The campaign for this merchant's country, if any. */
export function campaignFor(countryId: string | undefined | null): Campaign | undefined {
  return CAMPAIGNS.find((c) => c.countryId === countryId);
}

/** True while the window is open. After it, the promo would advertise a reward that no longer exists. */
export function campaignActive(c: Campaign | undefined, now = Date.now()): boolean {
  return !!c && now < c.end;
}

/** Localised "Oct 5 – Nov 4" (optionally with the year) for a campaign's inclusive window. */
export function campaignRange(c: Campaign, locale: string, withYear = false): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}) };
  const fmt = (ms: number) => new Date(ms).toLocaleDateString(locale, opts);
  return `${fmt(c.start)} – ${fmt(c.end - 1)}`;
}
