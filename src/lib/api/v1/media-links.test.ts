import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('not in tests');
  },
}));

import { withSignedMediaLinks } from './media-links';

const OWN =
  'https://crm.example.com/storage/v1/object/public/chat-media/account-a1/inbound/x.jpg';
const OTHER =
  'https://crm.example.com/storage/v1/object/public/chat-media/account-b2/inbound/y.jpg';

function db() {
  const createSignedUrls = vi.fn(async (paths: string[]) => ({
    data: paths.map((p) => ({
      path: p,
      signedUrl: `https://crm.example.com/storage/v1/object/sign/chat-media/${p}?token=t`,
      error: null,
    })),
    error: null,
  }));
  return {
    client: () =>
      ({ storage: { from: () => ({ createSignedUrls }) } }) as never,
    createSignedUrls,
  };
}

describe('withSignedMediaLinks', () => {
  it('signs our own workspace’s links in one batch, leaves the rest', async () => {
    const d = db();
    const out = await withSignedMediaLinks(
      [
        { id: 1, media_url: OWN },
        { id: 2, media_url: OWN },
        { id: 3, media_url: OTHER },
        { id: 4, media_url: 'https://cdn.example/z.jpg' },
        { id: 5, media_url: null },
      ],
      ['media_url'],
      'a1',
      d.client
    );
    expect(d.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(d.createSignedUrls).toHaveBeenCalledWith(
      ['account-a1/inbound/x.jpg'],
      3600
    );
    expect(out[0]!.media_url).toContain('token=t');
    expect(out[1]!.media_url).toContain('token=t');
    expect(out[2]!.media_url).toBe(OTHER);
    expect(out[3]!.media_url).toBe('https://cdn.example/z.jpg');
    expect(out[4]!.media_url).toBeNull();
  });

  it('makes no call without a link to sign, and never throws', async () => {
    const d = db();
    const items = [{ avatar_url: null }];
    expect(
      await withSignedMediaLinks(items, ['avatar_url'], 'a1', d.client)
    ).toBe(items);
    expect(d.createSignedUrls).not.toHaveBeenCalled();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = () =>
      ({
        storage: {
          from: () => ({
            createSignedUrls: async () => {
              throw new Error('down');
            },
          }),
        },
      }) as never;
    expect(
      (
        await withSignedMediaLinks(
          [{ media_url: OWN }],
          ['media_url'],
          'a1',
          failing
        )
      )[0]!.media_url
    ).toBe(OWN);
    err.mockRestore();
  });
});
