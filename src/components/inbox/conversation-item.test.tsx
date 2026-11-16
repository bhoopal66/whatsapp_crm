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

// The node environment renders the row server-side: an HR row (the
// three HR screens) is the normal inbox row (preview, owner line, unread
// count) plus one HR line at the bottom, and the normal row is unchanged.

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
  extra: {
    hrChips?: boolean;
    personalLabel?: string | null;
    showAssignee?: boolean;
  } = {}
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

  it('is the same row an HR row starts with, minus the HR line', () => {
    // Pinned markup: the HR change must not move a byte of this row.
    const c = conv({ unread_count: 3, assigned_agent_id: 'u1' });
    const html = render(c, { showAssignee: true });
    expect(html).toContain('title="Assigned to Omar Farouk"');
    expect(html).not.toContain('Stage: ');
    expect(html).not.toContain('aria-label="Staff"');
    const hrHtml = render(
      conv({ unread_count: 3, assigned_agent_id: 'u1', hr: hr() }),
      { showAssignee: true, hrChips: true }
    );
    // The HR row is the normal row with one line added before the
    // text column closes.
    const hrLine = hrHtml.slice(
      hrHtml.indexOf('<div class="mt-1 flex min-w-0 flex-wrap'),
      hrHtml.lastIndexOf('</div></button>')
    );
    expect(hrHtml.replace(hrLine, '')).toBe(html);
  });
});

describe('ConversationItem, HR row', () => {
  it('recruiter: preview, owner, unread count, then the HR line', () => {
    const html = render(
      conv({
        unread_count: 2,
        assigned_agent_id: 'u1',
        hr: hr({ urgent: true, upset: true }),
      }),
      { hrChips: true, showAssignee: true }
    );
    expect(html).toContain('Hello, any news on my application?');
    expect(html).toContain('title="Assigned to Omar Farouk"');
    expect(html).toContain('>2</span>');
    expect(html).toContain('aria-label="Stage: AI interview"');
    expect(html).toContain('aria-label="Reply state: Reply due"');
    expect(html).toContain('aria-label="Urgent"');
    expect(html).toContain('aria-label="Upset"');
    expect(html).not.toContain('aria-label="Unread"');
    expect(html).not.toContain('aria-label="Staff"');
    // Preview, then the owner line, then the HR line: stage, reply,
    // urgent, upset.
    const order = [
      'Hello, any news',
      'Assigned to ',
      'Stage: ',
      'Reply state: ',
      '"Urgent"',
      '"Upset"',
    ];
    const at = order.map((s) => html.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('owned, not assigned: the owner; nobody: Unassigned', () => {
    const owned = render(conv({ user_id: 'u1', hr: hr() }), {
      hrChips: true,
      showAssignee: true,
    });
    expect(owned).toContain(`title="${t('ownedBy', { name: 'Omar Farouk' })}"`);
    const nobody = render(conv({ hr: hr() }), {
      hrChips: true,
      showAssignee: true,
    });
    expect(nobody).toContain('title="Unassigned"');
  });

  it('dept: Staff ring on the avatar and the topic tag', () => {
    const html = render(
      conv({
        hr: hr({
          inbox: 'dept',
          stage_key: null,
          topic: 'visa_documents',
          reply_state: 'waiting',
        }),
      }),
      { hrChips: true, showAssignee: true }
    );
    expect(html).toMatch(
      /role="img" aria-label="Staff" class="border-primary[^"]*"/
    );
    expect(html).toMatch(/aria-label="Topic: [^"]+"/);
    expect(html).toContain('aria-label="Reply state: Waiting on them"');
    expect(html).toContain('Hello, any news on my application?');
  });

  it('not sorted: a muted Not sorted tag, the preview and the badge', () => {
    const html = render(conv({ hr: null }), {
      hrChips: true,
      showAssignee: true,
      personalLabel: 'My WhatsApp',
    });
    expect(html).toContain('aria-label="Not sorted"');
    expect(html).not.toContain('Reply state: ');
    expect(html).toContain('My WhatsApp');
    expect(html).toContain('Hello, any news on my application?');
  });

  it('closed: Closed instead of the reply state', () => {
    const html = render(
      conv({ hr: hr({ closed_at: '2026-11-15T10:00:00Z' }) }),
      { hrChips: true }
    );
    expect(html).toContain('aria-label="Closed"');
    expect(html).not.toContain('Reply state: ');
  });
});
