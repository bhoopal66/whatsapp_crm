/**
 * The Cases list with a search box. `case_inbox` has no text filter, so
 * the list is paged as usual (the caller's own filters and visibility
 * still decide which cases exist) and each page is cut down to the cases
 * that answer the query. Pages are read until a page of matches is full
 * or SEARCH_MAX_PAGES have been scanned; the cursor of the last page
 * scanned goes back, so "load more" carries on from there.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { idChunks } from './chunks';
import { contactNames } from './contact-names';
import {
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  type CaseInbox,
  type CaseInboxFilters,
  type CaseInboxPage,
  type CaseInboxRow,
} from './inbox';
import { caseMatchesQuery } from './search';

export const SEARCH_MAX_PAGES = 15;

export type SearchedRow = CaseInboxRow & {
  caseNumber: string | null;
  contactOwnName: string | null;
};

export interface SearchedPage {
  rows: SearchedRow[];
  nextCursor: string | null;
}

async function caseNumbers(
  db: SupabaseClient,
  accountId: string,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of idChunks(ids)) {
    const { data, error } = await db
      .from('cases')
      .select('id, case_number')
      .eq('account_id', accountId)
      .in('id', chunk);
    if (error) throw error;
    for (const r of (data ?? []) as {
      id: string;
      case_number: string | null;
    }[])
      if (r.case_number) out.set(r.id, r.case_number);
  }
  return out;
}

export async function searchInbox(
  db: SupabaseClient,
  inbox: Pick<CaseInbox, 'list'>,
  ctx: { userId: string; accountId: string },
  q: string,
  filters: CaseInboxFilters,
  opts: { limit?: number; after?: string }
): Promise<SearchedPage> {
  const want = opts.limit ?? INBOX_DEFAULT_LIMIT;
  const matches: SearchedRow[] = [];
  let cursor: string | null = opts.after ?? null;
  for (let scanned = 0; scanned < SEARCH_MAX_PAGES; scanned++) {
    const page: CaseInboxPage = await inbox.list(
      ctx.userId,
      ctx.accountId,
      filters,
      { limit: INBOX_MAX_LIMIT, after: cursor }
    );
    const [numbers, names] = await Promise.all([
      caseNumbers(
        db,
        ctx.accountId,
        page.rows.map((r) => r.caseId)
      ),
      contactNames(
        db,
        ctx.accountId,
        page.rows.map((r) => r.contactId)
      ),
    ]);
    for (const r of page.rows) {
      const row: SearchedRow = {
        ...r,
        caseNumber: numbers.get(r.caseId) ?? null,
        contactOwnName: r.contactId ? (names.get(r.contactId) ?? null) : null,
      };
      if (caseMatchesQuery(q, row)) matches.push(row);
    }
    cursor = page.nextCursor;
    if (cursor === null || matches.length >= want) break;
  }
  return { rows: matches, nextCursor: cursor };
}
