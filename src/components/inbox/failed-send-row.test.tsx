import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { Message } from '@/types';
import type { FailedSend } from '@/lib/inbox/failed-send';
import { FailedSendRow } from './failed-send-row';

// The node test environment cannot click, so this pins what the agent
// sees: the words they wrote, that it was not sent, why, and the two
// ways out. The Retry/Discard behaviour lives in lib/inbox/failed-send.

const failed: FailedSend = {
  conversationId: 'conv-1',
  reason:
    'WhatsApp API error: This number (971581842504) is not connected to WhatsApp: waiting for a QR scan.',
  message: {
    id: 'temp-1',
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    content_text: 'Your application was approved',
    status: 'failed',
    created_at: '2026-09-29T10:41:04.000Z',
  } as Message,
  body: {
    conversation_id: 'conv-1',
    message_type: 'text',
    content_text: 'Your application was approved',
  },
  restoreText: 'Your application was approved',
};

function render(
  messages: AbstractIntlMessages,
  locale: string,
  props: Partial<React.ComponentProps<typeof FailedSendRow>> = {}
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <FailedSendRow
        failed={failed}
        parent={undefined}
        contactLabel="Customer"
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

describe('FailedSendRow', () => {
  it('shows the unsent words, the reason and both actions', () => {
    const html = render(en, 'en');
    expect(html).toContain('Your application was approved');
    expect(html).toContain('Not sent');
    expect(html).toContain('waiting for a QR scan');
    expect(html).toContain('Retry');
    expect(html).toContain('Discard');
  });

  it('renders the Korean catalogue', () => {
    const html = render(ko, 'ko');
    expect(html).toContain('전송되지 않음');
    expect(html).toContain('다시 시도');
    expect(html).toContain('버리기');
  });

  it('quotes the message it replied to when that is loaded', () => {
    const parent = {
      id: 'm-9',
      conversation_id: 'conv-1',
      sender_type: 'customer',
      content_type: 'text',
      content_text: 'Any news on my application?',
      status: 'read',
      created_at: '2026-09-29T10:30:00.000Z',
    } as Message;
    const html = render(en, 'en', {
      failed: {
        ...failed,
        message: { ...failed.message, reply_to_message_id: 'm-9' },
      },
      parent,
      contactLabel: 'Aisha',
    });
    expect(html).toContain('Any news on my application?');
    expect(html).toContain('Aisha');
  });
});
