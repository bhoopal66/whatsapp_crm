import { describe, it, expect } from 'vitest';
import {
  CONTACT_LIST_COLUMNS,
  CONVERSATION_LIST_COLUMNS,
  CONVERSATION_LIST_SELECT,
  CONVERSATION_SELECT,
  UNASSIGNED,
  matchesAssignee,
  matchesContactFilters,
  normalizeConversations,
  type ConversationListItem,
} from './conversations';
import {
  needsAttention,
  sortForInbox,
  countNeedingAttention,
} from './attention';
import { inCampaignInbox } from './campaign-inbox';
import {
  insightBadge,
  insightSummary,
  matchesInsightFilters,
  sortForInboxWithInsights,
} from './insights';
import { resolveListHandler } from './handler';
import {
  appendConversationPage,
  deltaWatermark,
  hasMessages,
  mergeConversationDelta,
  nextConversationCursor,
} from './pagination';
import { applyAvatars } from './avatars';
import {
  buildChatTagTree,
  matchesChatTagFilter,
  resolveConversationChatTags,
} from '@/lib/chat-tags/tree';

/**
 * A row holding exactly the list's columns, that throws on a read of any
 * other field: a helper the list runs on its rows reading a column the
 * list select leaves out would otherwise see `undefined` and quietly
 * misbehave (a filter that drops rows, a sort that misorders them).
 */
function strictRow(
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  const contact: Record<string, unknown> = {
    id: 'ct1',
    name: 'Amal',
    phone: '+971500000000',
    company: 'Acme',
    avatar_url: undefined,
  };
  const row: Record<string, unknown> = {
    id: 'c1',
    user_id: 'u1',
    assigned_agent_id: 'u2',
    last_message_text: 'hi',
    last_message_at: '2026-10-28T08:00:00.000Z',
    unread_count: 2,
    updated_at: '2026-10-28T08:00:00.000Z',
    channel_id: 'n1',
    send_channel_id: null,
    chat_tag_id: 't1',
    chat_sub_tag_id: null,
    campaign_broadcast_id: 'b1',
    human_engaged_at: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 1,
    ai_attention_at: '2026-10-28T07:00:00.000Z',
    insight_intent: 'business_loan',
    insight_urgency: 1.6,
    insight_lead_temp: 2,
    insight_upset: 0.2,
    insight_wants_human: 0.1,
    insight_priority: 2,
    insight_at: '2026-10-28T08:00:00.000Z',
    ...overrides,
  };
  // Every key the fixture holds is a listed column, so a typo in it
  // cannot widen what the guard allows.
  expect(Object.keys(row).sort()).toEqual(
    [...CONVERSATION_LIST_COLUMNS].sort()
  );
  expect(Object.keys(contact).sort()).toEqual([...CONTACT_LIST_COLUMNS].sort());
  const guard = <T extends object>(target: T, what: string): T =>
    new Proxy(target, {
      get(t, key, receiver) {
        if (typeof key === 'string' && !(key in t)) {
          throw new Error(
            `list helper read ${what}.${key}, not in the list select`
          );
        }
        return Reflect.get(t, key, receiver);
      },
    });
  row.contact = guard(contact, 'contact');
  return guard(row, 'conversation') as unknown as ConversationListItem;
}

describe('CONVERSATION_LIST_SELECT', () => {
  it('is exactly the two column lists', () => {
    expect(CONVERSATION_LIST_SELECT).toBe(
      `${CONVERSATION_LIST_COLUMNS.join(',')},contact:contacts(${CONTACT_LIST_COLUMNS.join(',')})`
    );
  });

  it('selects no wildcard and none of the wide AI columns', () => {
    expect(CONVERSATION_LIST_SELECT).not.toContain('*');
    for (const wide of [
      'ai_pending_draft',
      'ai_handoff_summary',
      'ai_last_outcome_detail',
    ]) {
      expect(CONVERSATION_LIST_COLUMNS).not.toContain(wide);
    }
  });

  it('leaves the open-thread select on the full row', () => {
    expect(CONVERSATION_SELECT).toBe('*, contact:contacts(*)');
  });
});

describe('list helpers read only listed columns', () => {
  it('filters', () => {
    const row = strictRow();
    expect(matchesContactFilters(row, { company: 'Acme' })).toBe(true);
    expect(matchesAssignee(row, 'u2')).toBe(true);
    expect(matchesAssignee(row, UNASSIGNED)).toBe(false);
    expect(
      matchesAssignee(strictRow({ assigned_agent_id: undefined }), 'u1')
    ).toBe(true);
    const tree = buildChatTagTree([]);
    expect(matchesChatTagFilter(row, ['t1'])).toBe(true);
    expect(resolveConversationChatTags(row, tree).main).toBeNull();
    expect(typeof inCampaignInbox(row, true)).toBe('boolean');
    expect(hasMessages(row)).toBe(true);
  });

  it('row labels, sort, pin and cursor', () => {
    const a = strictRow();
    const b = strictRow({ id: 'c2', ai_attention_at: null });
    expect(resolveListHandler(a)?.userId).toBe('u2');
    expect(needsAttention(a)).toBe(true);
    expect(countNeedingAttention([a, b])).toBe(1);
    expect(sortForInbox([b, a]).map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(nextConversationCursor([a, b], 2)).not.toBeNull();
    expect(deltaWatermark([a, b])).not.toBeNull();
  });

  it('Smart insights badge, filters and Urgent pin', () => {
    const a = strictRow();
    const b = strictRow({ id: 'c2', ai_attention_at: null });
    expect(insightBadge(a)).toBe('urgent');
    expect(insightSummary(a).intent).toBe('business_loan');
    expect(matchesInsightFilters(a, ['hot', 'upset', 'attention'])).toBe(false);
    expect(sortForInboxWithInsights([b, a], true).map((r) => r.id)).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('page merges and the avatar patch', () => {
    const a = strictRow();
    const b = strictRow({ id: 'c2' });
    expect(appendConversationPage([a], [a, b])).toHaveLength(2);
    expect(mergeConversationDelta([a], [b], null)).toHaveLength(2);
    expect(
      applyAvatars([a], { ct1: 'https://x/y.jpg' })[0].contact?.avatar_url
    ).toBe('https://x/y.jpg');
  });
});

describe('normalizeConversations', () => {
  it('unwraps an embed typed as an array and keeps an object or null', () => {
    const base = {
      id: 'c1',
      user_id: 'u1',
      unread_count: 0,
      updated_at: '',
    };
    const contact = { id: 'ct1', phone: '1' };
    expect(
      normalizeConversations([
        { ...base, contact: [contact] },
        { ...base, contact },
        { ...base, contact: null },
        { ...base, contact: [] },
      ]).map((r) => r.contact)
    ).toEqual([contact, contact, null, null]);
  });
});
