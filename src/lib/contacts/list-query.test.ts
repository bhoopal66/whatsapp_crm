import { describe, expect, it } from 'vitest';
import type { Contact } from '@/types';
import { sessionKey } from '@/lib/session-cache';
import {
  firstCloseMatchId,
  narrowHits,
  pageOfHits,
  buildContactListQuery,
  CONTACT_LIST_QUESTION_PREFIX,
  CONTACT_LIST_SELECT,
  contactListQuestion,
  contactSearchFilter,
  contactSearchTerms,
  contactSortLabel,
  inIdOrder,
  lastActivityByContact,
  toContactListRows,
  type ContactListView,
  type ContactWithConversations,
} from './list-query';

const base: ContactListView = {
  teamView: false,
  personalOnlyUserId: null,
  search: '',
  chatTagIds: [],
  page: 0,
};

describe('contactListQuestion', () => {
  it('differs for every input that changes the answer', () => {
    const variants: ContactListView[] = [
      base,
      { ...base, teamView: true },
      { ...base, personalOnlyUserId: 'user-1' },
      { ...base, search: 'ali' },
      { ...base, chatTagIds: ['tag-a'] },
      { ...base, chatTagIds: ['tag-a', 'tag-b'] },
      { ...base, page: 1 },
      { ...base, sources: ['ad'] },
      { ...base, sort: { sort: 'name', dir: 'asc' } },
      { ...base, sort: { sort: 'name', dir: 'desc' } },
    ];
    const questions = variants.map(contactListQuestion);
    expect(new Set(questions).size).toBe(variants.length);
  });

  it('names the sort, so a future sort control cannot share an entry', () => {
    expect(contactListQuestion(base)).toContain('created_at.desc');
  });

  it('gives every sort key and direction its own entry', () => {
    const keys = ['name', 'created', 'owner', 'assignee', 'activity'] as const;
    const questions = keys.flatMap((sort) =>
      (['asc', 'desc'] as const).map((dir) =>
        contactListQuestion({ ...base, sort: { sort, dir } })
      )
    );
    expect(new Set(questions).size).toBe(questions.length);
    expect(contactSortLabel({ sort: 'activity', dir: 'desc' })).toBe(
      'activity.desc'
    );
    expect(contactSortLabel({ sort: 'created', dir: 'asc' })).toBe(
      'created_at.asc'
    );
  });

  it('is the same question for the same view however it was typed', () => {
    expect(
      contactListQuestion({ ...base, chatTagIds: ['b', 'a'], search: ' ali ' })
    ).toBe(
      contactListQuestion({ ...base, chatTagIds: ['a', 'b'], search: 'ali' })
    );
  });

  it('cannot be confused by a search that looks like another field', () => {
    expect(contactListQuestion({ ...base, search: '","page":1' })).not.toBe(
      contactListQuestion({ ...base, page: 1 })
    );
  });

  it('sits under the prefix the screen invalidates after an edit', () => {
    const key = sessionKey('acc', 'user', contactListQuestion(base));
    const prefix = sessionKey('acc', 'user', CONTACT_LIST_QUESTION_PREFIX);
    expect(key?.startsWith(prefix as string)).toBe(true);
    // Another user or workspace never shares it.
    expect(sessionKey('acc', 'other', contactListQuestion(base))).not.toBe(key);
    expect(sessionKey('acc2', 'user', contactListQuestion(base))).not.toBe(key);
  });
});

type Call = [string, ...unknown[]];

/** A PostgREST builder stand-in that records the calls made on it. */
function recorder() {
  const calls: Call[] = [];
  const q = {
    select: (...a: unknown[]) => (calls.push(['select', ...a]), q),
    order: (...a: unknown[]) => (calls.push(['order', ...a]), q),
    range: (...a: unknown[]) => (calls.push(['range', ...a]), q),
    eq: (...a: unknown[]) => (calls.push(['eq', ...a]), q),
    in: (...a: unknown[]) => (calls.push(['in', ...a]), q),
    or: (...a: unknown[]) => (calls.push(['or', ...a]), q),
  };
  return { q, calls };
}

