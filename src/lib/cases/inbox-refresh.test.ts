import { describe, expect, it, vi } from 'vitest';

import {
  REFRESH_MAX_PAGES,
  REFRESH_PAGE_LIMIT,
  refreshedList,
  rereadInbox,
} from './inbox-refresh';
import { INBOX_PAGE_SIZE, type InboxPage, type InboxRow } from './ui';

const row = (caseId: string) => ({ caseId }) as InboxRow;
const rows = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => row(`c${from + i}`));
const ids = (p: InboxPage) => p.rows.map((r) => r.caseId);

/** A list of `total` cases behind a cursor that is the next index. */
const server = (total: number) =>
  vi.fn(async (after: string | null, limit: number): Promise<InboxPage> => {
    const start = after ? Number(after) : 0;
    const end = Math.min(total, start + limit);
    return {
      rows: rows(start, end - start),
      nextCursor: end < total ? String(end) : null,
    };
  });

describe('rereadInbox', () => {
  it('reads one page when that is all the screen has, also after a failure', async () => {
    const read = server(500);
    const page = await rereadInbox(read, 0);
    expect(read.mock.calls).toEqual([[null, INBOX_PAGE_SIZE]]);
    expect(page.nextCursor).toBe(String(INBOX_PAGE_SIZE));
  });

  it('reads as deep as the pages already loaded', async () => {
    const read = server(900);
    const shown = REFRESH_PAGE_LIMIT + INBOX_PAGE_SIZE;
    const page = await rereadInbox(read, shown);
    expect(read).toHaveBeenCalledTimes(2);
    expect(page.rows.length).toBeGreaterThanOrEqual(shown);
    expect(page.rows.map((r) => r.caseId)).toEqual(
      rows(0, page.rows.length).map((r) => r.caseId)
    );
  });

  it('stops at the end of the list and after its share of pages', async () => {
    const short = server(120);
    expect((await rereadInbox(short, 300)).nextCursor).toBeNull();
    expect(short).toHaveBeenCalledTimes(1);
    const long = server(5_000);
    await rereadInbox(long, 4_000);
    expect(long).toHaveBeenCalledTimes(REFRESH_MAX_PAGES);
  });

  it('rejects when a later page fails, so nothing half-read is shown', async () => {
    const read = server(900);
    read.mockImplementationOnce(async () => ({
      rows: rows(0, 200),
      nextCursor: '200',
    }));
    read.mockRejectedValueOnce(new Error('500'));
    await expect(rereadInbox(read, 250)).rejects.toThrow('500');
  });
});

describe('refreshedList', () => {
  it('shows the fresh rows as the server ordered them', () => {
    const shown = { rows: [row('a'), row('b')], nextCursor: 'x' };
    const fresh = { rows: [row('b'), row('new')], nextCursor: 'y' };
    expect(refreshedList(shown, fresh)).toBe(fresh);
  });

  it('drops what left a list that was read to its end', () => {
    const shown = { rows: [row('a'), row('b')], nextCursor: null };
    const fresh = { rows: [row('b')], nextCursor: null };
    expect(ids(refreshedList(shown, fresh))).toEqual(['b']);
  });

  it('keeps the pages it did not reach, each case once, and their cursor', () => {
    const shown = { rows: rows(0, 6), nextCursor: '6' };
    const fresh = {
      rows: [row('new'), row('c4'), row('c0')],
      nextCursor: '3',
    };
    const out = refreshedList(shown, fresh);
    expect(ids(out)).toEqual(['new', 'c4', 'c0', 'c1', 'c2', 'c3', 'c5']);
    expect(out.nextCursor).toBe('6');
  });
});
