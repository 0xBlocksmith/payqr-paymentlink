/**
 * The running Volume Challenge — one place for its goal, reward, window and
 * audience, so the dashboard banner and the /campaign page can't disagree.
 *
 * Venezuela only: the banner and page show for merchants whose country is
 * Venezuela, and only orders charged in Venezuela's currency count.
 */
export const CAMPAIGN = {
  countryId: "venezuela",
  currency: "VEN",
  goalUsdc: 300,
  rewardUsdc: 5,
  // One month, Oct 5 – Nov 4, 2026 inclusive, in the MERCHANT'S LOCAL time:
  // `new Date(y, m, d)` is local midnight, so a shopkeeper's first and last
  // trading days both count in full. The end is exclusive (Nov 5, 00:00).
  start: new Date(2026, 9, 5).getTime(),
  end: new Date(2026, 10, 5).getTime(),
} as const;

/** True while the window is open. After it, the promo would advertise a reward that no longer exists. */
export function campaignActive(now = Date.now()): boolean {
  return now < CAMPAIGN.end;
}

/** Whether this merchant (by their chosen country id) is in the challenge's audience. */
export function campaignEligible(countryId: string | undefined | null): boolean {
  return countryId === CAMPAIGN.countryId;
}
