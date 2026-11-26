import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  messagesWaitingResponse,
  waitingMessages,
  wantsForce,
} from './waiting-messages';

function admin(answers: Record<string, unknown>) {
  const rpc = vi.fn(async (_fn: string, args: { p_channel: string }) => {
    const a = answers[args.p_channel];
    if (a instanceof Error) throw a;
    if (a && typeof a === 'object' && 'error' in a) return a;
    return { data: a, error: null };
  });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('waitingMessages', () => {
  it('sums the count of every number', async () => {
    const a = admin({ a: 2, b: 5 });
    expect(await waitingMessages(a.db, ['a', 'b'])).toBe(7);
    expect(a.rpc).toHaveBeenCalledWith('webhook_inbox_waiting', {
      p_channel: 'a',
    });
  });

  it('counts a failed read, or a missing function, as 0 and logs once', async () => {
    const a = admin({
      a: { data: null, error: { code: '42883', message: 'no function' } },
      b: new Error('network'),
      c: 3,
    });
    expect(await waitingMessages(a.db, ['a', 'b', 'c'])).toBe(3);
    expect(await waitingMessages(a.db, ['a'])).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('messagesWaitingResponse', () => {
  it('is a 409 with the code and the count', async () => {
    const res = messagesWaitingResponse(4);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'messages_waiting', count: 4 });
    expect(body.error).toContain('4 customer messages');
  });
});

describe('wantsForce', () => {
  it('reads ?force=1', () => {
    expect(wantsForce(new Request('https://x.test/a?force=1'))).toBe(true);
    expect(wantsForce(new Request('https://x.test/a'))).toBe(false);
  });
});
