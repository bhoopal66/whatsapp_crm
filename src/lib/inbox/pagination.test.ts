import { describe, it, expect } from 'vitest';
import {
  appendConversationPage,
  assigneeGroup,
  combineOrGroups,
  conversationKeysetGroup,
  deltaWatermark,
  hasMessages,
  isWithinLoadedWindow,
  mergeConversationDelta,
  mergeLatestMessages,
  nextConversationCursor,
  oldestPersisted,
  olderMessagesGroup,
  prependOlderMessages,
  replaceReactionsFor,
  restrictToUserGroup,
  sortByRecency,
  splitEmbeddedReactions,
  toChronological,
} from './pagination';
import { UNASSIGNED } from './conversations';
import type { Conversation, Message, MessageReaction } from '@/types';

function conv(
  id: string,
  last_message_at?: string,
  extra: Partial<Conversation> = {}
): Conversation {
  return {
    id,
    user_id: 'u1',
    contact_id: `ct-${id}`,
    status: 'open',
    unread_count: 0,
    created_at: '',
    updated_at: '',
    last_message_at,
    ...extra,
  };
}

function msg(
  id: string,
  created_at: string,
  extra: Partial<Message> = {}
): Message {
  return {
    id,
    conversation_id: 'c1',
    sender_type: 'customer',
    content_type: 'text',
    status: 'sent',
    created_at,
    ...extra,
  };
}

function reaction(
  id: string,
  message_id: string,
  extra: Partial<MessageReaction> = {}
): MessageReaction {
  return {
    id,
    message_id,
    conversation_id: 'c1',
    actor_type: 'agent',
    actor_id: 'u1',
    emoji: '👍',
    created_at: '',
    ...extra,
  };
}

describe('nextConversationCursor', () => {
  it('returns null for a short page — nothing more to load', () => {
    expect(nextConversationCursor([conv('a', 't')], 2)).toBeNull();
    expect(nextConversationCursor([], 2)).toBeNull();
  });

  it('points at the last row of a full page', () => {
    expect(
      nextConversationCursor(
        [conv('a', '2026-01-02T00:00:00Z'), conv('b', '2026-01-01T00:00:00Z')],
        2
      )
    ).toEqual({ lastMessageAt: '2026-01-01T00:00:00Z', id: 'b' });
  });

  it('keeps a null timestamp as null', () => {
    expect(nextConversationCursor([conv('a'), conv('b')], 2)).toEqual({
      lastMessageAt: null,
      id: 'b',
    });
  });
});

describe('conversationKeysetGroup', () => {
  it('pages through a timestamp with an id tiebreak, quoting the value', () => {
    expect(
      conversationKeysetGroup({
        lastMessageAt: '2026-01-01T10:00:00.123+00:00',
        id: 'b',
      })
    ).toBe(
      'last_message_at.lt."2026-01-01T10:00:00.123+00:00",and(last_message_at.eq."2026-01-01T10:00:00.123+00:00",id.lt.b)'
    );
  });

  it('finishes the NULLS FIRST block before the timestamped rows', () => {
    expect(conversationKeysetGroup({ lastMessageAt: null, id: 'b' })).toBe(
      'and(last_message_at.is.null,id.lt.b),last_message_at.not.is.null'
    );
  });
});

describe('filter groups', () => {
  it('narrows to the rows a user created or holds', () => {
    expect(restrictToUserGroup('u9')).toBe(
      'user_id.eq.u9,assigned_agent_id.eq.u9'
    );
  });

  it('also keeps chats on the numbers the user works (migration 060)', () => {
    expect(restrictToUserGroup('u9', ['c1', 'c2'])).toBe(
      'user_id.eq.u9,assigned_agent_id.eq.u9,channel_id.in.(c1,c2),send_channel_id.in.(c1,c2)'
    );
    expect(restrictToUserGroup('u9', [])).toBe(
      'user_id.eq.u9,assigned_agent_id.eq.u9'
    );
  });

  it('mirrors matchesAssignee: assigned, or unassigned and owned', () => {
    expect(assigneeGroup('u9')).toBe(
      'assigned_agent_id.eq.u9,and(assigned_agent_id.is.null,user_id.eq.u9)'
    );
    expect(assigneeGroup(null)).toBeNull();
    expect(assigneeGroup(UNASSIGNED)).toBeNull();
  });

  it('combines groups into one or= value that ANDs them', () => {
    expect(combineOrGroups([])).toBeNull();
    expect(combineOrGroups([null, undefined])).toBeNull();
    expect(combineOrGroups(['a.eq.1,b.eq.2'])).toBe('a.eq.1,b.eq.2');
    expect(combineOrGroups(['a.eq.1,b.eq.2', null, 'c.eq.3,d.eq.4'])).toBe(
      'and(or(a.eq.1,b.eq.2),or(c.eq.3,d.eq.4))'
    );
  });
});

