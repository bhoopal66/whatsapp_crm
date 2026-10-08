import { describe, it, expect } from 'vitest';

import type { ChatTag } from '@/types';
import { combineOrGroups } from '@/lib/inbox/pagination';
import {
  buildChatTagTree,
  chatTagFilterOrGroup,
  chatTagLabel,
  matchesChatTagFilter,
  resolveConversationChatTags,
} from './tree';

function tag(id: string, over: Partial<ChatTag> = {}): ChatTag {
  return {
    id,
    account_id: 'acc',
    parent_id: null,
    name: id,
    color: '#3b82f6',
    sub_tag_title: null,
    position: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const NEW = tag('new', { name: 'New customer', position: 0 });
const INTERESTED = tag('int', {
  name: 'Interested customer',
  position: 1,
  sub_tag_title: 'Bank',
});
const ADCB = tag('adcb', { name: 'ADCB', parent_id: 'int', position: 0 });
const ENBD = tag('enbd', {
  name: 'Emirates NBD',
  parent_id: 'int',
  position: 1,
});
const TREE = buildChatTagTree([ENBD, INTERESTED, ADCB, NEW]);

describe('buildChatTagTree', () => {
  it('nests sub-tags under their main tag, both in position order', () => {
    expect(TREE.mains.map((m) => m.id)).toEqual(['new', 'int']);
    expect(TREE.mains[1].subs.map((s) => s.id)).toEqual(['adcb', 'enbd']);
    expect(TREE.mains[0].subs).toEqual([]);
    expect(TREE.mains[1].sub_tag_title).toBe('Bank');
  });

  it('breaks position ties by created_at, then name, then id', () => {
    const tree = buildChatTagTree([
      tag('d', { name: 'Same', created_at: '2026-10-02T00:00:00Z' }),
      tag('c', { name: 'Same', created_at: '2026-10-01T00:00:00Z' }),
      tag('b', { name: 'Beta', created_at: '2026-10-01T00:00:00Z' }),
      tag('a', { name: 'Same', created_at: '2026-10-01T00:00:00Z' }),
      tag('z', { name: 'First', position: -1 }),
    ]);
    expect(tree.mains.map((m) => m.id)).toEqual(['z', 'b', 'a', 'c', 'd']);
  });

  it('orders sub-tags by created_at when positions collide', () => {
    const tree = buildChatTagTree([
      INTERESTED,
      tag('s2', { parent_id: 'int', created_at: '2026-10-03T00:00:00Z' }),
      tag('s1', { parent_id: 'int', created_at: '2026-10-02T00:00:00Z' }),
    ]);
    expect(tree.mains[0].subs.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('leaves orphan and nested sub-tags out of the lists but in byId', () => {
    const orphan = tag('orphan', { parent_id: 'gone' });
    const nested = tag('nested', { parent_id: 'adcb' });
    const tree = buildChatTagTree([NEW, INTERESTED, ADCB, orphan, nested]);
    expect(tree.mains.map((m) => m.id)).toEqual(['new', 'int']);
    expect(tree.mains[1].subs.map((s) => s.id)).toEqual(['adcb']);
    expect(tree.byId.get('orphan')).toEqual(orphan);
    expect(tree.byId.get('nested')).toEqual(nested);
    expect(tree.byId.size).toBe(5);
  });

  it('handles an empty list', () => {
    const tree = buildChatTagTree([]);
    expect(tree.mains).toEqual([]);
    expect(tree.byId.size).toBe(0);
  });
});

describe('resolveConversationChatTags', () => {
  it('resolves a main tag and its own sub-tag', () => {
    const r = resolveConversationChatTags(
      { chat_tag_id: 'int', chat_sub_tag_id: 'enbd' },
      TREE
    );
    expect(r.main?.id).toBe('int');
    expect(r.main?.subs).toHaveLength(2);
    expect(r.sub?.id).toBe('enbd');
  });

  it('resolves a main tag alone', () => {
    const r = resolveConversationChatTags(
      { chat_tag_id: 'new', chat_sub_tag_id: null },
      TREE
    );
    expect(r).toEqual({ main: TREE.mains[0], sub: null });
  });

  it('resolves nothing for an untagged chat', () => {
    expect(resolveConversationChatTags({}, TREE)).toEqual({
      main: null,
      sub: null,
    });
  });

  it('treats stale ids as none instead of throwing', () => {
    expect(
      resolveConversationChatTags(
        { chat_tag_id: 'deleted', chat_sub_tag_id: 'adcb' },
        TREE
      )
    ).toEqual({ main: null, sub: null });
    const r = resolveConversationChatTags(
      { chat_tag_id: 'int', chat_sub_tag_id: 'deleted' },
      TREE
    );
    expect(r.main?.id).toBe('int');
    expect(r.sub).toBeNull();
  });

  it('drops a sub-tag that belongs to another main tag', () => {
    const r = resolveConversationChatTags(
      { chat_tag_id: 'new', chat_sub_tag_id: 'adcb' },
      TREE
    );
    expect(r.main?.id).toBe('new');
    expect(r.sub).toBeNull();
  });

  it('does not accept a sub-tag id as the main tag', () => {
    expect(
      resolveConversationChatTags(
        { chat_tag_id: 'adcb', chat_sub_tag_id: null },
        TREE
      ).main
    ).toBeNull();
  });
});

describe('chatTagLabel', () => {
  it('joins main and sub-tag', () => {
    expect(chatTagLabel(INTERESTED, ADCB)).toBe('Interested customer · ADCB');
  });

  it('names a main tag alone', () => {
    expect(chatTagLabel(NEW, null)).toBe('New customer');
  });

  it('is null without a main tag', () => {
    expect(chatTagLabel(null, null)).toBeNull();
    expect(chatTagLabel(null, ADCB)).toBeNull();
  });
});

describe('matchesChatTagFilter', () => {
  const tagged = { chat_tag_id: 'int', chat_sub_tag_id: 'adcb' };
  const mainOnly = { chat_tag_id: 'int', chat_sub_tag_id: null };
  const untagged = { chat_tag_id: null, chat_sub_tag_id: null };

  it('matches everything with an empty selection', () => {
    expect(matchesChatTagFilter(untagged, [])).toBe(true);
    expect(matchesChatTagFilter(tagged, [])).toBe(true);
  });

  it('a main tag matches its chats whatever the sub-tag', () => {
    expect(matchesChatTagFilter(tagged, ['int'])).toBe(true);
    expect(matchesChatTagFilter(mainOnly, ['int'])).toBe(true);
    expect(matchesChatTagFilter(untagged, ['int'])).toBe(false);
  });

  it('a sub-tag narrows to chats carrying it', () => {
    expect(matchesChatTagFilter(tagged, ['adcb'])).toBe(true);
    expect(matchesChatTagFilter(mainOnly, ['adcb'])).toBe(false);
    expect(matchesChatTagFilter(tagged, ['enbd'])).toBe(false);
  });

  it('ORs the selected ids', () => {
    expect(matchesChatTagFilter(mainOnly, ['new', 'int'])).toBe(true);
    expect(matchesChatTagFilter(untagged, ['new', 'int'])).toBe(false);
  });
});

describe('chatTagFilterOrGroup', () => {
  const A = '11111111-2222-3333-4444-555555555555';
  const B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('is null for an empty selection', () => {
    expect(chatTagFilterOrGroup([])).toBeNull();
  });

  it('matches either column against the selection', () => {
    expect(chatTagFilterOrGroup([A, B])).toBe(
      `chat_tag_id.in.(${A},${B}),chat_sub_tag_id.in.(${A},${B})`
    );
  });

  it('drops anything that is not a UUID before interpolating', () => {
    expect(
      chatTagFilterOrGroup([
        A,
        `${B}),user_id.not.is.null`,
        'not-a-uuid',
        '',
        `${A},${B}`,
      ])
    ).toBe(`chat_tag_id.in.(${A}),chat_sub_tag_id.in.(${A})`);
  });

  it('is null when no UUID is left', () => {
    expect(chatTagFilterOrGroup(['x', 'a),b'])).toBeNull();
  });

  it('lists a repeated id once', () => {
    expect(chatTagFilterOrGroup([A, A])).toBe(
      `chat_tag_id.in.(${A}),chat_sub_tag_id.in.(${A})`
    );
  });

  it('composes with the other list groups', () => {
    expect(combineOrGroups(['user_id.eq.u', chatTagFilterOrGroup([A])])).toBe(
      `and(or(user_id.eq.u),or(chat_tag_id.in.(${A}),chat_sub_tag_id.in.(${A})))`
    );
  });
});
