import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import { NEUTRAL_SENDER_COLOR, senderColors } from '@/lib/groups/sender-colors';
import type { GroupMessage } from '@/lib/submission-groups/store';
import type { SgMessage } from '@/lib/submission-groups/ui';
import { toMessageView } from '@/lib/submission-groups/views';

import { MessageList } from './message-list';

// Server-side render only (no DOM here): pins that the bubbles really wear
// the colours lib/groups/sender-colors.ts hands out, and on which side.

let nextId = 1;
const message = (over: Partial<SgMessage>): SgMessage => ({
  id: String(nextId++),
  direction: 'in',
  sender_user_id: null,
  sender_name: null,
  sender_wa_id: null,
  sender_kind: null,
  body: 'Hello',
  prefixed_body: null,
  send_status: null,
  post_end: false,
  type: 'text',
  media: null,
  created_at: '2026-11-05T09:00:00.000Z',
  ...over,
});

const staff = (userId: string, name: string) =>
  message({
    direction: 'out',
    sender_user_id: userId,
    sender_name: name,
    send_status: 'sent',
  });

const phone = (waId: string, kind: 'customer' | 'coordinator') =>
  message({ sender_wa_id: waId, sender_kind: kind });

/** Each bubble's class list, in order, with the name line's after it. */
function bubbles(messages: SgMessage[]) {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <MessageList messages={messages} />
    </NextIntlClientProvider>
  );
  const found = [
    ...html.matchAll(
      /<div class="([^"]*max-w-\[85%\][^"]*)"><p class="([^"]*)"/g
    ),
  ];
  expect(found).toHaveLength(messages.length);
  return found.map(([, bubble, name]) => ({ bubble, name }));
}

describe('MessageList', () => {
  it('gives each staff member and each number their own colour', () => {
    const messages = [
      staff('user-1', 'Sara'),
      staff('user-2', 'Omar'),
      phone('971500000001', 'customer'),
      phone('971500000002', 'coordinator'),
    ];
    const colorOf = senderColors(messages);
    const shown = bubbles(messages);

    messages.forEach((m, i) => {
      const color = colorOf(m);
      expect(shown[i].bubble).toContain(color.stripe);
      expect(shown[i].name).toContain(
        m.direction === 'out' ? color.textOut : color.text
      );
    });
    expect(new Set(messages.map(colorOf)).size).toBe(4);
  });

  it('keeps a person in one colour across their messages', () => {
    const shown = bubbles([
      staff('user-1', 'Sara'),
      phone('971500000001', 'customer'),
      staff('user-1', 'Sara'),
    ]);
    expect(shown[2]).toEqual(shown[0]);
  });

  it('puts the edge on the outer side of the bubble', () => {
    const [ours, theirs] = bubbles([
      staff('user-1', 'Sara'),
      phone('971500000001', 'customer'),
    ]);
    expect(ours.bubble).toContain('border-e-4');
    expect(theirs.bubble).toContain('border-s-4');
  });

  // What the read routes answer, not a hand-made view: that is the shape
  // every screen gets, and a sender it loses turns grey on all of them.
  it('colours the messages the read routes answer', () => {
    const stored: GroupMessage = {
      id: '1',
      direction: 'in',
      senderUserId: null,
      senderWaId: '971500000001',
      senderKind: 'customer',
      type: 'text',
      body: 'Hello',
      prefixedBody: null,
      media: null,
      waMessageId: 'wamid.1',
      sendStatus: null,
      postEnd: false,
      createdAt: new Date('2026-11-05T09:00:00.000Z'),
      waTimestamp: null,
    };
    const answered = JSON.parse(
      JSON.stringify([
        toMessageView(stored, new Map()),
        toMessageView(
          {
            ...stored,
            id: '2',
            direction: 'out',
            senderUserId: 'user-1',
            senderWaId: null,
            senderKind: null,
            prefixedBody: 'Sara (Agent): Hello',
            sendStatus: 'sent',
          },
          new Map([['user-1', 'Sara']])
        ),
      ])
    ) as SgMessage[];

    const shown = bubbles(answered);
    const colorOf = senderColors(answered);
    expect(colorOf(answered[0])).not.toBe(NEUTRAL_SENDER_COLOR);
    expect(colorOf(answered[1])).not.toBe(NEUTRAL_SENDER_COLOR);
    expect(shown[0].bubble).toContain(colorOf(answered[0]).stripe);
    expect(shown[1].bubble).toContain(colorOf(answered[1]).stripe);
  });

  it('leaves an automatic message out of the people’s colours', () => {
    const [automatic] = bubbles([
      message({
        direction: 'out',
        system_kind: 'welcome',
        send_status: 'sent',
      }),
    ]);
    expect(automatic.bubble).toContain(NEUTRAL_SENDER_COLOR.stripe);
    expect(automatic.name).toContain(NEUTRAL_SENDER_COLOR.textOut);
  });
});
