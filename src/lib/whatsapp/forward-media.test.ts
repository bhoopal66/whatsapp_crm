import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WhatsAppChannel } from './channels';

const getMediaUrl = vi.fn();
const downloadMedia = vi.fn();

vi.mock('@/lib/whatsapp/provider', () => ({
  getMediaUrl: (...a: unknown[]) => getMediaUrl(...a),
  downloadMedia: (...a: unknown[]) => downloadMedia(...a),
}));
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ storage: { tag: 'admin-storage' } }),
}));
vi.mock('@/lib/supabase/urls', () => ({
  publicSupabaseUrl: () => 'https://db.example.com',
}));

import { resolveForwardMediaUrl } from './forward-media';

const CHANNEL: WhatsAppChannel = {
  id: 'cfg-1',
  accountId: 'acct-1',
  provider: 'meta',
  label: null,
  phoneNumberId: 'PNID',
  wabaId: null,
  accessToken: 'meta-token',
  appSecret: null,
  isPrimary: true,
  mirrorInboundMedia: false,
  status: 'connected',
};

const REHOSTED =
  'https://db.example.com/storage/v1/object/public/chat-media/account-acct-1/inbound/fwd-m1.jpg';

describe('resolveForwardMediaUrl', () => {
  const mirror = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mirror.mockResolvedValue(REHOSTED);
  });

  it('passes a public storage URL straight through', async () => {
    const url =
      'https://db.example.com/storage/v1/object/public/chat-media/a.jpg';
    await expect(
      resolveForwardMediaUrl({
        accountId: 'acct-1',
        sourceMessageId: 'm1',
        mediaUrl: url,
        channel: CHANNEL,
        mirror,
      })
    ).resolves.toBe(url);
    expect(mirror).not.toHaveBeenCalled();
  });

  it('resolves a proxy URL through the source channel, then re-hosts it', async () => {
    getMediaUrl.mockResolvedValue({
      url: 'https://lookaside/x',
      mimeType: 'image/jpeg',
      fileSize: 10,
    });

    const out = await resolveForwardMediaUrl({
      accountId: 'acct-1',
      sourceMessageId: 'm1',
      mediaUrl: '/api/whatsapp/media/9988',
      mimeType: 'image/jpeg',
      channel: CHANNEL,
      mirror,
    });

    expect(out).toBe(REHOSTED);
    expect(getMediaUrl).toHaveBeenCalledWith({
      channel: CHANNEL,
      mediaId: '9988',
    });
    expect(mirror).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        mediaId: 'fwd-m1',
        downloadUrl: 'https://lookaside/x',
        accessToken: 'meta-token',
      })
    );
  });

  it('downloads through the provider that holds the bytes, not Whapi by default', async () => {
    await resolveForwardMediaUrl({
      accountId: 'acct-1',
      sourceMessageId: 'm1',
      mediaUrl: 'https://lookaside/y',
      channel: CHANNEL,
      mirror,
    });
    const { download } = mirror.mock.calls[0][0];
    downloadMedia.mockResolvedValue({
      buffer: Buffer.from('x'),
      contentType: 'image/jpeg',
    });
    await download({ downloadUrl: 'https://lookaside/y', token: 'ignored' });
    expect(downloadMedia).toHaveBeenCalledWith({
      channel: CHANNEL,
      downloadUrl: 'https://lookaside/y',
    });
  });

  it('returns null when the media id no longer resolves', async () => {
    getMediaUrl.mockRejectedValue(new Error('expired'));
    await expect(
      resolveForwardMediaUrl({
        accountId: 'acct-1',
        sourceMessageId: 'm1',
        mediaUrl: '/api/whatsapp/media/1',
        channel: CHANNEL,
        mirror,
      })
    ).resolves.toBeNull();
    expect(mirror).not.toHaveBeenCalled();
  });

  it('returns null when re-hosting fails', async () => {
    mirror.mockResolvedValue(null);
    await expect(
      resolveForwardMediaUrl({
        accountId: 'acct-1',
        sourceMessageId: 'm1',
        mediaUrl: 'https://whapi-cdn/a.jpg',
        channel: CHANNEL,
        mirror,
      })
    ).resolves.toBeNull();
  });
});
