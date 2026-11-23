/**
 * Refreshing the Cases list in place, after a gap (the tab was hidden, the
 * connection dropped). Pure, apart from the read it is handed.
 *
 * The list is read again from the top down to the depth on screen, so rows
 * that changed, moved or left it are right, and the pages already loaded
 * stay. Past REFRESH_MAX_PAGES (or when a "load more" landed during the
 * read) the rest of the old rows is kept below, each case once.
 */
import { appendRows, INBOX_PAGE_SIZE, type InboxPage } from './ui';

/** 125 caps a page at 200 (INBOX_MAX_LIMIT in lib/cases/inbox.ts). */
export const REFRESH_PAGE_LIMIT = 200;
export const REFRESH_MAX_PAGES = 3;

/** `readPage` rejects when a page could not be read: then nothing is applied. */
export async function rereadInbox(
  readPage: (after: string | null, limit: number) => Promise<InboxPage>,
  shown: number
): Promise<InboxPage> {
  const limit = Math.min(Math.max(shown, INBOX_PAGE_SIZE), REFRESH_PAGE_LIMIT);
  let page = await readPage(null, limit);
  for (
    let n = 1;
    n < REFRESH_MAX_PAGES && page.nextCursor && page.rows.length < shown;
    n++
  ) {
    const next = await readPage(page.nextCursor, limit);
    page = {
      rows: appendRows(page.rows, next.rows),
      nextCursor: next.nextCursor,
    };
  }
  return page;
}

/** What to show: the fresh rows, then the old ones they do not reach. */
export function refreshedList(shown: InboxPage, fresh: InboxPage): InboxPage {
  if (fresh.nextCursor === null || fresh.rows.length >= shown.rows.length)
    return fresh;
  return {
    rows: appendRows(fresh.rows, shown.rows),
    nextCursor: shown.nextCursor,
  };
}
