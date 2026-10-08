import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { ChatTag } from '@/types';
import { buildChatTagTree } from '@/lib/chat-tags/tree';

// The node environment cannot click, so this pins what an admin sees
// for a given list: the empty state, the order, the sub-tag summary and
// chips, and the "+ Add <heading>" chip. The rules the dialogs apply
// live in lib/chat-tags/edit and are tested there.

const mocks = vi.hoisted(() => ({ tags: null as ChatTag[] | null }));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1' }),
}));
vi.mock('@/hooks/use-chat-tags', () => ({
  useChatTags: () => ({
    tags: mocks.tags,
    tree: buildChatTagTree(mocks.tags ?? []),
    loading: mocks.tags === null,
    reload: vi.fn(),
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

import { ChatTagsPanel } from './chat-tags-panel';
import { chatTagWriteOutcome } from './chat-tag-dialogs';

function tag(
  id: string,
  name: string,
  position: number,
  extra: Partial<ChatTag> = {}
): ChatTag {
  return {
    id,
    account_id: 'acc-1',
    parent_id: null,
    name,
    color: '#10b981',
    sub_tag_title: null,
    position,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...extra,
  };
}

function render(tags: ChatTag[] | null): string {
  mocks.tags = tags;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ChatTagsPanel />
    </NextIntlClientProvider>
  );
}

/** The markup of each main-tag row, in rendered order. */
function rows(html: string): string[] {
  return html.split('<li').slice(1);
}

describe('ChatTagsPanel', () => {
  it('shows the empty state when the account has no chat tags', () => {
    const html = render([]);
    expect(html).toContain(
      'No chat tags yet. Add your first main tag below, for example New customer or Interested customer.'
    );
    expect(html).toContain('Add main tag');
    expect(rows(html)).toHaveLength(0);
  });

  it('shows a loading state, not the empty state, before the first load', () => {
    const html = render(null);
    expect(html).toContain('aria-label="Loading chat tags"');
    expect(html).not.toContain('No chat tags yet');
  });

  it('lists main tags in tree order with their sub-tags beneath them', () => {
    // Stored out of display order on purpose: positions decide.
    const html = render([
      tag('lost', 'Lost', 2),
      tag('fab', 'FAB', 1, { parent_id: 'int' }),
      tag('int', 'Interested customer', 1, { sub_tag_title: 'Bank' }),
      tag('adcb', 'ADCB', 0, { parent_id: 'int' }),
      tag('new', 'New customer', 0),
    ]);
    const [first, second, third, ...rest] = rows(html);
    expect(rest).toHaveLength(0);

    expect(first).toContain('New customer');
    expect(first).not.toContain('·');
    expect(first).toContain('Add sub-tag');

    expect(second).toContain('Interested customer');
    expect(second).toContain('Bank · 2 sub-tags');
    expect(second.indexOf('ADCB')).toBeGreaterThan(-1);
    expect(second.indexOf('ADCB')).toBeLessThan(second.indexOf('FAB'));
    expect(second.indexOf('FAB')).toBeLessThan(second.indexOf('Add Bank'));

    expect(third).toContain('Lost');
    expect(third).not.toContain('ADCB');
  });

  it('names the add chip after the heading, and summarises a heading with no sub-tags', () => {
    const html = render([
      tag('int', 'Interested customer', 0, { sub_tag_title: 'Bank' }),
    ]);
    expect(html).toContain('Add Bank');
    expect(html).toContain('Bank · no sub-tags yet');
  });
});

describe('chatTagWriteOutcome', () => {
  it('maps the duplicate-name violation', () => {
    expect(chatTagWriteOutcome({ error: { code: '23505' }, data: null })).toBe(
      'duplicate'
    );
  });

  it('treats a permission error and a zero-row write as forbidden', () => {
    expect(chatTagWriteOutcome({ error: { code: '42501' }, data: null })).toBe(
      'forbidden'
    );
    expect(chatTagWriteOutcome({ error: null, data: [] })).toBe('forbidden');
  });

  it('reports any other error as a failure and a returned row as ok', () => {
    expect(chatTagWriteOutcome({ error: { code: '23514' }, data: null })).toBe(
      'failed'
    );
    expect(chatTagWriteOutcome({ error: null, data: [{ id: 'x' }] })).toBe(
      'ok'
    );
  });
});
