/**
 * The text of the top bar's unread badge: null hides it (nothing
 * unread), and anything above 99 is "99+" so the pill keeps its width.
 */
export function notificationBadgeLabel(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > 99 ? '99+' : String(Math.floor(unread));
}
