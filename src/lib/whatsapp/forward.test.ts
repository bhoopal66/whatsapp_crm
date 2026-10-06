import { describe, expect, it } from 'vitest';
import {
  planForward,
  isForwardable,
  isGatewayFetchable,
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

describe('isGatewayFetchable', () => {
  const BASE = 'https://db.example.com/';

  it('accepts an object in our public storage', () => {
    expect(
      isGatewayFetchable(
        'https://db.example.com/storage/v1/object/public/chat-media/account-1/a.jpg',
        BASE
      )
    ).toBe(true);
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
      'https://db.example.com/storage/v1/object/sign/chat-media/a.jpg',
    ],
    [
      'a look-alike host',
      'https://db.example.com.evil.test/storage/v1/object/public/a.jpg',
    ],
  ])('rejects %s', (_label, url) => {
    expect(isGatewayFetchable(url, BASE)).toBe(false);
  });

  it('rejects everything when no public origin is configured', () => {
    expect(
      isGatewayFetchable('https://x/storage/v1/object/public/a.jpg', '')
    ).toBe(false);
  });
});
