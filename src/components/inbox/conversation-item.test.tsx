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
    // The package's staff ring: a teal ring drawn over the avatar.
    expect(html).toMatch(
      /role="img" aria-label="Staff" class="[^"]*"><div[^>]*>V<\/div><span aria-hidden="true" class="border-wa-teal [^"]*border-2"/
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

describe('ConversationItem, the row lines (InboxRows)', () => {
  const tagRow = (over: Record<string, unknown>) =>
    ({
      account_id: 'a1',
      color: '#16a34a',
      sub_tag_title: null,
      position: 0,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-01T00:00:00Z',
      ...over,
    }) as never;
  const tree = buildChatTagTree([
    tagRow({ id: 't1', parent_id: null, name: 'Interested customer' }),
    tagRow({ id: 't2', parent_id: 't1', name: 'Abu Dhabi Commercial Bank' }),
  ]);

  function renderWith(
    c: ConversationListItem,
    extra: Record<string, unknown> = {}
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
          chatTagTree={tree}
          {...extra}
        />
      </NextIntlClientProvider>
    );
  }

  it('gives the preview its own line and puts the tags on the next', () => {
    const html = renderWith(
      conv({ chat_tag_id: 't1', chat_sub_tag_id: 't2', unread_count: 2 })
    );
    const preview = html.indexOf('Hello, any news on my application?');
    const count = html.indexOf('>2</span>');
    const tag = html.indexOf('Interested customer');
    expect(preview).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(preview);
    expect(tag).toBeGreaterThan(count);
    // The sub-tag is compact; the full name is the label.
    expect(html).toContain('ADCB</span>');
    expect(html).toContain(
      'aria-label="Interested customer · Abu Dhabi Commercial Bank"'
    );
  });

  it('reads Unassigned in the muted text, never amber', () => {
    const html = renderWith(conv({ user_id: 'u1' }), { showAssignee: true });
    expect(html).toContain('>Unassigned</span>');
    expect(html).not.toContain('text-warning');
    expect(html).toContain(`title="${t('ownedBy', { name: 'Omar Farouk' })}"`);
  });

  it('offers Assign on an unassigned chat to someone who may assign', () => {
    const profiles = [
      { id: 'p1', user_id: 'u1', full_name: 'Omar Farouk' },
    ] as never;
    const offered = renderWith(conv(), {
      showAssignee: true,
      assignableProfiles: profiles,
      onRequestAssign: () => {},
    });
    expect(offered).toContain('aria-label="Assign the chat with Vishnu Kumar"');
    const assigned = renderWith(conv({ assigned_agent_id: 'u1' }), {
      showAssignee: true,
      assignableProfiles: profiles,
      onRequestAssign: () => {},
    });
    expect(assigned).not.toContain('Assign the chat with');
    expect(assigned).toContain('>Omar Farouk</span>');
    const noRight = renderWith(conv(), {
      showAssignee: true,
      assignableProfiles: [],
      onRequestAssign: () => {},
    });
    expect(noRight).not.toContain('Assign the chat with');
  });
});
