import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BodyTooLargeError } from '@/lib/media/capped-body';

const getMediaUrl = vi.fn();
const streamMedia = vi.fn();
const loadChannels = vi.fn();
let rows: Record<string, unknown>[] = [];

vi.mock('@/lib/whatsapp/provider', () => ({
  getMediaUrl: (a: unknown) => getMediaUrl(a),
  streamMedia: (a: unknown) => streamMedia(a),
}));
vi.mock('@/lib/whatsapp/channels', () => ({
  loadChannels: () => loadChannels(),
  primaryChannel: (cs: { isPrimary?: boolean }[]) =>
    cs.find((c) => c.isPrimary) ?? null,
}));
vi.mock('@/lib/auth/active-profile', () => ({
  pickActiveProfile: () => ({ account_id: 'acct-1' }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u' } }, error: null }),
    },
    from: (table: string) => {
      // `eq` is honoured, so the sender filter is really exercised.
      let found = table === 'messages' ? rows : [];
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => {
          found = found.filter((r) => r[k] === v);
          return q;
        },
        like: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: found[0] ?? null }),
        then: (ok: (v: unknown) => void) => ok({ data: found }),
      };
      return q;
    },
  }),
}));

import { GET } from './route';

const A = { id: 'ch-a', provider: 'meta', isPrimary: true };
const B = { id: 'ch-b', provider: 'meta', isPrimary: false };
const row = (over: Record<string, unknown> = {}) => ({
  id: 'm1',
  media_url: '/api/whatsapp/media/42',
  sender_type: 'customer',
  channel_id: 'ch-b',
  ...over,
});
const get = () =>
  GET(new Request('http://x/api/whatsapp/media/42'), {
    params: Promise.resolve({ mediaId: '42' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rows = [row()];
  loadChannels.mockResolvedValue([A, B]);
  getMediaUrl.mockResolvedValue({ url: 'https://u', mimeType: 'image/jpeg' });
  streamMedia.mockImplementation(async () => ({
    body: new Response('bytes').body,
    contentType: 'image/jpeg',
    contentLength: 5,
  }));
});

describe('GET /api/whatsapp/media/[mediaId]', () => {
  it("streams a customer's attachment through the number that carried it", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('bytes');
    expect(res.headers.get('content-length')).toBe('5');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(getMediaUrl.mock.calls.map(([a]) => a.channel.id)).toEqual(['ch-b']);
    expect(streamMedia.mock.calls[0][0].maxBytes).toBe(100 * 1024 * 1024);
  });

  it("a row that is not a customer's authorises nothing", async () => {
    rows = [row({ sender_type: 'agent' })];
    expect((await get()).status).toBe(404);
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it('never tries another number when the row names one', async () => {
    getMediaUrl.mockRejectedValue(new Error('not mine'));
    expect((await get()).status).toBe(500);
    expect(getMediaUrl).toHaveBeenCalledTimes(1);
  });

  it('a number that is gone answers 404', async () => {
    rows = [row({ channel_id: 'ch-gone' })];
    expect((await get()).status).toBe(404);
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it('tries each number, primary first, for a row without one', async () => {
    rows = [row({ channel_id: null })];
    getMediaUrl.mockRejectedValueOnce(new Error('not mine'));
    expect((await get()).status).toBe(200);
    expect(getMediaUrl.mock.calls.map(([a]) => a.channel.id)).toEqual([
      'ch-a',
      'ch-b',
    ]);
  });

  it('answers 413 for a file past the cap', async () => {
    streamMedia.mockRejectedValue(new BodyTooLargeError(2, 1));
    expect((await get()).status).toBe(413);
  });
});
