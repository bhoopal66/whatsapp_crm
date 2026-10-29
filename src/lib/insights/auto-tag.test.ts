import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboundInsightsOutcome } from './inbound';
import { INSIGHT_SETTINGS_OFF, type InsightSettings } from './settings-shape';

// ============================================================
// autoTagFromInsights: Supabase, the chat-tag writer and the automation
// dispatch are stubbed at the module boundary. The writer's own
// compare-and-set (onlyIfUntagged) is pinned in chat-tags/server.test.ts.
// ============================================================

interface Call {
  table: string;
  op: 'insert' | 'update';
  payload: unknown;
  filters: unknown[][];
}

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  write: vi.fn(),
  dispatch: vi.fn(),
  insertError: null as { message: string } | null,
}));

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      return {
        insert(payload: unknown) {
          h.calls.push({ table, op: 'insert', payload, filters: [] });
          return Promise.resolve({ data: null, error: h.insertError });
        },
        update(payload: unknown) {
          const call: Call = { table, op: 'update', payload, filters: [] };
          h.calls.push(call);
          const b = {
            eq(...a: unknown[]) {
              call.filters.push(['eq', ...a]);
              return b;
            },
            then(resolve: (r: unknown) => unknown) {
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return b;
        },
      };
    },
  }),
}));
vi.mock('@/lib/chat-tags/server', () => ({
  writeConversationChatTags: (...a: unknown[]) => h.write(...a),
}));
vi.mock('@/lib/automations/chat-tag-dispatch', () => ({
  dispatchChatTagSet: (...a: unknown[]) => h.dispatch(...a),
}));

import { autoTagFromInsights } from './auto-tag';

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
};
const UNTAGGED = { chat_tag_id: null, chat_sub_tag_id: null };

const settings = (s: Partial<InsightSettings> = {}): InsightSettings => ({
  ...INSIGHT_SETTINGS_OFF,
  tagSuggestMode: 'auto',
  tagAutoMinP: 0.85,
  ...s,
});

const outcome = (
  over: Partial<InboundInsightsOutcome> = {}
): InboundInsightsOutcome => ({
  skipped: null,
  settings: settings(),
  reusedTriage: false,
  signals: null,
  judgment: null,
  tag: { mainId: 'tag-a', mainP: 0.9, subId: 'sub-a1', subP: 0.9 },
  chat: { chatTagId: null, chatSubTagId: null, dismissedId: null },
  signalsWritten: false,
  suggestion: 'stored',
  stored: null,
  ...over,
});

const written = (
  saved: Record<string, string | null>,
  previous: Record<string, string | null> = UNTAGGED
) => ({
  ok: true,
  conversationId: 'conv-1',
  contactId: 'contact-1',
  previous,
  saved,
});

