// What the customer page (/contacts/[id]) holds and shows, part by
// part, kept pure so the rules are tested here rather than found in
// the browser.
//
// Why parts: every browser round trip costs ~0.4–0.7 s through the
// tunnel, and the page used to show one grey bar until its slowest
// read answered. Now each part (the contact basics, the timeline, the
// thread, the tasks, this month's calls) is shown as it lands.
//
// Why a cache entry: the whole view is kept in the session cache
// (`lib/session-cache.ts`: memory only, per user and workspace, wiped
// on sign-out or switch) under `customerViewKey`, so a revisit shows
// what the user last saw at once. It is a starting point only: the
// page always reads every part again, and each fresh part replaces the
// held one as it lands.

import { sessionKey, type SessionKey } from '@/lib/session-cache';
import type { MonthTotals, TimelineTask } from '@/lib/pbx/timeline';

import type { ContactThread } from './contact-thread';
import type { Basics, CustomerTimeline } from './customer-load';

/** The cache question of one customer page: `contact:<id>`. */
export const CUSTOMER_VIEW_QUESTION_PREFIX = 'contact:';

export function customerViewKey(
  accountId: string | null | undefined,
  userId: string | null | undefined,
  contactId: string
): SessionKey | null {
  return sessionKey(
    accountId,
    userId,
    `${CUSTOMER_VIEW_QUESTION_PREFIX}${contactId}`
  );
}

export interface CustomerView {
  /** Null until the basics land, and when the contact is missing. */
  basics: Basics | null;
  missing: boolean;
  timeline: CustomerTimeline | null;
  thread: ContactThread | null;
  tasks: TimelineTask[] | null;
  summary: MonthTotals | null;
  /** Display names by auth user id, as the profiles read found them. */
  names: Record<string, string>;
  /** A read failed with nothing held to show instead. Never cached. */
  failed: Record<'basics' | 'timeline' | 'tasks' | 'summary', boolean>;
  /**
   * This load's own basics have landed. False on a cached start (the
   * held basics may be older than the contact's row) and when the
   * refresh failed. Never cached as true: `startView` resets it.
   */
  basicsRefreshed: boolean;
}

const NONE_FAILED: CustomerView['failed'] = {
  basics: false,
  timeline: false,
  tasks: false,
  summary: false,
};

export const EMPTY_CUSTOMER_VIEW: CustomerView = {
  basics: null,
  missing: false,
  timeline: null,
  thread: null,
  tasks: null,
  summary: null,
  names: {},
  failed: NONE_FAILED,
  basicsRefreshed: false,
};

/**
 * The view a visit starts from: the cached one, if any, minus its
 * failures — the page reads every part again, so a part that failed
 * last time shows as loading, not as failed.
 */
export function startView(cached: CustomerView | undefined): CustomerView {
  if (!cached) return EMPTY_CUSTOMER_VIEW;
  return {
    ...cached,
    failed: NONE_FAILED,
    basicsRefreshed: false,
  };
}

/** Whether a view holds anything worth keeping for a revisit. */
export function worthCaching(view: CustomerView): boolean {
  return view.basics !== null || view.missing;
}

export type CustomerPart =
  | { kind: 'basics'; value: Basics | null }
  | { kind: 'timeline'; value: CustomerTimeline }
  | { kind: 'thread'; value: ContactThread }
  | { kind: 'tasks'; value: TimelineTask[] }
  | { kind: 'summary'; value: MonthTotals }
  | { kind: 'names'; value: Record<string, string> }
  | {
      kind: 'failed';
      part: 'basics' | 'timeline' | 'thread' | 'tasks' | 'summary';
    };

/**
 * One fresh part landing on the view. A fresh answer replaces the held
 * one whole (a revisit's older pages are dropped, not kept
 * unrefreshed). A failure changes nothing that is on screen: the held
 * value stays, as the session cache keeps a value whose refresh failed;
 * only a part with nothing held is marked failed, never settled empty
 * (a failed tasks read once hid a due call-back behind "No open tasks").
 * The thread keeps waiting, as it always has.
 */
