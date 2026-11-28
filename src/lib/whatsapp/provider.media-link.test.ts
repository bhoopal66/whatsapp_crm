import { describe, expect, it, vi } from 'vitest';

import type { MessageTemplate } from '@/types';
import type { WhatsAppChannel } from './channels';

const h = vi.hoisted(() => ({
  whapiMedia: vi.fn(async () => ({ messageId: 'w1' })),
  whapiTemplate: vi.fn(async () => ({ messageId: 'w2' })),
  metaTemplate: vi.fn(async () => ({ messageId: 'm1' })),
}));

// The signer is a stand-in: every chat-media link becomes "SIGNED:<path>".
vi.mock('@/lib/storage/chat-media-sign', async () => {
  const { chatMediaObjectPath } = await import('@/lib/storage/chat-media-url');
  return {
    gatewayMediaLink: async (link: string) => {
      const path = chatMediaObjectPath(link);
      return path ? `https://signed.example/${path}?token=t` : link;
    },
  };
});
vi.mock('./whapi-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendMediaMessage: h.whapiMedia,
  sendTemplateMessage: h.whapiTemplate,
}));
vi.mock('./meta-api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendTemplateMessage: h.metaTemplate,
}));

import { sendMedia, sendTemplate } from './provider';

const STORED =
  'https://crm.example.com/storage/v1/object/public/chat-media/account-a1/x.jpg';

const channel = (provider: 'whapi' | 'meta'): WhatsAppChannel =>
  ({
    id: 'cfg-1',
    accountId: 'a1',
    provider,
    phoneNumberId: 'P1',
    accessToken: 'tok',
  }) as unknown as WhatsAppChannel;

describe('the gateway never gets a stored chat-media link (migration 321)', () => {
  it('signs an attachment', async () => {
    await sendMedia({
      channel: channel('whapi'),
      to: '971',
      kind: 'image',
      link: STORED,
    });
    expect(h.whapiMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        link: 'https://signed.example/account-a1/x.jpg?token=t',
      })
    );
  });

  it('leaves another link alone', async () => {
    await sendMedia({
      channel: channel('whapi'),
      to: '971',
      kind: 'image',
      link: 'https://cdn.example/a.jpg',
    });
    expect(h.whapiMedia).toHaveBeenLastCalledWith(
      expect.objectContaining({ link: 'https://cdn.example/a.jpg' })
    );
  });

  it('signs a template header, wherever the provider reads it', async () => {
    const template = {
      name: 't',
      language: 'en',
      header_media_url: STORED,
      header_content: STORED,
    } as unknown as MessageTemplate;
    await sendTemplate({
      channel: channel('whapi'),
      to: '971',
      template,
      headerMediaUrl: STORED,
    });
    const w = (
      h.whapiTemplate.mock.calls.at(-1) as unknown as [Record<string, unknown>]
    )[0];
    expect(w.headerMediaUrl).toContain('signed.example');
    expect((w.template as { header_content: string }).header_content).toContain(
      'signed.example'
    );
    await sendTemplate({
      channel: channel('meta'),
      to: '971',
      template,
      messageParams: { headerMediaUrl: STORED },
    });
    const m = (
      h.metaTemplate.mock.calls.at(-1) as unknown as [Record<string, unknown>]
    )[0];
    expect(JSON.stringify(m)).not.toContain('/object/public/chat-media/');
  });
});
