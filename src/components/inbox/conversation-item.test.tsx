import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator, NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import { buildChatTagTree } from '@/lib/chat-tags/tree';
import type { HrListRow } from '@/lib/hr/list-filters';
import type { ConversationListItem } from '@/lib/inbox/conversations';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => '/inbox',
  useSearchParams: () => new URLSearchParams(),
}));

const { ConversationItem } = await import('./conversation-list');

// The node environment renders the row server-side: the normal inbox
// row keeps its preview line, and an HR row (the three HR screens) is
// the package's two-line row with its tag line and no preview.

const t = createTranslator({
  locale: 'en',
  messages: en,
  namespace: 'Inbox.conversationList',
});

const TODAY = new Date('2026-11-16T00:00:00Z').getTime();
const TREE = buildChatTagTree([]);
const NAMES: Record<string, string> = { u1: 'Omar Farouk' };

function conv(over: Record<string, unknown> = {}): ConversationListItem {
  return {
    id: 'c1',
    contact_id: 'k1',
    status: 'open',
    unread_count: 0,
    last_message_at: '2026-11-16T09:49:00Z',
    last_message_text: 'Hello, any news on my application?',
    assigned_agent_id: null,
    user_id: null,
    personal_owner_id: null,
    contact: { id: 'k1', name: 'Vishnu Kumar', phone: '+971500000417' },
    ...over,
  } as unknown as ConversationListItem;
}

function render(
  c: ConversationListItem,
  extra: { hrChips?: boolean; personalLabel?: string | null } = {}
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <ConversationItem
        conversation={c}
        isActive={false}
        onSelect={() => {}}
        t={t as never}
        today={TODAY}
        locale="en"
        showAssignee={false}
        memberName={(id) => NAMES[id] ?? 'Unknown'}
        chatTagTree={TREE}
        {...extra}
      />
    </NextIntlClientProvider>
  );
}

function hr(over: Partial<HrListRow> = {}): HrListRow {
  return {
    inbox: 'recruiter',
    stage_key: 'ai_interview',
    topic: null,
    urgent: false,
    upset: false,
    reply_state: 'reply_due',
    outcome: null,
    closed_at: null,
    ...over,
  } as HrListRow;
}

describe('ConversationItem, normal inbox row', () => {
  it('keeps the preview line and no HR tags', () => {
    const html = render(conv());
    expect(html).toContain('Hello, any news on my application?');
    expect(html).not.toContain('Reply due');
    expect(html).not.toContain('Unassigned');
  });
});

describe('ConversationItem, HR row', () => {
  it('recruiter: stage marker, reply state, Unread, owner first name', () => {
    const html = render(
      conv({ assigned_agent_id: 'u1', hr: hr({ urgent: true }) }),
      { hrChips: true }
    );
    expect(html).not.toContain('Hello, any news');
    expect(html).toContain('aria-label="Stage: AI interview"');
    expect(html).toContain('aria-label="Reply state: Reply due"');
    expect(html).toContain('aria-label="Urgent"');
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain('aria-label="Owner: Omar"');
    expect(html).not.toContain('aria-label="Staff"');
    // Order on the tag line: stage, reply, urgent, unread, owner.
    const order = [
      'Stage: ',
      'Reply state: ',
      '"Urgent"',
      '"Unread"',
      'Owner: ',
    ];
    const at = order.map((s) => html.indexOf(s));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('dept: Staff avatar and topic tag', () => {
    const html = render(
      conv({
        hr: hr({
          inbox: 'dept',
          stage_key: null,
          topic: 'visa_documents',
          reply_state: 'waiting',
        }),
      }),
      { hrChips: true }
    );
    expect(html).toContain('role="img" aria-label="Staff"');
    expect(html).toMatch(/aria-label="Topic: [^"]+"/);
    expect(html).toContain('aria-label="Reply state: Waiting on them"');
    expect(html).not.toContain('aria-label="Unread"');
    expect(html).toContain('Unassigned');
  });

  it('not sorted: a muted Not sorted tag only', () => {
    const html = render(conv({ hr: null }), {
      hrChips: true,
      personalLabel: 'My WhatsApp',
    });
    expect(html).toContain('aria-label="Not sorted"');
    expect(html).not.toContain('Reply state: ');
    expect(html).toContain('aria-label="My WhatsApp"');
    expect(html).not.toContain('Hello, any news');
  });

  it('closed: Closed instead of the reply state, no Unread', () => {
    const html = render(
      conv({ hr: hr({ closed_at: '2026-11-15T10:00:00Z' }) }),
      { hrChips: true }
    );
    expect(html).toContain('aria-label="Closed"');
    expect(html).not.toContain('Reply state: ');
    expect(html).not.toContain('aria-label="Unread"');
  });
});
