import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => {
    throw new Error('not in tests');
  },
}));

import { gatewayMediaLink, signChatMediaPath } from './chat-media-sign';

const STORED =
  'https://crm.example.com/storage/v1/object/public/chat-media/account-a1/x.jpg';

function db(result: { data: unknown; error: unknown } | Error) {
  const createSignedUrl = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const from = vi.fn(() => ({ createSignedUrl }));
  return {
    client: () => ({ storage: { from } }) as never,
    from,
    createSignedUrl,
  };
}

describe('gatewayMediaLink', () => {
  it('signs our own attachment for the gateway', async () => {
    const d = db({
      data: {
        signedUrl:
          'https://crm.example.com/storage/v1/object/sign/chat-media/account-a1/x.jpg?token=t',
      },
      error: null,
    });
    expect(await gatewayMediaLink(STORED, d.client)).toContain('token=t');
    expect(d.from).toHaveBeenCalledWith('chat-media');
    expect(d.createSignedUrl).toHaveBeenCalledWith(
      'account-a1/x.jpg',
      21600,
      undefined
    );
  });

  it('passes any other link through untouched, without signing', async () => {
    const d = db({ data: null, error: null });
    expect(await gatewayMediaLink('https://cdn.example/a.jpg', d.client)).toBe(
      'https://cdn.example/a.jpg'
    );
    expect(d.createSignedUrl).not.toHaveBeenCalled();
  });

  it('keeps the stored link when signing fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await gatewayMediaLink(
        STORED,
        db({ data: null, error: { message: 'x' } }).client
      )
    ).toBe(STORED);
    expect(await gatewayMediaLink(STORED, db(new Error('down')).client)).toBe(
      STORED
    );
    err.mockRestore();
  });
});

describe('signChatMediaPath', () => {
  it('answers null on any failure', async () => {
    expect(
      await signChatMediaPath('a/b', 60, db(new Error('x')).client)
    ).toBeNull();
  });
});
