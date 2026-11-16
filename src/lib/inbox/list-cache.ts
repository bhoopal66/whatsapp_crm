// ============================================================
// The Inbox list in the session cache (lib/session-cache.ts): one
// entry per list view, shown at once on a revisit and always
// revalidated by the list.
//
// The key names every input of the server query (the view, the scope,
// every pushed-down filter). Search, the company filter, the
// Important / Pinned chips and the sort are applied client-side on
// top of whatever rows are held, so they are not part of the question:
// the same rows answer every one of them.
// ============================================================

import { sessionCache, sessionKey, type SessionKey } from '@/lib/session-cache';
import type { AssigneeFilter } from '@/lib/inbox/conversations';
import type { ConversationCursor } from '@/lib/inbox/pagination';
import type { HrListFilters } from '@/lib/hr/list-filters';

/** Everything the list's server query depends on, plus its view. */
export interface InboxListQuestion {
  /** /team-inbox (true) or /inbox (false). */
  teamView: boolean;
  campaignOnly: boolean;
  aiLive: boolean;
  /** The personal inbox's narrowing to one person, or null. */
  restrictToUserId: string | null;
  restrictToChannelIds: readonly string[];
  restrictToConversationIds: readonly string[];
  status: 'all' | 'unread';
  chatTagIds: readonly string[];
  assignee: AssigneeFilter;
  campaignId: string | null;
  insightFilters: readonly string[];
  /** A department inbox (migration 192, e.g. /hr-inbox); null/absent: main. */
  department?: string | null;
  /** The HR inbox's filters (lib/hr/list-filters.ts); absent elsewhere. */
  hrFilters?: HrListFilters | null;
}

/** What a list view holds: every loaded row and where the next page starts. */
export interface InboxListSnapshot<Row> {
  rows: Row[];
  cursor: ConversationCursor | null;
}

const sorted = (ids: readonly string[]) => [...ids].sort();

/**
 * The question part of the key. Id lists are order-free (sorted), and
 * the whole thing is JSON so no value can run into the next one.
 */
export function inboxListQuestion(q: InboxListQuestion): string {
  const parts: unknown[] = [
    q.teamView ? 'team' : 'personal',
    q.campaignOnly ? 'campaign' : 'inbox',
    q.aiLive,
    q.restrictToUserId,
    sorted(q.restrictToChannelIds),
    sorted(q.restrictToConversationIds),
    q.status,
    sorted(q.chatTagIds),
    q.assignee,
    q.campaignId,
    sorted(q.insightFilters),
    q.department ?? null,
  ];
  // Only the HR inbox carries filters, so every other key is unchanged.
  const hr = q.hrFilters;
  if (hr) {
    parts.push([
      'hr',
      hr.tab,
      hr.stage,
      hr.topic,
      hr.reply,
      hr.urgent,
      hr.mine,
      hr.closed,
    ]);
  }
  return 'inbox:list:' + JSON.stringify(parts);
}

export function inboxListCacheKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  q: InboxListQuestion
): SessionKey | null {
  return sessionKey(accountId, userId, inboxListQuestion(q));
}

/**
 * Write-through: the rows on screen (with every realtime patch, page
 * and delta the Inbox applied) replace the view's entry, but only when
 * they are that view's rows. Right after a filter change the screen
 * still shows the previous view's rows, which must not be stored under
 * the new key. `update` leaves a missing entry alone (cleared on
 * sign-out or switch), so nothing is put back. Returns whether it wrote.
 */
export function writeThroughInboxList<Row>(
  key: SessionKey | null,
  rowsKey: SessionKey | null,
  snapshot: InboxListSnapshot<Row>
): boolean {
  if (!key || rowsKey !== key) return false;
  return sessionCache.update<InboxListSnapshot<Row>>(key, () => snapshot);
}

/**
 * Which first-page rows an infinite-scroll page started from: the
 * first-page load (`generation`, ticked on every filter change or
 * refresh) and which hand-over of it (`delivery`, ticked on every
 * replace: the cached snapshot, then the fresh page).
 */
export interface InboxListPageOrigin {
  generation: number;
  delivery: number;
}

/**
 * May an older page land on the rows held now? Only on the rows its
 * cursor was read from. A page started from the cached snapshot's
 * cursor must not append after the fresh first page replaced it: chats
 * pushed down past the fresh page's end, but above the stale cursor,
 * would be in neither page and missing from the list.
 */
export function mayAppendOlderPage(
  started: InboxListPageOrigin,
  now: InboxListPageOrigin
): boolean {
  return (
    started.generation === now.generation && started.delivery === now.delivery
  );
}

/**
 * A first page handed to the parent: the view it answers, and the
 * array the parent held at that moment.
 */
export interface InboxListHandover<Row> {
  key: SessionKey | null;
  replaced: readonly Row[];
}

/**
 * Which view the rows on screen belong to, for the write-through. The
 * hand-over is a state update, so until the parent re-renders the
 * screen still holds `replaced` — the previous view's rows, or this
 * view's older ones — and those are filed under no key.
 */
export function inboxListRowsKey<Row>(
  handover: InboxListHandover<Row> | null,
  rows: readonly Row[]
): SessionKey | null {
  if (!handover || rows === handover.replaced) return null;
  return handover.key;
}
