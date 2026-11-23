import { beforeEach, describe, expect, it, vi } from 'vitest';

const read = vi.hoisted(() => ({ in: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ from: () => ({ select: read.select }) }),
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => v.replace('enc:', ''),
}));

import { loadChannels } from './channels';
import { withChannelSecrets } from './channel-secrets';

beforeEach(() => {
  read.in.mockReset();
  read.select.mockReset().mockReturnValue({ in: read.in });
});

describe('withChannelSecrets', () => {
  it('reads the secrets of exactly the rows it was given', async () => {
    read.in.mockResolvedValue({
      data: [{ id: 'a', access_token: 'enc:t' }],
      error: null,
    });
    expect(
      await withChannelSecrets([{ id: 'a', label: 'x' }], ['access_token'])
    ).toEqual([{ id: 'a', label: 'x', access_token: 'enc:t' }]);
    expect(read.select).toHaveBeenCalledWith('id, access_token');
    expect(read.in).toHaveBeenCalledWith('id', ['a']);
  });

  it('reads nothing for no rows', async () => {
    expect(await withChannelSecrets([], ['access_token'])).toEqual([]);
    expect(read.select).not.toHaveBeenCalled();
  });

  it('throws on a failed read and on a row gone by now', async () => {
    read.in.mockResolvedValue({ data: null, error: { message: 'no' } });
    await expect(
      withChannelSecrets([{ id: 'a' }], ['access_token'])
    ).rejects.toThrow('no');
    read.in.mockResolvedValue({ data: [], error: null });
    await expect(
      withChannelSecrets([{ id: 'a' }], ['access_token'])
    ).rejects.toThrow('no row a');
  });
});

describe('loadChannels through a session', () => {
  it('names no secret in the session read (migration 285)', async () => {
    let columns = '';
    const row = { id: 'a', account_id: 'acc', provider: 'whapi' };
    const q = {
      select: (c: string) => ((columns = c), q),
      eq: () => q,
      order: async () => ({ data: [row], error: null }),
    };
    read.in.mockResolvedValue({
      data: [{ id: 'a', access_token: 'enc:t', app_secret: null }],
      error: null,
    });
    const [channel] = await loadChannels({ from: () => q } as never, 'acc');
    expect(channel.accessToken).toBe('t');
    expect(columns).not.toMatch(/access_token|verify_token|app_secret|\*/);
  });
});
