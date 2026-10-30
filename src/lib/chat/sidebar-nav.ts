/**
 * The sidebar's open row, moved the moment a row is clicked instead of
 * when the route lands (a round trip later on a tunnelled install).
 */
export interface PendingChannelNav {
  /** The row clicked. */
  channelId: string;
  /** The route's channel when it was clicked (null off a channel). */
  routeAtClick: string | null;
}

/** The click is settled once the route has moved off where it was. */
export function isNavSettled(
  pending: PendingChannelNav | null,
  routeChannelId: string | null
): boolean {
  return pending !== null && routeChannelId !== pending.routeAtClick;
}

/** The row to highlight: the clicked one until the route moves, then the route's. */
export function optimisticActiveId(
  pending: PendingChannelNav | null,
  routeChannelId: string | null
): string | null {
  if (pending && !isNavSettled(pending, routeChannelId))
    return pending.channelId;
  return routeChannelId;
}
