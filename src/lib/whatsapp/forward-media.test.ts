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
  isPersonal: false,
  personalUserId: null,
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
      'https://db.example.com/storage/v1/object/public/chat-media/account-acct-1/a.jpg';
    await expect(
      resolveForwardMediaUrl({
        accountId: 'acct-1',
        sourceMessageId: 'm1',
        mediaUrl: url,
        fromCustomer: true,
        channel: CHANNEL,
        mirror,
      })
    ).resolves.toEqual({ ok: true, url });
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
      fromCustomer: true,
      channel: CHANNEL,
      mirror,
    });

    expect(out).toEqual({ ok: true, url: REHOSTED });
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
      mediaUrl: 'https://lookaside.fbsbx.com/y',
      fromCustomer: true,
      channel: CHANNEL,
      mirror,
    });
    const { download } = mirror.mock.calls[0][0];
    downloadMedia.mockResolvedValue({
      buffer: Buffer.from('x'),
      contentType: 'image/jpeg',
    });
    await download({
      downloadUrl: 'https://lookaside.fbsbx.com/y',
      token: 'ignored',
      maxBytes: 16,
    });
    expect(downloadMedia).toHaveBeenCalledWith({
      channel: CHANNEL,
      downloadUrl: 'https://lookaside.fbsbx.com/y',
      maxBytes: 16,
    });
  });

  it('returns null when the media id no longer resolves', async () => {
    getMediaUrl.mockRejectedValue(new Error('expired'));
    await expect(
      resolveForwardMediaUrl({
        accountId: 'acct-1',
        sourceMessageId: 'm1',
        mediaUrl: '/api/whatsapp/media/1',
        fromCustomer: true,
        channel: CHANNEL,
        mirror,
      })
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(mirror).not.toHaveBeenCalled();
  });

  it('returns null when re-hosting fails', async () => {
    mirror.mockResolvedValue(null);
    await expect(
      resolveForwardMediaUrl({
        accountId: 'acct-1',
        sourceMessageId: 'm1',
        mediaUrl: 'https://lookaside.fbsbx.com/a.jpg',
        fromCustomer: true,
        channel: CHANNEL,
        mirror,
      })
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  const WHAPI: WhatsAppChannel = { ...CHANNEL, provider: 'whapi' };
  const run = (
    mediaUrl: string,
    channel: WhatsAppChannel = CHANNEL,
    fromCustomer = true
  ) =>
    resolveForwardMediaUrl({
      accountId: 'acct-1',
      sourceMessageId: 'm1',
      mediaUrl,
      fromCustomer,
      channel,
      mirror,
    });

  it.each([
    ['an outside URL', 'https://attacker.example/a.jpg', CHANNEL],
    ['an outside URL on Whapi', 'https://attacker.example/a.jpg', WHAPI],
    ['an internal URL', 'http://10.0.0.5/settings', WHAPI],
    ["another gateway's URL", 'https://lookaside.fbsbx.com/a', WHAPI],
    [
      'Whapi outside its media path',
      'https://gate.whapi.cloud/settings',
      WHAPI,
    ],
    ['another Wasabi bucket', 'https://s3.wasabisys.com/mine/a.jpg', WHAPI],
    [
      "another account's storage",
      'https://db.example.com/storage/v1/object/public/chat-media/account-acct-2/a.jpg',
      CHANNEL,
    ],
    ['not a URL', 'nonsense', CHANNEL],
  ])('refuses %s without fetching it', async (_label, url, channel) => {
    await expect(run(url, channel)).resolves.toEqual({
      ok: false,
      reason: 'refused',
    });
    expect(mirror).not.toHaveBeenCalled();
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it("refuses a proxy path on a row that is not a customer's", async () => {
    await expect(
      run('/api/whatsapp/media/9988', CHANNEL, false)
    ).resolves.toEqual({ ok: false, reason: 'refused' });
    expect(getMediaUrl).not.toHaveBeenCalled();
  });

  it.each([
    'https://gate.whapi.cloud/media/abc',
    'https://s3.eu-central-1.wasabisys.com/in-files/1/a.jpg',
  ])('re-hosts what the Whapi number holds: %s', async (url) => {
    await expect(run(url, WHAPI)).resolves.toEqual({ ok: true, url: REHOSTED });
  });
});