describe('isWithinLoadedWindow', () => {
  const cursor = { lastMessageAt: '2026-01-10T00:00:00Z', id: 'x' };

  it('accepts everything once every page is loaded', () => {
    expect(isWithinLoadedWindow('2000-01-01T00:00:00Z', null)).toBe(true);
  });

  it('accepts rows at or after the page floor, rejects older ones', () => {
    expect(isWithinLoadedWindow('2026-01-11T00:00:00Z', cursor)).toBe(true);
    expect(isWithinLoadedWindow('2026-01-10T00:00:00Z', cursor)).toBe(true);
    expect(isWithinLoadedWindow('2026-01-09T00:00:00Z', cursor)).toBe(false);
  });

  it('compares instants, not strings', () => {
    expect(isWithinLoadedWindow('2026-01-10T01:00:00+02:00', cursor)).toBe(
      false
    );
  });

  it('treats a message-less row as belonging at the top', () => {
    expect(isWithinLoadedWindow(undefined, cursor)).toBe(true);
  });

  it('rejects timestamped rows while still paging the null block', () => {
    expect(
      isWithinLoadedWindow('2026-01-11T00:00:00Z', {
        lastMessageAt: null,
        id: 'x',
      })
    ).toBe(false);
  });
});

describe('appendConversationPage', () => {
  it('appends new rows and skips ones realtime already added', () => {
    const existing = [conv('a'), conv('b')];
    const out = appendConversationPage(existing, [conv('b'), conv('c')]);
    expect(out.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    // The held copy (possibly fresher) wins over the page's.
    expect(out[1]).toBe(existing[1]);
  });

  it('returns the same array when nothing is new', () => {
    const existing = [conv('a')];
    expect(appendConversationPage(existing, [conv('a')])).toBe(existing);
  });
});

describe('mergeConversationDelta', () => {
  const cursor = { lastMessageAt: '2026-01-10T00:00:00Z', id: 'x' };

  it('patches held rows in place', () => {
    const existing = [
      conv('a', '2026-01-12T00:00:00Z'),
      conv('b', '2026-01-11T00:00:00Z'),
    ];
    const out = mergeConversationDelta(
      existing,
      [conv('b', '2026-01-13T00:00:00Z', { unread_count: 3 })],
      cursor
    );
    expect(out.map((c) => c.id)).toEqual(['a', 'b']);
    expect(out[1].unread_count).toBe(3);
  });

  it('keeps the held contact when the fetched row has none', () => {
    const contact = { id: 'ct', phone: '1' } as Conversation['contact'];
    const out = mergeConversationDelta(
      [conv('a', undefined, { contact })],
      [conv('a')],
      cursor
    );
    expect(out[0].contact).toBe(contact);
  });

  it('prepends unknown rows inside the window, drops older ones', () => {
    const out = mergeConversationDelta(
      [conv('a', '2026-01-12T00:00:00Z')],
      [
        conv('new', '2026-01-14T00:00:00Z'),
        conv('old', '2025-01-01T00:00:00Z'),
      ],
      cursor
    );
    expect(out.map((c) => c.id)).toEqual(['new', 'a']);
  });

  it('returns the same array when nothing applies', () => {
    const existing = [conv('a')];
    expect(mergeConversationDelta(existing, [], cursor)).toBe(existing);
    expect(
      mergeConversationDelta(
        existing,
        [conv('old', '2025-01-01T00:00:00Z')],
        cursor
      )
    ).toBe(existing);
  });
});

describe('deltaWatermark', () => {
  it('is the newest updated_at minus the margin', () => {
    expect(
      deltaWatermark(
        [
          conv('a', undefined, { updated_at: '2026-01-01T00:00:00.000Z' }),
          conv('b', undefined, { updated_at: '2026-01-01T00:05:00.000Z' }),
        ],
        60_000
      )
    ).toBe('2026-01-01T00:04:00.000Z');
  });

  it('is null with nothing to anchor on', () => {
    expect(deltaWatermark([])).toBeNull();
    expect(deltaWatermark([conv('a')])).toBeNull();
  });
});

describe('message paging', () => {
  it('reverses a newest-first page for display', () => {
    const page = [msg('3', 't3'), msg('2', 't2'), msg('1', 't1')];
    expect(toChronological(page).map((m) => m.id)).toEqual(['1', '2', '3']);
    // Doesn't mutate the input.
    expect(page[0].id).toBe('3');
  });

  it('builds the older-than cursor with an id tiebreak', () => {
    expect(
      olderMessagesGroup({ id: 'm1', created_at: '2026-01-01T00:00:00+00:00' })
    ).toBe(
      'created_at.lt."2026-01-01T00:00:00+00:00",and(created_at.eq."2026-01-01T00:00:00+00:00",id.lt.m1)'
    );
  });

  it('finds the oldest persisted message, skipping optimistic ones', () => {
    expect(
      oldestPersisted([msg('temp-1', 't0'), msg('a', 't1'), msg('b', 't2')])?.id
    ).toBe('a');
    expect(oldestPersisted([msg('temp-1', 't0')])).toBeNull();
  });

  it('prepends an older page without duplicates', () => {
    const existing = [msg('c', 't3'), msg('d', 't4')];
    const out = prependOlderMessages(existing, [
      msg('a', 't1'),
      msg('b', 't2'),
      msg('c', 't3'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(prependOlderMessages(existing, [])).toBe(existing);
  });
});

describe('mergeLatestMessages', () => {
  const T = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`;

  it('updates held rows, appends new ones, keeps older pages', () => {
    const existing = [
      msg('a', T(1)),
      msg('b', T(2), { status: 'sent' }),
      msg('c', T(3)),
    ];
    const { messages, gap } = mergeLatestMessages(
      existing,
      [msg('b', T(2), { status: 'read' }), msg('c', T(3)), msg('d', T(4))],
      3
    );
    expect(gap).toBe(false);
    expect(messages.map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(messages[1].status).toBe('read');
  });

  it('keeps in-flight optimistic bubbles, drops settled ones', () => {
    const existing = [
      msg('a', T(1)),
      msg('temp-1', T(5), { status: 'sending' }),
      msg('temp-2', T(6), { status: 'sent' }),
      msg('temp-3', T(7), { status: 'failed' }),
    ];
    const { messages } = mergeLatestMessages(existing, [msg('a', T(1))], 50);
    expect(messages.map((m) => m.id)).toEqual(['a', 'temp-1']);
  });

  it('flags a gap when a full page shares nothing with what is held', () => {
    const existing = [msg('a', T(1))];
    const latest = [msg('x', T(10)), msg('y', T(11))];
    const { messages, gap } = mergeLatestMessages(existing, latest, 2);
    expect(gap).toBe(true);
    expect(messages).toBe(latest);
  });

  it('does not flag a gap for a short page', () => {
    const { gap, messages } = mergeLatestMessages(
      [msg('a', T(1))],
      [msg('x', T(10))],
      2
    );
    expect(gap).toBe(false);
    expect(messages.map((m) => m.id)).toEqual(['a', 'x']);
  });

  it('fills an empty thread from the page', () => {
    const { gap, messages } = mergeLatestMessages(
      [],
      [msg('x', T(1)), msg('y', T(2))],
      2
    );
    expect(gap).toBe(false);
    expect(messages.map((m) => m.id)).toEqual(['x', 'y']);
  });
});

describe('embedded reactions', () => {
  it('splits reactions off the message rows', () => {
    const r = reaction('r1', 'a');
    const { messages, reactions } = splitEmbeddedReactions([
      { ...msg('a', 't1'), reactions: [r] },
      { ...msg('b', 't2'), reactions: null },
    ]);
    expect(messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect('reactions' in messages[0]).toBe(false);
    expect(reactions).toEqual([r]);
  });

  it("replaces only the given messages' reactions", () => {
    const existing = [
      reaction('r1', 'a'),
      reaction('r2', 'old'),
      reaction('temp-1', 'a', { actor_id: 'u2' }),
      reaction('temp-2', 'a', { actor_id: 'u3' }),
    ];
    const out = replaceReactionsFor(
      existing,
      ['a'],
      [reaction('r3', 'a', { actor_id: 'u2' })]
    );
    // r1 was removed server-side; temp-1's real row (r3) arrived; temp-2
    // is still in flight; r2 belongs to a message outside the page.
    expect(out.map((r) => r.id).sort()).toEqual(['r2', 'r3', 'temp-2']);
  });
});

describe('list order and membership', () => {
  const row = (id: string, last_message_at?: string | null) =>
    ({ id, last_message_at }) as Pick<Conversation, 'id' | 'last_message_at'>;

  it('moves a chat that just got a message to the top', () => {
    // Loaded in server order, then realtime patched `b` in place.
    const held = [
      row('a', '2026-10-05T09:00:00Z'),
      row('b', '2026-10-05T10:30:00.123456+00:00'),
      row('c', '2026-10-05T08:00:00Z'),
    ];
    expect(sortByRecency(held).map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('breaks timestamp ties by id descending, as the query does', () => {
    const ts = '2026-10-05T09:00:00Z';
    expect(
      sortByRecency([row('a', ts), row('c', ts), row('b', ts)]).map((c) => c.id)
    ).toEqual(['c', 'b', 'a']);
  });

  it('never puts a message-less chat above one with messages', () => {
    const sorted = sortByRecency([
      row('empty', null),
      row('old', '2020-01-01T00:00:00Z'),
      row('missing'),
    ]);
    expect(sorted[0].id).toBe('old');
  });

  it('does not mutate its input', () => {
    const held = [
      row('a', '2026-01-01T00:00:00Z'),
      row('b', '2026-02-01T00:00:00Z'),
    ];
    sortByRecency(held);
    expect(held.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('lists a chat only once it holds a message', () => {
    expect(hasMessages(row('x', '2026-10-05T09:00:00Z'))).toBe(true);
    expect(hasMessages(row('x', null))).toBe(false);
    expect(hasMessages(row('x'))).toBe(false);
    expect(hasMessages(row('x', ''))).toBe(false);
  });
});
