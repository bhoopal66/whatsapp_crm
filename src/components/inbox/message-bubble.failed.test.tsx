import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import en from '../../../messages/en.json';
import type { Message } from '@/types';

import { MessageBubble } from './message-bubble';

const BASE: Message = {
  id: 'm-1',
  conversation_id: 'c-1',
  sender_type: 'agent',
  content_type: 'template',
  content_text: 'Hello',
  status: 'failed',
  created_at: '2026-11-24T06:00:00Z',
};

function render(message: Message) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Dubai">
      <MessageBubble message={message} />
    </NextIntlClientProvider>
  );
}

describe('a message WhatsApp failed', () => {
  it('says why, in words', () => {
    const html = render({
      ...BASE,
      failure_reason: 'This person chose to stop. (Meta 131050)',
    });
    expect(html).toContain('Not delivered:');
    expect(html).toContain('This person chose to stop. (Meta 131050)');
  });

  it('says it was not delivered when the gateway gave no reason', () => {
    expect(render(BASE)).toContain('Not delivered.');
  });

  it('says nothing under a delivered one, a customer one or an unsent one', () => {
    expect(render({ ...BASE, status: 'delivered' })).not.toContain(
      'Not delivered'
    );
    expect(render({ ...BASE, sender_type: 'customer' })).not.toContain(
      'Not delivered'
    );
    expect(render({ ...BASE, id: 'temp-1' })).not.toContain('Not delivered');
  });
});
