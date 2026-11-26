import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { salesAnswersOff, salesChatOnce } from './not-sales-chat';

function db(
  rows: Record<string, { data?: unknown; error?: { message: string } }>,
  line: unknown = false
) {
  const from = vi.fn((table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null, ...rows[table] }),
    };
    return chain;
  });
  const rpc = vi.fn(async () => ({ data: line, error: null }));
  return { from, rpc };
}
const ask = (client: ReturnType<typeof db>) =>
  salesChatOnce(() => client as unknown as SupabaseClient, {
    conversationId: 'cv-1',
    inboundChannelId: 'ch-1',
  });

describe('salesChatOnce', () => {
  it('reads nothing until asked, and then once for everyone', async () => {
    const client = db({ hr_conversations: { data: { conversation_id: 'x' } } });
    const check = ask(client);
    expect(client.from).not.toHaveBeenCalled();
    const answers = await Promise.all([salesAnswersOff(check), check()]);
    await check();
    expect(answers[0]).toBe('This is an HR chat.');
    expect(client.from.mock.calls.map(([t]) => t)).toEqual([
      'conversations',
      'hr_conversations',
    ]);
  });

  it.each([
    ['another department', db({ conversations: { data: { inbox_department: 'it' } } }), 'This chat is in the it inbox.'],
    ['an HR line', db({}, true), 'The message came in on an HR line.'],
    ['a personal chat', db({ conversations: { data: { personal_owner_id: 'u' } } }), 'This is a personal chat.'],
    ['a failed read', db({ hr_conversations: { error: { message: 'down' } } }), 'Could not check whether this is a sales chat.'],
    ['a sales chat', db({ conversations: { data: { inbox_department: 'sales' } } }), null],
  ])('%s', async (_name, client, expected) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await salesAnswersOff(ask(client))).toBe(expected);
  });

  it('a caller with no inbound message is not asked', async () => {
    expect(await salesAnswersOff(null)).toBeNull();
  });
});
