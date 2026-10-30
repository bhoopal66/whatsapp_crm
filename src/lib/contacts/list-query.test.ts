import { describe, expect, it } from 'vitest';
import type { Contact } from '@/types';
import { sessionKey } from '@/lib/session-cache';
import {
  buildContactListQuery,
  CONTACT_LIST_QUESTION_PREFIX,
  CONTACT_LIST_SELECT,
  contactListQuestion,
  contactSearchFilter,
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
    ];
    const questions = variants.map(contactListQuestion);
    expect(new Set(questions).size).toBe(variants.length);
  });

  it('names the sort, so a future sort control cannot share an entry', () => {
    expect(contactListQuestion(base)).toContain('created_at.desc');
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
      '*, conversations(contact_id, chat_tag_id, chat_sub_tag_id, assigned_agent_id)'
    );
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
    for (const row of out) expect('conversations' in row).toBe(false);
  });
});
