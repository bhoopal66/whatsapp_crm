import { describe, it, expect } from 'vitest';
import {
  applyMessageEventToPage,
  applyReactionEventToPage,
  mergeFreshPage,
  messagePageFromRows,
  messagesCacheKey,
  type CachedMessagePage,
} from './message-cache';
import { sessionKey } from '@/lib/session-cache';
import type { Message, MessageReaction } from '@/types';

function msg(id: string, minute: number, extra: Partial<Message> = {}) {
  return {
    id,
    conversation_id: 'c1',
    created_at: new Date(Date.UTC(2026, 9, 30, 9, minute)).toISOString(),
    status: 'sent',
    content_text: id,
    ...extra,
  } as Message;
}

function reaction(id: string, messageId: string): MessageReaction {
  return {
    id,
    message_id: messageId,
    actor_type: 'customer',
    actor_id: null,
    emoji: '👍',
  } as unknown as MessageReaction;
}

function page(messages: Message[], reactions: MessageReaction[] = []) {
  return { messages, reactions, hasOlder: false } as CachedMessagePage;
}

describe('messagesCacheKey', () => {
  it('names the conversation under the session key of the viewer', () => {
    expect(messagesCacheKey('a1', 'u1', 'c1')).toBe(
      sessionKey('a1', 'u1', 'inbox:messages:c1')
    );
  });

  it('is null without an account, a user or a conversation', () => {
    expect(messagesCacheKey(null, 'u1', 'c1')).toBeNull();
    expect(messagesCacheKey('a1', undefined, 'c1')).toBeNull();
    expect(messagesCacheKey('a1', 'u1', null)).toBeNull();
  });

  it('differs per user and per workspace', () => {
    const k = messagesCacheKey('a1', 'u1', 'c1');
    expect(messagesCacheKey('a1', 'u2', 'c1')).not.toBe(k);
    expect(messagesCacheKey('a2', 'u1', 'c1')).not.toBe(k);
  });
});

