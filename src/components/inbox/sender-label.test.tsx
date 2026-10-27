import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, type AbstractIntlMessages } from 'next-intl';

import en from '../../../messages/en.json';
import ko from '../../../messages/ko.json';
import type { Message } from '@/types';
import { memberNames } from '@/lib/inbox/sender';
import { MessageBubble } from './message-bubble';
import { useSenderLabels } from './sender-label';

// The words on each bubble's sender line, through the bubble that shows
// them. Which sender a row has is lib/inbox/sender.test.ts.

const NAMES = memberNames([
  { user_id: 'me-1', full_name: 'Bhoopal', email: 'b@example.com' },
  { user_id: 'agent-2', full_name: 'Sara Ahmed', email: 's@example.com' },
]);

const msg = (id: string, over: Partial<Message>): Message =>
  ({
    id,
    conversation_id: 'conv-1',
    sender_type: 'agent',
    content_type: 'text',
    content_text: `body ${id}`,
    status: 'sent',
    created_at: '2026-10-26T10:00:00.000Z',
    ...over,
  }) as Message;

const THREAD = [
  msg('c1', { sender_type: 'customer' }),
  msg('a1', { sender_id: 'agent-2' }),
  msg('a2', { sender_id: 'me-1' }),
  msg('b1', { sender_type: 'bot', ai_generated: true }),
  msg('b2', { sender_type: 'bot' }),
  msg('t1', {}),
  msg('g1', { sender_id: 'gone-9' }),
];

function Thread({ namesLoaded }: { namesLoaded: boolean }) {
  const label = useSenderLabels({
    contactName: 'Aisha',
    currentUserId: 'me-1',
    names: NAMES,
    namesLoaded,
  });
  return (
    <>
      {THREAD.map((m) => (
        <MessageBubble key={m.id} message={m} sender={label(m)} />
      ))}
    </>
  );
}

function render(
  messages: AbstractIntlMessages,
  locale: string,
  namesLoaded = true
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      <Thread namesLoaded={namesLoaded} />
    </NextIntlClientProvider>
  );
}

describe('sender line', () => {
  it('names the sender at the top of every bubble', () => {
    const html = render(en, 'en');
    const lines: [string, string][] = [
      ['Aisha', 'body c1'],
      ['Sara Ahmed', 'body a1'],
      ['Bhoopal (you)', 'body a2'],
      ['AI assistant', 'body b1'],
      ['Bot', 'body b2'],
      ['Team', 'body t1'],
      ['Unknown agent', 'body g1'],
    ];
    let from = 0;
    for (const [name, body] of lines) {
      const at = html.indexOf(`>${name}<`, from);
      expect(at, name).toBeGreaterThanOrEqual(0);
      expect(html.indexOf(body, at), body).toBeGreaterThan(at);
      from = html.indexOf(body, at);
    }
  });

  it('says why a line names no person', () => {
    const html = render(en, 'en');
    expect(html).toContain(
      'title="Sent by a flow, an automation or the journey bot"'
    );
    expect(html).toContain('title="Sent automatically by the AI assistant"');
    expect(html).toContain('a Compass notification, a public API send');
  });

  it('shows a name whole on hover, since the line may truncate it', () => {
    const html = render(en, 'en');
    expect(html).toContain('title="Sara Ahmed"');
    expect(html).toContain('title="Aisha"');
  });

  it('keeps the line blank, not "unknown", until the members load', () => {
    const html = render(en, 'en', false);
    expect(html).not.toContain('Unknown agent');
    expect(html).toContain('>Sara Ahmed<');
  });

  it('renders the Korean catalogue', () => {
    const html = render(ko, 'ko');
    for (const name of [
      'Bhoopal (나)',
      'AI 어시스턴트',
      '봇',
      '팀',
      '알 수 없는 상담원',
    ]) {
      expect(html).toContain(`>${name}<`);
    }
  });
});
