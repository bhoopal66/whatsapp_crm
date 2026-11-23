import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

// The contact card opens the customer page through the app router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import en from '../../../../messages/en.json';
import { NEUTRAL_SENDER_COLOR, senderColors } from '@/lib/groups/sender-colors';

import { type GroupChatMessage, GroupMessageLog } from './message-log';

// Server-side render only (no DOM here): pins that the bubbles really wear
// the colours lib/groups/sender-colors.ts hands out, and on which side.

let nextId = 1;
const message = (over: Partial<GroupChatMessage>): GroupChatMessage => ({
  id: String(nextId++),
  direction: 'in',
  sender_wa_id: null,
  sender_name: null,
  type: 'text',
  body: 'Hello',
  status: null,
  created_at: '2026-11-05T09:00:00.000Z',
  ...over,
});

const staff = (userId: string, name: string) =>
  message({
    direction: 'out',
    sender_user_id: userId,
    sender_name: name,
    status: 'sent',
  });

function bubbles(messages: GroupChatMessage[], currentUserId: string | null) {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <GroupMessageLog messages={messages} currentUserId={currentUserId} />
    </NextIntlClientProvider>
  );
  const found = [
    ...html.matchAll(
      /<div class="([^"]*max-w-\[85%\][^"]*)"><p class="([^"]*)">([^<]*)</g
    ),
  ];
  expect(found).toHaveLength(messages.length);
  return found.map(([, bubble, line, name]) => ({ bubble, line, name }));
}

describe('GroupMessageLog', () => {
  it('gives each staff member and each number their own colour', () => {
    const messages = [
      staff('user-1', 'Sara'),
      staff('user-2', 'Omar'),
      message({ sender_wa_id: '971500000001', sender_name: 'Khalid' }),
      message({ sender_wa_id: '971500000002' }),
      // Sent from the phone itself: our number, and no CRM user.
      message({
        direction: 'out',
        sender_wa_id: '971500005679',
        sender_name: 'Taamul Credit',
        status: 'read',
      }),
    ];
    const colorOf = senderColors(messages);
    const shown = bubbles(messages, null);

    messages.forEach((m, i) => {
      const color = colorOf(m);
      expect(shown[i].bubble).toContain(color.stripe);
      expect(shown[i].line).toContain(
        m.direction === 'out' ? color.textOut : color.text
      );
    });
    expect(new Set(messages.map(colorOf)).size).toBe(messages.length);
  });

  it('keeps a person in one colour across their messages', () => {
    const shown = bubbles(
      [
        staff('user-1', 'Sara'),
        message({ sender_wa_id: '971500000001' }),
        staff('user-1', 'Sara'),
      ],
      null
    );
    expect(shown[2].bubble).toBe(shown[0].bubble);
    expect(shown[2].line).toBe(shown[0].line);
  });

  it('puts the edge on the outer side of the bubble', () => {
    const [ours, theirs] = bubbles(
      [staff('user-1', 'Sara'), message({ sender_wa_id: '971500000001' })],
      null
    );
    expect(ours.bubble).toContain('border-e-4');
    expect(theirs.bubble).toContain('border-s-4');
  });

  it('leaves a sender nothing identifies out of the people’s colours', () => {
    const [nobody] = bubbles([message({})], null);
    expect(nobody.bubble).toContain(NEUTRAL_SENDER_COLOR.stripe);
    expect(nobody.name).toBe('Someone');
  });

  it('still marks the viewer’s own messages', () => {
    const [mine, theirs] = bubbles(
      [staff('user-1', 'Sara'), staff('user-2', 'Omar')],
      'user-1'
    );
    expect(mine.name).toBe('Sara (you)');
    expect(theirs.name).toBe('Omar');
  });
});

describe('GroupMessageLog attachments', () => {
  const render = (m: GroupChatMessage) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
        <GroupMessageLog messages={[m]} currentUserId={null} />
      </NextIntlClientProvider>
    );
  const LINK = 'https://s3.eu-central-1.wasabisys.com/in-files/1/cv.pdf';

  it('shows a document as a card that opens the file, like the inbox', () => {
    const html = render(
      message({
        type: 'document',
        body: 'CV Ahmed.pdf',
        media: {
          link: LINK,
          filename: 'CV Ahmed.pdf',
          mime_type: 'application/pdf',
          file_size: 102400,
        },
      })
    );
    expect(html).toContain(`href="${LINK}"`);
    expect(html).toContain('CV Ahmed.pdf');
    expect(html).toContain('100 KB');
    expect(html).toContain('aria-label="Download"');
  });

  it('shows a photo as an image', () => {
    const html = render(
      message({ type: 'image', body: null, media: { link: LINK } })
    );
    expect(html).toContain(`<img src="${LINK}"`);
  });

  it('says the file is unavailable when there is no link', () => {
    const html = render(
      message({
        type: 'document',
        body: 'old.pdf',
        media: { filename: 'old.pdf' },
      })
    );
    expect(html).not.toContain('href=');
    expect(html).toContain('old.pdf unavailable');
  });

  it('shows a shared contact as a card with its number and Save', () => {
    const html = render(
      message({
        type: 'contacts',
        body: 'Contact: Omar Khalid',
        media: {
          contacts: [
            {
              name: 'Omar Khalid',
              phones: ['+971 50 987 6543'],
              emails: [],
              org: null,
            },
          ],
        },
      })
    );
    expect(html).toContain('Omar Khalid');
    expect(html).toContain('+971 50 987 6543');
    expect(html).toContain('Save to contacts');
    expect(html).not.toContain('Contact: Omar Khalid');
  });
});