beforeEach(() => {
  h.calls = [];
  h.insertError = null;
  h.write
    .mockReset()
    .mockImplementation(
      async (_db: unknown, a: { next: Record<string, string | null> }) =>
        written(a.next)
    );
  h.dispatch.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('autoTagFromInsights — when it applies', () => {
  it('Auto mode, untagged, confident: writes main + sub with onlyIfUntagged, notes, clears, dispatches', async () => {
    const r = await autoTagFromInsights(ARGS, outcome());
    expect(r).toBe('applied');
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.write.mock.calls[0][1]).toEqual({
      accountId: 'acct-1',
      conversationId: 'conv-1',
      next: { chat_tag_id: 'tag-a', chat_sub_tag_id: 'sub-a1' },
      onlyIfUntagged: true,
    });
    const note = h.calls.find((c) => c.table === 'conversation_events')!;
    expect(note.payload).toEqual({
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      kind: 'chat_tag_auto',
      actor_user_id: null,
      to_label: JSON.stringify({
        chat_tag_id: 'tag-a',
        chat_sub_tag_id: 'sub-a1',
        p: 0.9,
      }),
    });
    const clear = h.calls.find((c) => c.table === 'conversations')!;
    expect(clear.payload).toEqual({
      suggested_chat_tag_id: null,
      suggested_chat_sub_tag_id: null,
      suggested_tag_p: null,
      suggested_tag_at: null,
    });
    expect(clear.filters).toEqual([
      ['eq', 'id', 'conv-1'],
      ['eq', 'account_id', 'acct-1'],
    ]);
    expect(h.dispatch).toHaveBeenCalledWith({
      accountId: 'acct-1',
      contactId: 'contact-1',
      conversationId: 'conv-1',
      previous: UNTAGGED,
      saved: { chat_tag_id: 'tag-a', chat_sub_tag_id: 'sub-a1' },
    });
  });

  it('applies at exactly the threshold', async () => {
    const r = await autoTagFromInsights(
      ARGS,
      outcome({
        tag: { mainId: 'tag-a', mainP: 0.85, subId: 'sub-a1', subP: 0.85 },
      })
    );
    expect(r).toBe('applied');
    expect(h.write.mock.calls[0][1].next).toEqual({
      chat_tag_id: 'tag-a',
      chat_sub_tag_id: 'sub-a1',
    });
  });

  it('drops a sub-tag below the threshold, keeps the main tag', async () => {
    await autoTagFromInsights(
      ARGS,
      outcome({
        tag: { mainId: 'tag-a', mainP: 0.95, subId: 'sub-a1', subP: 0.84 },
      })
    );
    expect(h.write.mock.calls[0][1].next).toEqual({
      chat_tag_id: 'tag-a',
      chat_sub_tag_id: null,
    });
  });

  it('a main tag with no sub-tag question writes a null sub-tag', async () => {
    await autoTagFromInsights(
      ARGS,
      outcome({ tag: { mainId: 'tag-b', mainP: 0.9, subId: null, subP: null } })
    );
    expect(h.write.mock.calls[0][1].next).toEqual({
      chat_tag_id: 'tag-b',
      chat_sub_tag_id: null,
    });
  });
});

describe('autoTagFromInsights — when it does nothing', () => {
  const nothing = () => {
    expect(h.write).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  };

  it('only in Auto mode', async () => {
    for (const mode of ['off', 'suggest'] as const) {
      expect(
        await autoTagFromInsights(
          ARGS,
          outcome({ settings: settings({ tagSuggestMode: mode }) })
        )
      ).toBe('not_auto');
    }
    nothing();
  });

  it('not when the insights run stopped or failed', async () => {
    for (const skipped of ['off', 'error', 'rate_limited'] as const) {
      expect(await autoTagFromInsights(ARGS, outcome({ skipped }))).toBe(
        'not_auto'
      );
    }
    expect(await autoTagFromInsights(ARGS, outcome({ settings: null }))).toBe(
      'not_auto'
    );
    expect(await autoTagFromInsights(ARGS, outcome({ chat: null }))).toBe(
      'not_auto'
    );
    nothing();
  });

  it('just below the threshold, no main tag, or no tag answer', async () => {
    const cases = [
      { mainId: 'tag-a', mainP: 0.8499, subId: null, subP: null },
      { mainId: null, mainP: 0.99, subId: null, subP: null },
    ];
    for (const tag of cases)
      expect(await autoTagFromInsights(ARGS, outcome({ tag }))).toBe(
        'not_confident'
      );
    expect(await autoTagFromInsights(ARGS, outcome({ tag: null }))).toBe(
      'not_confident'
    );
    nothing();
  });

  it('uses the account threshold, not the default', async () => {
    const r = await autoTagFromInsights(
      ARGS,
      outcome({
        settings: settings({ tagAutoMinP: 0.95 }),
        tag: { mainId: 'tag-a', mainP: 0.94, subId: null, subP: null },
      })
    );
    expect(r).toBe('not_confident');
    nothing();
  });

  it('never on a chat that already has a main tag', async () => {
    const r = await autoTagFromInsights(
      ARGS,
      outcome({
        chat: { chatTagId: 'tag-b', chatSubTagId: null, dismissedId: null },
      })
    );
    expect(r).toBe('already_tagged');
    nothing();
  });

  it('skips a tag a person dismissed for this chat', async () => {
    const r = await autoTagFromInsights(
      ARGS,
      outcome({
        chat: { chatTagId: null, chatSubTagId: null, dismissedId: 'tag-a' },
      })
    );
    expect(r).toBe('dismissed');
    nothing();
  });

  it('a person tagging first wins: no dispatch, note or clear', async () => {
    const theirs = { chat_tag_id: 'tag-b', chat_sub_tag_id: null };
    h.write.mockResolvedValue(written(theirs, theirs));
    const r = await autoTagFromInsights(ARGS, outcome());
    expect(r).toBe('unchanged');
    expect(h.write.mock.calls[0][1].onlyIfUntagged).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('a refused write is logged, nothing else happens', async () => {
    h.write.mockResolvedValue({ ok: false, reason: 'invalid', message: 'x' });
    expect(await autoTagFromInsights(ARGS, outcome())).toBe('error');
    expect(h.calls).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[insights]'),
      'x'
    );
  });
});

describe('autoTagFromInsights — never throws', () => {
  it('a thrown write is an error result', async () => {
    h.write.mockRejectedValue(new Error('boom'));
    expect(await autoTagFromInsights(ARGS, outcome())).toBe('error');
    expect(console.error).toHaveBeenCalled();
  });

  it('a failed note still dispatches the automations', async () => {
    h.insertError = { message: 'nope' };
    expect(await autoTagFromInsights(ARGS, outcome())).toBe('applied');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('a thrown dispatch is an error result', async () => {
    h.dispatch.mockRejectedValue(new Error('engine'));
    expect(await autoTagFromInsights(ARGS, outcome())).toBe('error');
  });
});