describe('messagePageFromRows', () => {
  it('turns a newest-first read into a chronological page', () => {
    const rows = [
      { ...msg('m2', 2), reactions: [reaction('r1', 'm2')] },
      { ...msg('m1', 1), reactions: null },
    ];
    const p = messagePageFromRows(rows, 2);
    expect(p.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(p.messages[1]).not.toHaveProperty('reactions');
    expect(p.reactions.map((r) => r.id)).toEqual(['r1']);
    expect(p.hasOlder).toBe(true);
    expect(messagePageFromRows(rows, 3).hasOlder).toBe(false);
  });
});

describe('applyMessageEventToPage', () => {
  const base = page([msg('m1', 1), msg('m3', 3)]);

  it('places an insert by created_at and ignores a duplicate', () => {
    const next = applyMessageEventToPage(base, {
      eventType: 'INSERT',
      new: msg('m2', 2),
      old: {},
    });
    expect(next.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(
      applyMessageEventToPage(next, {
        eventType: 'INSERT',
        new: msg('m2', 2),
        old: {},
      })
    ).toBe(next);
  });

  it('never caches an optimistic bubble', () => {
    expect(
      applyMessageEventToPage(base, {
        eventType: 'INSERT',
        new: msg('temp-1', 4),
        old: {},
      })
    ).toBe(base);
  });

  it('keeps one page, dropping the oldest rows and their reactions', () => {
    const full = page([msg('m1', 1), msg('m2', 2)], [reaction('r1', 'm1')]);
    const next = applyMessageEventToPage(
      full,
      { eventType: 'INSERT', new: msg('m3', 3), old: {} },
      2
    );
    expect(next.messages.map((m) => m.id)).toEqual(['m2', 'm3']);
    expect(next.reactions).toEqual([]);
    expect(next.hasOlder).toBe(true);
  });

  it('patches an update onto a held message only', () => {
    const next = applyMessageEventToPage(base, {
      eventType: 'UPDATE',
      new: msg('m1', 1, { status: 'read' }),
      old: {},
    });
    expect(next.messages[0].status).toBe('read');
    expect(
      applyMessageEventToPage(base, {
        eventType: 'UPDATE',
        new: msg('zz', 9),
        old: {},
      })
    ).toBe(base);
  });

  it('removes a deleted message and its reactions', () => {
    const withReaction = page(base.messages, [reaction('r1', 'm1')]);
    const next = applyMessageEventToPage(withReaction, {
      eventType: 'DELETE',
      new: {} as Message,
      old: { id: 'm1' },
    });
    expect(next.messages.map((m) => m.id)).toEqual(['m3']);
    expect(next.reactions).toEqual([]);
  });
});

describe('applyReactionEventToPage', () => {
  const base = page([msg('m1', 1)], [reaction('r1', 'm1')]);

  it('adds or replaces a reaction on a held message', () => {
    const added = applyReactionEventToPage(base, {
      eventType: 'INSERT',
      new: reaction('r2', 'm1'),
      old: {},
    });
    expect(added.reactions.map((r) => r.id)).toEqual(['r1', 'r2']);
    const updated = applyReactionEventToPage(added, {
      eventType: 'UPDATE',
      new: { ...reaction('r1', 'm1'), emoji: '❤️' } as MessageReaction,
      old: {},
    });
    expect(updated.reactions).toHaveLength(2);
    expect(updated.reactions.find((r) => r.id === 'r1')?.emoji).toBe('❤️');
  });

  it('ignores a reaction on a message outside the page', () => {
    expect(
      applyReactionEventToPage(base, {
        eventType: 'INSERT',
        new: reaction('r9', 'older'),
        old: {},
      })
    ).toBe(base);
  });

  it('removes a deleted reaction', () => {
    const next = applyReactionEventToPage(base, {
      eventType: 'DELETE',
      new: {} as MessageReaction,
      old: { id: 'r1' },
    });
    expect(next.reactions).toEqual([]);
  });
});

describe('mergeFreshPage', () => {
  it('applies fresh values, appends new rows and replaces reactions', () => {
    const held = page([msg('m1', 1), msg('m2', 2)], [reaction('r1', 'm1')]);
    const fresh = page(
      [msg('m1', 1), msg('m2', 2, { status: 'read' }), msg('m3', 3)],
      [reaction('r2', 'm2')]
    );
    const merged = mergeFreshPage(held, fresh);
    expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(merged.messages[1].status).toBe('read');
    expect(merged.reactions.map((r) => r.id)).toEqual(['r2']);
    expect(merged.hasOlder).toBe(false);
  });

  it('keeps a bubble still sending', () => {
    const held = page([msg('m1', 1), msg('temp-1', 2, { status: 'sending' })]);
    const merged = mergeFreshPage(held, page([msg('m1', 1)]));
    expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'temp-1']);
  });

  describe('on an opening (shownBefore)', () => {
    const shown = (...ids: string[]) => new Set(ids);

    it('drops every cached row when the fresh page is empty', () => {
      // Reassigned away, share revoked or demoted: RLS answers [].
      const held = page([msg('m1', 1), msg('m2', 2)]);
      const merged = mergeFreshPage(
        { ...held, shownBefore: shown('m1', 'm2') },
        page([])
      );
      expect(merged.messages).toEqual([]);
    });

    it('drops a cached row a short fresh page no longer holds', () => {
      // A deleted message the cached page never heard about.
      const held = page([msg('m1', 1), msg('m2', 2), msg('m3', 3)]);
      const merged = mergeFreshPage(
        { ...held, shownBefore: shown('m1', 'm2', 'm3') },
        page([msg('m1', 1), msg('m3', 3)]),
        5
      );
      expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    });

    it('keeps cached rows older than a full page, drops newer ones', () => {
      const held = page([msg('m1', 1), msg('m2', 2), msg('m4', 4)]);
      const merged = mergeFreshPage(
        { ...held, shownBefore: shown('m1', 'm2', 'm4') },
        page([msg('m2', 2), msg('m3', 3)]),
        2
      );
      expect(merged.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    });

    it('keeps a sending bubble and a realtime arrival during the read', () => {
      const held = page([
        msg('m1', 1),
        msg('m2', 2),
        msg('temp-1', 3, { status: 'sending' }),
      ]);
      const merged = mergeFreshPage(
        { ...held, shownBefore: shown('m1') },
        page([])
      );
      expect(merged.messages.map((m) => m.id)).toEqual(['m2', 'temp-1']);
    });
  });

  it('replaces the page and leaves history above it across a gap', () => {
    const held = page([msg('m1', 1)]);
    const fresh = page([msg('m5', 5), msg('m6', 6)]);
    const merged = mergeFreshPage(held, fresh, 2);
    expect(merged.messages.map((m) => m.id)).toEqual(['m5', 'm6']);
    expect(merged.hasOlder).toBe(true);
  });
});
