import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { AccountRole } from '@/lib/auth/roles';
import { buildChatTagTree } from '@/lib/chat-tags/tree';
import type { ChatTag, Conversation } from '@/types';

// The node environment cannot open a menu, so this pins what each
// role sees in the chat header's tag row before anyone clicks: which
// chips, in which state, and when there is no row at all. The writes
// go through Supabase and are covered by the database's own checks.

const mocks = vi.hoisted(() => ({
  role: 'agent' as string | null,
  tags: [] as unknown[] | null,
  reload: vi.fn(async () => {}),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountRole: mocks.role }),
}));
vi.mock('@/hooks/use-chat-tags', () => ({
  useChatTags: () => {
    const tags = mocks.tags as ChatTag[] | null;
    return {
      tags,
      tree: buildChatTagTree(tags ?? []),
      loading: tags === null,
      reload: mocks.reload,
    };
  },
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('no writes during render');
  },
}));

import { ThreadTagBar } from './thread-tag-bar';

function tag(
  id: string,
  name: string,
  parent_id: string | null = null,
  extra: Partial<ChatTag> = {}
): ChatTag {
  return {
    id,
    account_id: 'acc-1',
    parent_id,
    name,
    color: '#f59e0b',
    sub_tag_title: null,
    position: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

const TAGS: ChatTag[] = [
  tag('t-new', 'New customer', null, { position: 0, color: '#3b82f6' }),
  tag('t-int', 'Interested customer', null, {
    position: 1,
    sub_tag_title: 'Bank',
  }),
  tag('t-adcb', 'ADCB', 't-int', { color: '#ef4444' }),
  tag('t-enbd', 'Emirates NBD', 't-int', { position: 1 }),
];

function conv(
  chat_tag_id: string | null,
  chat_sub_tag_id: string | null = null
): Conversation {
  return {
    id: 'conv-1',
    chat_tag_id,
    chat_sub_tag_id,
  } as Conversation;
}

function render(
  role: AccountRole | null,
  tags: ChatTag[] | null,
  conversation: Conversation
) {
  mocks.role = role;
  mocks.tags = tags;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ThreadTagBar conversation={conversation} onChatTagsChange={vi.fn()} />
    </NextIntlClientProvider>
  );
}

describe('ThreadTagBar', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing for a viewer on an untagged chat', () => {
    expect(render('viewer', TAGS, conv(null))).toBe('');
  });

  it('shows a viewer the tags as static chips, without menus', () => {
    const html = render('viewer', TAGS, conv('t-int', 't-adcb'));
    expect(html).toContain('Interested customer');
    expect(html).toContain('ADCB');
    expect(html).not.toContain('aria-haspopup');
  });

  it('renders nothing until the tags have loaded', () => {
    expect(render('admin', null, conv('t-int'))).toBe('');
  });

  it('offers an admin of an account with no tags the way to set them up', () => {
    const html = render('admin', [], conv(null));
    expect(html).toContain('Set up chat tags');
    expect(html).toContain('href="/settings?tab=chat-tags"');
  });

  it('shows an agent of an account with no tags no row at all', () => {
    expect(render('agent', [], conv(null))).toBe('');
  });

  it('shows the main tag and the sub-tag, captioned only on hover', () => {
    const html = render('agent', TAGS, conv('t-int', 't-adcb'));
    expect(html).toContain('Interested customer');
    expect(html).toContain('ADCB');
    // The pill shows the chosen sub-tag bare; its heading is the tooltip.
    expect(html).not.toContain('>Bank:<');
    expect(html).toContain('title="Bank: ADCB"');
    expect(html).toContain('title="Chat tag: Interested customer"');
    // The chip is a tint of the tag colour; its text is the theme's.
    expect(html).toContain('background-color:rgba(245, 158, 11, 0.14)');
    expect(html).not.toContain('Add tag');
    // An agent gets the menus a viewer does not.
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('offers the sub-tag when the main tag has some but none is chosen', () => {
    const html = render('agent', TAGS, conv('t-int'));
    expect(html).toContain('title="Add Bank"');
    expect(html).toMatch(
      /border-dashed[^>]*title="Add Bank"|title="Add Bank"[^>]*border-dashed/
    );
    expect(html).not.toContain('Bank:');
  });

  it('has no sub-tag chip for a main tag without sub-tags', () => {
    const html = render('agent', TAGS, conv('t-new'));
    expect(html).toContain('New customer');
    expect(html).not.toContain('Bank');
    expect(html).not.toContain('Sub-tag');
  });

  it('shows a tag id missing from the loaded list as no tag', () => {
    const html = render('agent', TAGS, conv('t-deleted-or-new'));
    expect(html).toContain('Add tag');
    expect(html).not.toContain('Interested customer');
  });
});