export function applyPart(
  view: CustomerView,
  part: CustomerPart
): CustomerView {
  switch (part.kind) {
    case 'basics':
      return {
        ...view,
        basics: part.value,
        missing: part.value === null,
        basicsRefreshed: true,
        failed: { ...view.failed, basics: false },
      };
    case 'timeline':
      return {
        ...view,
        timeline: part.value,
        failed: { ...view.failed, timeline: false },
      };
    case 'thread':
      return { ...view, thread: part.value };
    case 'tasks':
      return {
        ...view,
        tasks: part.value,
        failed: { ...view.failed, tasks: false },
      };
    case 'summary':
      return {
        ...view,
        summary: part.value,
        failed: { ...view.failed, summary: false },
      };
    case 'names':
      return { ...view, names: { ...view.names, ...part.value } };
    case 'failed':
      if (part.part === 'thread' || view[part.part] !== null) return view;
      if (part.part === 'basics' && view.missing) return view;
      return { ...view, failed: { ...view.failed, [part.part]: true } };
  }
}

/**
 * Whether a page read from `startedFrom` (the timeline whose cursors
 * it used) may land on the held view. A fresh timeline that landed in
 * between ends at a newer row than the cursor, so the rows between
 * would be in neither set and never fetched.
 */
export function mayLandPage(
  view: CustomerView,
  startedFrom: CustomerTimeline
): boolean {
  return view.timeline === startedFrom;
}

/**
 * Edit re-seeds its form from the held contact and saves it whole, so
 * it opens only on this load's own basics, never the cached ones.
 */
export function canEditContact(view: CustomerView): boolean {
  return view.basicsRefreshed && view.basics !== null;
}

export type SectionState = 'loading' | 'failed' | 'ready';

export interface CustomerSections {
  /** The whole screen: missing and failed replace it with one line. */
  page: 'loading' | 'missing' | 'failed' | 'ready';
  /** Header, details, insights, deal rooms and team: the basics. */
  header: 'loading' | 'ready';
  /** The timeline needs the basics too (names, call actions). */
  timeline: SectionState;
  tasks: SectionState;
  month: SectionState;
  /**
   * The cards that read for themselves by contact id alone (deals,
   * cases, memory, journey and consent). They mount with the page, so
   * their reads start beside the page's own instead of after them.
   */
  selfLoading: boolean;
}

/** Which parts of the page can render from what the view holds. */
export function customerSections(view: CustomerView): CustomerSections {
  const page = view.missing
    ? 'missing'
    : view.basics
      ? 'ready'
      : view.failed.basics
        ? 'failed'
        : 'loading';
  const shown = page === 'loading' || page === 'ready';
  return {
    page,
    header: page === 'ready' ? 'ready' : 'loading',
    timeline:
      page === 'ready' && view.timeline
        ? 'ready'
        : view.failed.timeline
          ? 'failed'
          : 'loading',
    tasks: view.tasks ? 'ready' : view.failed.tasks ? 'failed' : 'loading',
    month: view.summary ? 'ready' : view.failed.summary ? 'failed' : 'loading',
    selfLoading: shown,
  };
}

/**
 * The key a page may write its view under: the first non-null key it
 * saw for this contact. `useAuth` has no user yet on a hard reload, so
 * the key appears late; a key that changes after that (another user in
 * this tab) is not the owner, so the view on screen is never stored
 * under it.
 */
export interface ViewOwner {
  contactId: string;
  key: SessionKey;
}

export function viewOwner(
  prev: ViewOwner | null,
  contactId: string,
  key: SessionKey | null
): ViewOwner | null {
  if (prev && prev.contactId === contactId) return prev;
  return key ? { contactId, key } : null;
}

/**
 * What the page does with the cache for the view it holds: store it,
 * drop the entry (the contact is missing: a revisit must not show it),
 * or nothing (no key yet, not the owner, nothing worth keeping).
 */
export function cacheAction(
  view: CustomerView,
  key: SessionKey | null,
  owner: ViewOwner | null
): 'store' | 'drop' | 'none' {
  if (!key || owner?.key !== key) return 'none';
  if (view.missing) return 'drop';
  return worthCaching(view) ? 'store' : 'none';
}
