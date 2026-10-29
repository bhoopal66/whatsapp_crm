import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { ConversationEvent } from '@/types';
import { ThreadAutoTagNote } from './thread-auto-tag-note';

const EVENT: ConversationEvent = {
  id: 'e1',
  conversation_id: 'c1',
  kind: 'chat_tag_auto',
  actor_user_id: null,
  from_channel_id: null,
  to_channel_id: null,
  from_label: null,
  to_label: 'Interested · ADCB',
  details: { chat_tag_id: 't1', chat_sub_tag_id: 's1', p: 0.92 },
  created_at: '2026-10-29T09:05:00.000Z',
};

function render(
  over: Partial<ConversationEvent> = {},
  messages: AbstractIntlMessages = en as AbstractIntlMessages,
  locale = 'en'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ThreadAutoTagNote event={{ ...EVENT, ...over }} />
    </NextIntlClientProvider>
  );
}

describe('ThreadAutoTagNote', () => {
  it('names the tag as stored and Jev’s certainty', () => {
    const html = render();
    expect(html).toContain('Tagged automatically: Interested · ADCB · 92%');
    expect(html).toContain('role="note"');
  });

  it('without a probability it reads without a figure', () => {
    const html = render({ details: null });
    expect(html).toContain('Tagged automatically: Interested · ADCB<');
    expect(html).not.toContain('92%');
  });

  it('without a stored name it still says what happened', () => {
    const html = render({ to_label: null });
    expect(html).toContain('Tagged automatically');
    expect(html).not.toContain('Interested');
  });

  it('renders in Korean', () => {
    const html = render({}, ko as AbstractIntlMessages, 'ko');
    expect(html).toContain('Interested · ADCB');
    expect(html).toContain('92%');
    expect(html).not.toContain('Tagged automatically');
  });
});