describe('buildContactListQuery', () => {
  it('is one request: the page, its exact count and the conversations', () => {
    const { q, calls } = recorder();
    buildContactListQuery(
      q,
      { personalOnlyUserId: null, search: '', page: 2 },
      25
    );
    expect(calls).toEqual([
      ['select', CONTACT_LIST_SELECT, { count: 'exact' }],
      ['order', 'created_at', { ascending: false }],
      [
        'order',
        'created_at',
        { ascending: true, referencedTable: 'conversations' },
      ],
      ['range', 50, 74],
    ]);
    expect(CONTACT_LIST_SELECT).toBe(
      '*, conversations(contact_id, chat_tag_id, chat_sub_tag_id, assigned_agent_id, personal_owner_id, last_message_at)'
    );
  });

  it('orders an RPC-only key newest first (its fallback without 257)', () => {
    for (const sort of [
      { sort: 'owner', dir: 'asc' },
      { sort: 'assignee', dir: 'desc' },
      { sort: 'activity', dir: 'asc' },
    ] as const) {
      const { q, calls } = recorder();
      buildContactListQuery(
        q,
        { personalOnlyUserId: null, search: '', page: 0, sort },
        25
      );
      expect(calls[1]).toEqual(['order', 'created_at', { ascending: false }]);
    }
  });

  it('orders by name (blank last), then newest first', () => {
    const { q, calls } = recorder();
    buildContactListQuery(
      q,
      {
        personalOnlyUserId: null,
        search: '',
        page: 0,
        sort: { sort: 'name', dir: 'asc' },
      },
      25
    );
    expect(calls.slice(1, 3)).toEqual([
      ['order', 'name', { ascending: true, nullsFirst: false }],
      ['order', 'created_at', { ascending: false }],
    ]);
  });

  it('narrows to any of the picked lead sources', () => {
    const { q, calls } = recorder();
    buildContactListQuery(
      q,
      {
        personalOnlyUserId: null,
        search: '',
        page: 0,
        sources: ['web_form', 'ad', 'ghost'],
      },
      25
    );
    expect(calls.at(-1)).toEqual(['in', 'lead_source', ['ad', 'web_form']]);
  });

  it('keeps contacts with no source when Unknown is picked', () => {
    const { q, calls } = recorder();
    buildContactListQuery(
      q,
      {
        personalOnlyUserId: null,
        search: '',
        page: 0,
        sources: ['ad', 'unknown'],
      },
      25
    );
    expect(calls.at(-1)).toEqual([
      'or',
      'lead_source.in.(ad),lead_source.is.null',
    ]);
  });

  it('keeps the owner narrowing and the search', () => {
    const { q, calls } = recorder();
    buildContactListQuery(
      q,
      { personalOnlyUserId: 'user-1', search: ' ali ', page: 0 },
      25
    );
    expect(calls.slice(3)).toEqual([
      ['range', 0, 24],
      ['eq', 'user_id', 'user-1'],
      ['or', 'name.ilike.%ali%,phone.ilike.%ali%,email.ilike.%ali%'],
    ]);
  });

  it('adds no search filter for a blank term', () => {
    expect(contactSearchFilter('   ')).toBeNull();
  });

  it('finds a spaced phone by the digits typed without spaces', () => {
    expect(contactSearchFilter('588336503')).toBe(
      'name.ilike.%588336503%,phone.ilike.%588336503%,' +
        'email.ilike.%588336503%,phone_normalized.like.%588336503%'
    );
    expect(contactSearchFilter('058 833 6503')).toContain(
      'phone_normalized.like.%588336503%'
    );
  });

  it('keeps a name search off the digits column', () => {
    expect(contactSearchFilter('Elsa')).not.toContain('phone_normalized');
  });

  it('drops or-filter syntax so the request stays well-formed', () => {
    expect(contactSearchFilter('Acme, Inc (UK)')).toBe(
      'name.ilike.%Acme  Inc  UK%,phone.ilike.%Acme  Inc  UK%,' +
        'email.ilike.%Acme  Inc  UK%'
    );
  });
});

