import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { conversationListBody, conversationListFoot } from './list-load-state';

const view = { v: 1 };
const other = { v: 1 };
const body = (o: Partial<Parameters<typeof conversationListBody>[0]>) =>
  conversationListBody({
    loading: false,
    rowCount: 0,
    failedView: null,
    view,
    ...o,
  });
const foot = (o: Partial<Parameters<typeof conversationListFoot>[0]>) =>
  conversationListFoot({
    body: 'rows',
    hasMore: true,
    loadingMore: false,
    failedPageView: null,
    view,
    ...o,
  });

describe('conversationListBody', () => {
  it('is as before when reads succeed', () => {
    expect(body({ loading: true, rowCount: 3 })).toBe('loading');
    expect(body({ rowCount: 3 })).toBe('rows');
    expect(body({})).toBe('empty');
  });

  it('never calls a failed read an empty list', () => {
    expect(body({ failedView: view })).toBe('error');
  });

  it('keeps cached rows up when the read failed', () => {
    expect(body({ failedView: view, rowCount: 2 })).toBe('rows');
  });

  it("waits for this view's read after another view's failed", () => {
    expect(body({ failedView: other })).toBe('loading');
  });
});

describe('conversationListFoot', () => {
  it('is as before when reads succeed', () => {
    expect(foot({})).toBe('sentinel');
    expect(foot({ body: 'empty' })).toBe('sentinel');
    expect(foot({ hasMore: false })).toBe('none');
    expect(foot({ body: 'loading' })).toBe('none');
  });

  it('says a page failed, until it is asked for again', () => {
    expect(foot({ failedPageView: view })).toBe('error');
    expect(foot({ failedPageView: view, loadingMore: true })).toBe('sentinel');
    expect(foot({ failedPageView: other })).toBe('sentinel');
  });

  it('stays away from an error body', () => {
    expect(foot({ body: 'error' })).toBe('none');
  });
});

// The component cannot be mounted here (no DOM): its failed reads must
// at least reach the functions above.
describe('conversation-list.tsx', () => {
  const src = readFileSync(
    new URL('../../components/inbox/conversation-list.tsx', import.meta.url),
    'utf8'
  );

  it('records a failed first page and a failed further page', () => {
    expect(src).toMatch(/catch \{[^}]*\{\s*setFailedView\(params\)/);
    expect(src).toMatch(
      /'Failed to fetch more conversations:', error\);\s*setFailedPageView\(params\)/
    );
  });

  it('renders by them, with a Retry in both places', () => {
    expect(src).toContain("body === 'error' ?");
    expect(src).toContain("foot === 'error' &&");
    expect(src).toContain('onClick={retryFirstPage}');
    expect(src).toContain('onClick={() => void loadMore()}');
  });
});
