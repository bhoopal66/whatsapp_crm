import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppChannel } from '@/lib/whatsapp/channels';
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound';

/**
 * Scope: how an inbound attachment's stored link is chosen
 * (`resolveInboundMediaUrl`) — which gateway client downloads the bytes
 * for the mirror, and what is stored when there is no mirrored copy.
 * The mirror itself is `mirror-inbound-media.test.ts`; the Whapi
 * end-to-end path is the Whapi route's test.
 */

const h = vi.hoisted(() => ({
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  mirrorInboundMedia: vi.fn(),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({ storage: { from: vi.fn() } }),
}));
vi.mock('@/lib/whatsapp/provider', () => ({
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}));
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({
  mirrorInboundMedia: h.mirrorInboundMedia,
}));

import { resolveInboundMediaUrl } from './inbound-pipeline';

const GATEWAY_URL = 'http://127.0.0.1:2785/api/sessions/s1/media/abc';
const MIRRORED = 'https://db.example.com/storage/v1/object/public/x.jpg';

function channel(provider: WhatsAppChannel['provider']): WhatsAppChannel {
  return {
    id: 'cfg-1',
    accountId: 'acct-1',
    provider,
    label: null,
    phoneNumberId: 's1',
    wabaId: null,
    accessToken: 'tok-1',
    appSecret: null,
    isPrimary: true,
    mirrorInboundMedia: true,
    status: 'connected',
  } as WhatsAppChannel;
}

const message = {
  id: 'msg-1',
  type: 'image',
  timestamp: 1_700_000_000,
  media: { id: 'media-1', mimeType: 'image/jpeg' },
} as unknown as NormalizedInboundMessage;

beforeEach(() => {
  vi.clearAllMocks();
  h.getMediaUrl.mockResolvedValue({
    url: GATEWAY_URL,
    mimeType: 'image/jpeg',
    fileSize: 10,
  });
  h.downloadMedia.mockResolvedValue({
    buffer: Buffer.from('x'),
    contentType: 'image/jpeg',
  });
});

describe('resolveInboundMediaUrl', () => {
  it.each(['openwa', 'whapi', 'meta'] as const)(
    'mirrors a %s attachment through that channel’s own gateway client',
    async (provider) => {
      const ch = channel(provider);
      h.mirrorInboundMedia.mockImplementation(async (args) => {
        await args.download({ downloadUrl: args.downloadUrl, token: 'x' });
        return MIRRORED;
      });

      const url = await resolveInboundMediaUrl(message, ch, {
        accountId: 'acct-1',
      });

      expect(url).toBe(MIRRORED);
      expect(h.downloadMedia).toHaveBeenCalledWith({
        channel: ch,
        downloadUrl: GATEWAY_URL,
      });
    }
  );

  it('mirrors OpenWA media even when the account opted out', async () => {
    h.mirrorInboundMedia.mockResolvedValue(MIRRORED);

    const url = await resolveInboundMediaUrl(message, channel('openwa'), null);

    expect(url).toBe(MIRRORED);
    expect(h.mirrorInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-1' })
    );
  });

  it('stores no link when an OpenWA mirror fails', async () => {
    h.mirrorInboundMedia.mockResolvedValue(null);

    await expect(
      resolveInboundMediaUrl(message, channel('openwa'), {
        accountId: 'acct-1',
      })
    ).resolves.toBeNull();
  });

  it('keeps the gateway link for Whapi and Meta when the mirror fails', async () => {
    h.mirrorInboundMedia.mockResolvedValue(null);

    for (const provider of ['whapi', 'meta'] as const) {
      await expect(
        resolveInboundMediaUrl(message, channel(provider), {
          accountId: 'acct-1',
        })
      ).resolves.toBe(GATEWAY_URL);
    }
  });

  it('does not mirror Whapi or Meta media for an opted-out account', async () => {
    for (const provider of ['whapi', 'meta'] as const) {
      await expect(
        resolveInboundMediaUrl(message, channel(provider), null)
      ).resolves.toBe(GATEWAY_URL);
    }
    expect(h.mirrorInboundMedia).not.toHaveBeenCalled();
  });
});
