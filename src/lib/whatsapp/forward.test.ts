import { sanitizeFilename } from '@/lib/media/filename';
import { buildMediaPath } from '@/lib/storage/upload-media';
import { describe, expect, it } from 'vitest';
import {
  planForward,
  isForwardable,
  ownPublicMediaUrl,
  type ForwardSource,
} from './forward';

const AT = '2026-09-23T10:00:00Z';

function msg(over: Partial<ForwardSource>): ForwardSource {
  return {
    content_type: 'text',
    content_text: undefined,
    media_url: undefined,
    media_type: null,
    created_at: AT,
    ...over,
  };
}

describe('planForward', () => {
  it('re-sends text as text', () => {
    expect(planForward(msg({ content_text: 'hello' }))).toEqual({
      ok: true,
      messageType: 'text',
      contentText: 'hello',
      mediaUrl: null,
      filename: null,
    });
  });

  it.each(['template', 'interactive'] as const)(
    'flattens a %s message to its rendered text',
    (content_type) => {
      const plan = planForward(
        msg({ content_type, content_text: 'Your order shipped' })
      );
      expect(plan).toMatchObject({
        ok: true,
        messageType: 'text',
        contentText: 'Your order shipped',
      });
    }
  );

  it('refuses a text-like message with nothing to send', () => {
    expect(planForward(msg({ content_text: '   ' }))).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('keeps an image caption and its URL', () => {
    const plan = planForward(
      msg({
        content_type: 'image',
        content_text: 'look',
        media_url: 'https://x/y.jpg',
      })
    );
    expect(plan).toEqual({
      ok: true,
      messageType: 'image',
      contentText: 'look',
      mediaUrl: 'https://x/y.jpg',
      filename: null,
    });
  });

  it('drops the caption on audio, which cannot carry one', () => {
    const plan = planForward(
      msg({
        content_type: 'audio',
        content_text: 'note',
        media_url: 'https://x/a.ogg',
      })
    );
    expect(plan).toMatchObject({ ok: true, contentText: null });
  });

  it('names a document and does not repeat the filename as a caption', () => {
    const plan = planForward(
      msg({
        content_type: 'document',
        content_text: 'invoice.pdf',
        media_url: '/api/whatsapp/media/123',
        media_type: 'application/pdf',
      })
    );
    expect(plan).toMatchObject({
      ok: true,
      filename: 'invoice.pdf',
      contentText: null,
    });
  });

  // Stored the way uploads are, so these are the names production has.
  const uploaded = (file: string) =>
    `https://x/storage/v1/object/public/chat-media/${buildMediaPath('acc', file, 1700000000000)}`;
  const doc = (content_text: string, media_url: string) =>
    planForward(msg({ content_type: 'document', content_text, media_url }));

  it.each([
    'Trade Licence.pdf',
    'Invoice: March.pdf',
    'كشف حساب.pdf',
    'Report.PDF',
    `${'a'.repeat(120)}.pdf`,
  ])(
    'an uploaded file named %s goes out without its name as caption',
    (name) => {
      expect(doc(name, uploaded(name))).toMatchObject({
        ok: true,
        contentText: null,
        filename: sanitizeFilename(name),
      });
    }
  );

  it('an inbound file, stored by id, keeps its name and gets no caption', () => {
    const url = `https://x/storage/v1/object/public/chat-media/${buildMediaPath('acc', 'wamid_abc.pdf', null, 'inbound')}`;
    expect(doc('Trade Licence.pdf', url)).toMatchObject({
      contentText: null,
      filename: 'Trade Licence.pdf',
    });
  });

  it('keeps a real caption that ends like a file name', () => {
    expect(
      doc('please sign contract.pdf', uploaded('contract.pdf'))
    ).toMatchObject({
      ok: true,
      contentText: 'please sign contract.pdf',
      filename: 'contract.pdf',
    });
  });

  it('truncates a caption to WhatsApp’s 1024-character limit', () => {
    const plan = planForward(
      msg({
        content_type: 'video',
        content_text: 'a'.repeat(2000),
        media_url: 'https://x/v.mp4',
      })
    );
    expect(plan.ok && plan.contentText?.length).toBe(1024);
  });

  it('refuses an attachment whose bytes never arrived', () => {
    expect(planForward(msg({ content_type: 'image' }))).toEqual({
      ok: false,
      reason: 'no_media',
    });
  });

  it.each(['location', 'contacts'] as const)(
    'refuses %s, which the send core cannot send',
    (content_type) => {
      expect(planForward(msg({ content_type, content_text: 'x' }))).toEqual({
        ok: false,
        reason: 'unsupported_type',
      });
      expect(isForwardable(msg({ content_type, content_text: 'x' }))).toBe(
        false
      );
    }
  );
});

describe('ownPublicMediaUrl', () => {
  const BASE = 'https://db.example.com';
  const PUBLIC = `${BASE}/storage/v1/object/public`;

  it.each(['chat-media', 'flow-media'])("takes this account's %s", (bucket) => {
    const url = `${PUBLIC}/${bucket}/account-1/inbound/a.jpg`;
    expect(ownPublicMediaUrl(url, `${BASE}/`, '1')).toBe(url);
  });

  it('rebuilds an older public origin on ours and never uses its host', () => {
    expect(
      ownPublicMediaUrl(
        'https://old.trycloudflare.com/supabase/storage/v1/object/public/chat-media/account-1/a.jpg',
        BASE,
        '1'
      )
    ).toBe(`${PUBLIC}/chat-media/account-1/a.jpg`);
  });

  it.each([
    ['the auth-gated media proxy', '/api/whatsapp/media/123'],
    [
      'a Meta lookaside URL',
      'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
    ],
    [
      'a Whapi-hosted link',
      'https://s3.eu-central-1.wasabisys.com/in-files/1/a.jpg',
    ],
    [
      'a private storage object',
      `${BASE}/storage/v1/object/sign/chat-media/account-1/a.jpg`,
    ],
    ["another account's folder", `${PUBLIC}/chat-media/account-2/a.jpg`],
    [
      "another account's folder through ..",
      `${PUBLIC}/chat-media/account-1/../account-2/a.jpg`,
    ],
    [
      "another account's folder through an encoded ..",
      `${PUBLIC}/chat-media/account-1/..%2Faccount-2/a.jpg`,
    ],
    ['another bucket', `${PUBLIC}/avatars/account-1/a.jpg`],
    ['the folder itself', `${PUBLIC}/chat-media/account-1/`],
  ])('rejects %s', (_label, url) => {
    expect(ownPublicMediaUrl(url, BASE, '1')).toBeNull();
  });

  it('rejects everything when no public origin is configured', () => {
    expect(
      ownPublicMediaUrl(`${PUBLIC}/chat-media/account-1/a.jpg`, '', '1')
    ).toBeNull();
  });
});
