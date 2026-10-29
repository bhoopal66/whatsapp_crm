import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import type { Message } from '@/types';
import {
  resetTranslationCache,
  translateMessage,
} from '@/lib/translate/client';
import { MessageBubble } from './message-bubble';

// The Translate control under an Arabic customer message, rendered
// server-side. Which messages count as Arabic is lib/translate/detect.

const ARABIC = 'مرحبا، أريد معرفة تفاصيل القرض';

const msg = (over: Partial<Message>): Message =>
  ({
    id: 'm1',
    conversation_id: 'conv-1',
    sender_type: 'customer',
    content_type: 'text',
    content_text: ARABIC,
    status: 'delivered',
    created_at: '2026-10-29T10:00:00.000Z',
    ...over,
  }) as Message;

function render(message: Message) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <MessageBubble message={message} />
    </NextIntlClientProvider>
  );
}

const fakeFetch = async () =>
  new Response(JSON.stringify({ text: 'Hello' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Translate on a message bubble', () => {
  beforeEach(() => resetTranslationCache());

  it('offers Translate on a customer message in Arabic', () => {
    const html = render(msg({}));
    expect(html).toContain('>Translate</button>');
    expect(html).toContain(
      'title="Translate this message into English with AI"'
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain(ARABIC);
  });

  it('offers it on an Arabic photo caption too', () => {
    const html = render(
      msg({ content_type: 'image', media_url: 'https://x.test/a.jpg' })
    );
    expect(html).toContain('>Translate</button>');
  });

  it('offers nothing on an English customer message', () => {
    const html = render(msg({ content_text: 'Hello, I want a loan' }));
    expect(html).not.toContain('Translate');
  });

  it('offers nothing on an agent message in Arabic', () => {
    const html = render(msg({ sender_type: 'agent', status: 'sent' }));
    expect(html).not.toContain('Translate');
  });

  it('shows the English in place of the Arabic once translated this session', async () => {
    const result = await translateMessage('m1', ARABIC, fakeFetch);
    expect(result).toEqual({ ok: true, text: 'Hello' });

    const html = render(msg({}));
    expect(html).toContain('Hello');
    expect(html).not.toContain(ARABIC);
    expect(html).toContain('Translated from Arabic');
    expect(html).toContain('>Show original</button>');
    expect(html).not.toContain('>Translate</button>');
  });

  it('starts over when the text changed since it was translated', async () => {
    await translateMessage('m1', ARABIC, fakeFetch);
    const edited = `${ARABIC} من فضلك`;
    const html = render(msg({ content_text: edited }));
    expect(html).toContain(edited);
    expect(html).toContain('>Translate</button>');
  });
});
