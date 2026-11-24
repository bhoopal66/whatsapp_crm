import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { forwardMessage, shareCall } from '../api';
import { messageSensitiveKinds } from '../composer-gating';
import { createForwardIds, forwardToAll } from '../forward';

const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('forwardToAll', () => {
  it('retries a failed target under its first id, and only that one', async () => {
    const ids = createForwardIds(counter());
    const sent: string[] = [];
    let down = true;
    const calls = {
      files: async () => [],
      send: async (target: string, _: unknown, id: string | undefined) => {
        sent.push(`${target}:${id}`);
        if (target === 'b' && down) throw new Error('lost');
      },
    };
    const first = await forwardToAll(['a', 'b', 'c'], ids, calls);
    if (!first.read) throw new Error('the files were read');
    expect(first.done).toBe(2);
    expect(first.failed.map((f) => f.id)).toEqual(['b']);
    down = false;
    const again = await forwardToAll(['b', 'a'], ids, calls);
    expect(again).toEqual({ read: true, done: 2, failed: [] });
    // a went through the first time: ticked again, it is a new copy.
    expect(sent).toEqual(['a:id-1', 'b:id-2', 'c:id-3', 'b:id-2', 'a:id-4']);
  });
});

const sbOf = (rpc: unknown) => ({ rpc }) as unknown as SupabaseClient;
const fwd = {
  accountId: 'acc',
  messageId: 'm',
  targetChannelId: 'c',
  attachments: [],
};

describe('the client id on the wire (307)', () => {
  it('goes by name, and is left out when there is none', async () => {
    const rpc = vi.fn(async () => ({ data: 'new', error: null }));
    await forwardMessage(sbOf(rpc), { ...fwd, clientId: 'x' });
    await forwardMessage(sbOf(rpc), fwd);
    await shareCall(sbOf(rpc), {
      channelId: 'c',
      callId: 'k',
      body: 'b',
      clientId: 'y',
    });
    const args = { p_message: 'm', p_channel: 'c', p_attachments: [] };
    expect(rpc.mock.calls).toEqual([
      ['chat_forward_message', { ...args, p_client_id: 'x' }],
      ['chat_forward_message', args],
      [
        'chat_share_call',
        { p_channel: 'c', p_call: 'k', p_body: 'b', p_client_id: 'y' },
      ],
    ]);
  });

  it('forwards without it on a database before 307, and on no other error', async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'PGRST202', message: 'no function' },
      })
      .mockResolvedValueOnce({ data: 'new', error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: '22023', message: 'no' },
      });
    const go = () => forwardMessage(sbOf(rpc), { ...fwd, clientId: 'x' });
    expect(await go()).toBe('new');
    await expect(go()).rejects.toThrow();
    expect(rpc).toHaveBeenCalledTimes(3);
  });
});

describe('messageSensitiveKinds', () => {
  it('reads the file names of a message that has text', () => {
    expect(
      messageSensitiveKinds('see file', [
        'EID 784-1990-1234567-1.pdf',
        '4111-1111-1111-1111.pdf',
      ])
    ).toEqual(['card', 'emirates_id']);
    expect(messageSensitiveKinds('see file', ['offer.pdf'])).toEqual([]);
  });

  it('never joins digits across two names', () => {
    expect(messageSensitiveKinds('', ['4111 1111', '1111 1111'])).toEqual([]);
  });
});