describe('toContactListRows', () => {
  const contact = (id: string) => ({ id, name: id }) as unknown as Contact;

  it('reads the columns from the embedded conversations and strips them', () => {
    const rows: ContactWithConversations[] = [
      {
        ...contact('c1'),
        conversations: [
          {
            contact_id: 'c1',
            chat_tag_id: null,
            chat_sub_tag_id: null,
            assigned_agent_id: null,
          },
          {
            contact_id: 'c1',
            chat_tag_id: 't1',
            chat_sub_tag_id: 's1',
            assigned_agent_id: 'agent-1',
          },
        ],
      },
      { ...contact('c2'), conversations: [] },
      { ...contact('c3'), conversations: null },
    ];
    const out = toContactListRows(rows);
    expect(out.map((r) => r.id)).toEqual(['c1', 'c2', 'c3']);
    expect(out[0].chatTags).toEqual({
      chat_tag_id: 't1',
      chat_sub_tag_id: 's1',
    });
    expect(out[0].assignedTo).toBe('agent-1');
    expect(out[1].chatTags).toBeNull();
    expect(out[2].assignedTo).toBeNull();
    expect(out[0].lastActivityAt).toBeNull();
    for (const row of out) expect('conversations' in row).toBe(false);
  });

  it('reads Assigned to and Last activity from company chats only', () => {
    const rows: ContactWithConversations[] = [
      {
        ...contact('c1'),
        conversations: [
          {
            contact_id: 'c1',
            chat_tag_id: null,
            chat_sub_tag_id: null,
            assigned_agent_id: 'personal-owner',
            personal_owner_id: 'personal-owner',
            last_message_at: '2026-11-21T10:00:00+00:00',
          },
          {
            contact_id: 'c1',
            chat_tag_id: null,
            chat_sub_tag_id: null,
            assigned_agent_id: 'agent-1',
            personal_owner_id: null,
            last_message_at: '2026-11-01T10:00:00+00:00',
          },
        ],
      },
      {
        ...contact('c2'),
        conversations: [
          {
            contact_id: 'c2',
            chat_tag_id: null,
            chat_sub_tag_id: null,
            assigned_agent_id: 'agent-2',
            personal_owner_id: 'agent-2',
            last_message_at: '2026-11-21T10:00:00+00:00',
          },
        ],
      },
    ];
    const out = toContactListRows(rows);
    expect(out[0].assignedTo).toBe('agent-1');
    expect(out[0].lastActivityAt).toBe('2026-11-01T10:00:00+00:00');
    expect(out[1].assignedTo).toBeNull();
    expect(out[1].lastActivityAt).toBeNull();
  });
});

describe('lastActivityByContact', () => {
  it('keeps the newest message per contact and skips chats with none', () => {
    const map = lastActivityByContact([
      { contact_id: 'a', last_message_at: '2026-11-01T00:00:00Z' },
      { contact_id: 'a', last_message_at: '2026-11-03T00:00:00Z' },
      { contact_id: 'a', last_message_at: '2026-11-02T00:00:00Z' },
      { contact_id: 'b', last_message_at: null },
      { contact_id: 'c' },
    ]);
    expect(map.get('a')).toBe('2026-11-03T00:00:00Z');
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(false);
  });
});

describe('inIdOrder', () => {
  it('follows the server order and drops ids with no row', () => {
    const rows = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
    expect(inIdOrder(rows, ['c', 'gone', 'a', 'b']).map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('contactSearchTerms', () => {
  it('is the pattern and digits contactSearchFilter uses', () => {
    expect(contactSearchTerms('058 833 6503')).toEqual({
      like: '%058 833 6503%',
      digits: '588336503',
    });
    expect(contactSearchTerms('50%_off')).toEqual({
      like: '%50\\%\\_off%',
      digits: null,
    });
    expect(contactSearchTerms('  ')).toBeNull();
    expect(contactSearchTerms('(),')).toBeNull();
  });
});

describe('close-match search paging', () => {
  const hit = (contactId: string, exact = true) => ({
    contactId,
    score: 1,
    exact,
  });
  const hits = [hit('a'), hit('b'), hit('c', false), hit('d', false)];

  it('keeps rank order and applies every narrowing set', () => {
    expect(
      narrowHits(hits, [new Set(['d', 'a', 'c']), null]).map((h) => h.contactId)
    ).toEqual(['a', 'c', 'd']);
    expect(
      narrowHits(hits, [new Set(['a', 'c']), new Set(['c', 'd'])]).map(
        (h) => h.contactId
      )
    ).toEqual(['c']);
  });

  it('does not narrow when no set applies', () => {
    expect(narrowHits(hits, [null, null])).toEqual(hits);
  });

  it('pages the ranked hits and reports the total', () => {
    const p = pageOfHits(hits, 2, 2);
    expect(p.hits.map((h) => h.contactId)).toEqual(['c', 'd']);
    expect(p.total).toBe(4);
    expect(pageOfHits(hits, 4, 2).hits).toEqual([]);
  });

  it('finds the first close match for the divider', () => {
    expect(
      firstCloseMatchId([
        { id: 'a', closeMatch: false },
        { id: 'c', closeMatch: true },
      ])
    ).toBe('c');
    expect(firstCloseMatchId([{ id: 'a' }])).toBeNull();
  });
});
