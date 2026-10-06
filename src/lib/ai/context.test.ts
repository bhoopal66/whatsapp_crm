import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildConversationContext } from './context';

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
function fakeDb(
  rows: unknown[],
  seen: { contentTypes?: unknown } = {}
): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: (_col: string, values: unknown) => {
      seen.contentTypes = values;
      return chain;
    },
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  };
  return chain as unknown as SupabaseClient;
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ];
    const out = await buildConversationContext(fakeDb(rows), 'conv-1');
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
  });

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1'
    );
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }]);
  });

  it('reads interactive rows too — a tapped button title is the customer message', async () => {
    // A template quick-reply tap is stored as content_type='interactive'
    // with the tapped title as its text. Leaving it out made the bot
    // see an empty thread and stay silent on a campaign reply.
    const seen: { contentTypes?: unknown } = {};
    await buildConversationContext(fakeDb([], seen), 'conv-1');
    expect(seen.contentTypes).toEqual(['text', 'interactive']);
  });

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1'
    );
    expect(out).toEqual([{ role: 'user', content: 'real' }]);
  });
});
