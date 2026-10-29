import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

import { markGroupRead, onGroupRead } from './mark-read';

const GROUP = '11111111-1111-4111-8111-111111111111';

function client(result: { error: unknown } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { rpc } as unknown as NonNullable<
    Parameters<typeof markGroupRead>[1]
  > & { rpc: typeof rpc };
}

describe('markGroupRead', () => {
  it('calls the RPC and tells listeners which group was read', async () => {
    const c = client({ error: null });
    const heard: string[] = [];
    const off = onGroupRead((id) => heard.push(id));
    await expect(markGroupRead(GROUP, c)).resolves.toBe(true);
    off();
    expect(c.rpc).toHaveBeenCalledWith('whatsapp_group_mark_read', {
      p_group: GROUP,
    });
    expect(heard).toEqual([GROUP]);
  });

  it('stays quiet when the RPC refuses or fails', async () => {
    const heard: string[] = [];
    const off = onGroupRead((id) => heard.push(id));
    await expect(
      markGroupRead(GROUP, client({ error: { code: '42501' } }))
    ).resolves.toBe(false);
    await expect(markGroupRead(GROUP, client(new Error('net')))).resolves.toBe(
      false
    );
    off();
    expect(heard).toEqual([]);
  });

  it('stops calling a listener once it unsubscribes', async () => {
    const heard: string[] = [];
    const off = onGroupRead((id) => heard.push(id));
    off();
    await markGroupRead(GROUP, client({ error: null }));
    expect(heard).toEqual([]);
  });
});
