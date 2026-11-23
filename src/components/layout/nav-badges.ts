/**
 * Pure rules for the sidebar's number badges.
 *
 * A folded group hides its rows and so their badges; the heading carries
 * their sum instead. Only the personal figure counts: the team's unread
 * on the Inbox row is a second, separate badge and is not added in.
 */

/** Sum of the visible rows' badge counts (missing or negative = 0). */
export function sumGroupBadge(
  hrefs: readonly string[],
  countFor: (href: string) => number | null | undefined
): number {
  let total = 0;
  for (const href of hrefs) {
    const n = countFor(href);
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

/**
 * The team's unread as the Inbox row's second badge: only for people
 * with the team view, and only when it says more than the personal badge.
 * For an owner or admin the two are always the same figure, and the pair
 * made the row's label wrap.
 */
export function teamInboxBadgeCount(
  hasTeamView: boolean,
  teamUnread: number,
  personalUnread: number
): number {
  return hasTeamView && teamUnread > personalUnread ? teamUnread : 0;
}
