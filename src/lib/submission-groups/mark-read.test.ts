import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }));

import { markSubmissionGroupRead, onSubmissionGroupRead } from './mark-read';

const GROUP = '11111111-1111-4111-8111-111111111111';

function client(result: { error: unknown } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { rpc } as unknown as NonNullable<
    Parameters<typeof markSubmissionGroupRead>[1]
  > & { rpc: typeof rpc };
}

describe('markSubmissionGroupRead', () => {
  it('calls the RPC and tells listeners which group was read', async () => {
    const c = client({ error: null });
    const heard: string[] = [];
    const off = onSubmissionGroupRead((id) => heard.push(id));
    await expect(markSubmissionGroupRead(GROUP, c)).resolves.toBe(true);
    off();
    expect(c.rpc).toHaveBeenCalledWith('sg_mark_read', {
      p_group: GROUP,
    });
    expect(heard).toEqual([GROUP]);
  });

  it('stays quiet when the RPC refuses or fails', async () => {
    const heard: string[] = [];
    const off = onSubmissionGroupRead((id) => heard.push(id));
    await expect(
      markSubmissionGroupRead(GROUP, client({ error: { code: '42501' } }))
    ).resolves.toBe(false);
    await expect(
      markSubmissionGroupRead(GROUP, client(new Error('net')))
    ).resolves.toBe(false);
    off();
    expect(heard).toEqual([]);
  });

  it('stops calling a listener once it unsubscribes', async () => {
    const heard: string[] = [];
    const off = onSubmissionGroupRead((id) => heard.push(id));
    off();
    await markSubmissionGroupRead(GROUP, client({ error: null }));
    expect(heard).toEqual([]);
  });
});
