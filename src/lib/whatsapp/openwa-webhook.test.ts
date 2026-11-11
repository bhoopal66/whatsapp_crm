import { describe, expect, it } from 'vitest';

import {
  normalizeOpenWAWebhook,
  type RawOpenWAMessage,
} from './openwa-webhook';

const SESSION = 'taamul-sales';

/** A `message.received` envelope as OpenWA 0.25 posts it (§6.6). */
function received(data: Partial<RawOpenWAMessage>) {
  return {
    event: 'message.received',
    timestamp: '2026-10-28T08:00:05.000Z',
    sessionId: SESSION,
    idempotencyKey: `msg_${SESSION}_3EB0ABC123_f1e2d3c4`,
    deliveryId: 'dlv_550e8400-e29b-41d4-a716-446655440000',
    data: {
      id: 'false_971501234567@c.us_3EB0ABC123',
      from: '971501234567@c.us',
      to: '971558233531@c.us',
      body: 'Hello, is the loan still available?',
      type: 'text',
      timestamp: 1793174400,
      isGroup: false,
      kind: 'individual',
      fromMe: false,
      chatId: '971501234567@c.us',
      contact: { name: 'Ada (saved)', pushName: 'Ada' },
      ...data,
    },
  };
}

function ack(event: string, data: Record<string, unknown>) {
  return {
    event,
    timestamp: '2026-10-28T08:00:05.000Z',
    sessionId: SESSION,
    idempotencyKey: 'ack_1',
    deliveryId: 'dlv_1',
    data,
  };
}

describe('normalizeOpenWAWebhook — messages', () => {
  it('maps a 1:1 text message onto the neutral shape', () => {
    const out = normalizeOpenWAWebhook(received({}));
    expect(out.channelId).toBe(SESSION);
    expect(out.eventType).toBe('message.received');
    expect(out.statuses).toEqual([]);
    expect(out.messages).toEqual([
      {
        id: 'false_971501234567@c.us_3EB0ABC123',
        from: '971501234567',
        chatId: '971501234567@c.us',
        fromName: 'Ada',
        timestamp: '1793174400',
        type: 'text',
        text: 'Hello, is the loan still available?',
        media: null,
        location: null,
        reaction: null,
        contacts: null,
        interactiveReplyId: null,
        interactiveReplyTitle: null,
        contextMessageId: null,
        forwarded: false,
        fromMe: false,
        isGroup: false,
        freeEntry: false,
      },
    ]);
  });

  it('falls back to the saved name, then to none', () => {
    expect(
      normalizeOpenWAWebhook(received({ contact: { name: 'Ada (saved)' } }))
        .messages[0].fromName
    ).toBe('Ada (saved)');
    expect(
      normalizeOpenWAWebhook(received({ contact: undefined })).messages[0]
        .fromName
    ).toBeNull();
  });

  it('carries the quoted message id as the reply context', () => {
    const out = normalizeOpenWAWebhook(
      received({
        quotedMessage: { id: 'true_971501234567@c.us_3EB0OUT1', body: 'Offer' },
      })
    );
    expect(out.messages[0].contextMessageId).toBe(
      'true_971501234567@c.us_3EB0OUT1'
    );
  });

  it('drops the number’s own sends', () => {
    const out = normalizeOpenWAWebhook(received({ fromMe: true }));
    expect(out.messages).toEqual([]);
    expect(out.unmappedLidSenders).toBe(0);
  });

  it.each([
    ['group', '120363025555555555@g.us'],
    ['status', 'status@broadcast'],
    ['channel', '120363111111111111@newsletter'],
    ['broadcast', '1700000000@broadcast'],
    ['unknown', 'odd-id'],
  ])('drops a %s chat', (kind, chatId) => {
    const out = normalizeOpenWAWebhook(
      received({ kind, chatId, isGroup: kind === 'group', from: chatId })
    );
    expect(out.messages).toEqual([]);
  });

  it('reads kind from the chat id when an older gateway omits it', () => {
    expect(
      normalizeOpenWAWebhook(
        received({
          kind: undefined,
          isGroup: true,
          chatId: '1203@g.us',
          from: '1203@g.us',
        })
      ).messages
    ).toEqual([]);
    expect(
      normalizeOpenWAWebhook(received({ kind: undefined })).messages
    ).toHaveLength(1);
  });

  it('takes an @lid sender’s phone from senderPhone', () => {
    const out = normalizeOpenWAWebhook(
      received({
        from: '210987654321098@lid',
        chatId: '210987654321098@lid',
        senderPhone: '971509876543',
      })
    );
    expect(out.messages[0].from).toBe('971509876543');
    expect(out.messages[0].chatId).toBe('210987654321098@lid');
  });

  it('drops and counts an @lid sender the gateway could not map', () => {
    for (const senderPhone of [undefined, null, '']) {
      const out = normalizeOpenWAWebhook(
        received({
          from: '210987654321098@lid',
          chatId: '210987654321098@lid',
          senderPhone,
        })
      );
      expect(out.messages).toEqual([]);
      expect(out.unmappedLidSenders).toBe(1);
    }
  });

  it('maps an image to a gateway-resolved media handle, never the inline data', () => {
    const out = normalizeOpenWAWebhook(
      received({
        type: 'image',
        body: 'my salary certificate',
        media: {
          mimetype: 'image/jpeg',
          data: '/9j/4AAQSkZJRg==',
          sizeBytes: 48211,
        },
      })
    );
    expect(out.messages[0]).toMatchObject({
      type: 'image',
      text: 'my salary certificate',
      media: {
        id: '971501234567@c.us/false_971501234567@c.us_3EB0ABC123',
        link: null,
        mimeType: 'image/jpeg',
        filename: null,
        fileSize: 48211,
      },
    });
  });

  it('maps an omitted (over-cap) document with its filename', () => {
    const out = normalizeOpenWAWebhook(
      received({
        type: 'document',
        body: '',
        media: {
          mimetype: 'application/pdf',
          filename: 'statement.pdf',
          omitted: true,
          sizeBytes: 2_400_000,
        },
      })
    );
    expect(out.messages[0]).toMatchObject({
      type: 'document',
      text: null,
      media: {
        mimeType: 'application/pdf',
        filename: 'statement.pdf',
        fileSize: 2_400_000,
      },
    });
  });

  it.each(['audio', 'voice'])('stores %s as audio', (type) => {
    const out = normalizeOpenWAWebhook(
      received({
        type,
        body: '',
        media: { mimetype: 'audio/ogg; codecs=opus' },
      })
    );
    expect(out.messages[0].type).toBe('audio');
    expect(out.messages[0].media?.fileSize).toBeNull();
  });

  it('maps video and sticker', () => {
    expect(
      normalizeOpenWAWebhook(
        received({ type: 'video', media: { mimetype: 'video/mp4' } })
      ).messages[0].type
    ).toBe('video');
    expect(
      normalizeOpenWAWebhook(
        received({
          type: 'sticker',
          body: '',
          media: { mimetype: 'image/webp' },
        })
      ).messages[0]
    ).toMatchObject({ type: 'sticker', text: null });
  });

  it('maps a location', () => {
    const out = normalizeOpenWAWebhook(
      received({
        type: 'location',
        body: '',
        location: {
          latitude: 25.2048,
          longitude: 55.2708,
          description: 'Office',
          address: 'Sheikh Zayed Rd',
        },
      })
    );
    expect(out.messages[0]).toMatchObject({
      type: 'location',
      location: {
        latitude: 25.2048,
        longitude: 55.2708,
        name: 'Office',
        address: 'Sheikh Zayed Rd',
      },
    });
    expect(
      normalizeOpenWAWebhook(
        received({ type: 'location', location: undefined })
      ).messages
    ).toEqual([]);
  });

  it('parses a shared contact card from the vCard body', () => {
    const vcard = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:Omar Khalid',
      'TEL;type=CELL;waid=971551112233:+971 55 111 2233',
      'END:VCARD',
    ].join('\n');
    const out = normalizeOpenWAWebhook(
      received({ type: 'contact', body: vcard })
    );
    expect(out.messages[0].type).toBe('contacts');
    expect(out.messages[0].contacts?.[0].name).toBe('Omar Khalid');
    expect(out.messages[0].text).toContain('Omar Khalid');
  });

  it.each([
    'poll',
    'call',
    'revoked',
    'order',
    'product',
    'masked',
    'unknown',
    'e2e_notification',
  ])('drops a %s message', (type) => {
    expect(normalizeOpenWAWebhook(received({ type })).messages).toEqual([]);
  });

  it('drops an empty text and a message without an id', () => {
    expect(normalizeOpenWAWebhook(received({ body: '' })).messages).toEqual([]);
    expect(
      normalizeOpenWAWebhook(received({ id: undefined })).messages
    ).toEqual([]);
  });
});

describe('normalizeOpenWAWebhook — acks', () => {
  const sent = 'true_971501234567@c.us_3EB0OUT1';

  it.each(['pending', 'sent', 'delivered', 'read', 'failed'])(
    'maps %s',
    (status) => {
      const out = normalizeOpenWAWebhook(
        ack('message.ack', {
          id: sent,
          messageId: sent,
          status,
          ack: 2,
          chatId: '971501234567@c.us',
        })
      );
      expect(out.messages).toEqual([]);
      expect(out.statuses).toEqual([
        {
          messageId: sent,
          status,
          recipientPhone: '971501234567',
          timestamp: String(Date.parse('2026-10-28T08:00:05.000Z') / 1000),
        },
      ]);
    }
  );

  it('maps message.failed the same way', () => {
    const out = normalizeOpenWAWebhook(
      ack('message.failed', {
        id: sent,
        messageId: sent,
        status: 'failed',
        ack: -1,
      })
    );
    expect(out.statuses).toMatchObject([
      { messageId: sent, status: 'failed', recipientPhone: '' },
    ]);
  });

  it('reports no phone for an @lid chat', () => {
    const out = normalizeOpenWAWebhook(
      ack('message.ack', {
        messageId: sent,
        status: 'read',
        chatId: '2109876@lid',
      })
    );
    expect(out.statuses[0].recipientPhone).toBe('');
  });

  it('skips an ack with an unknown status or no id', () => {
    expect(
      normalizeOpenWAWebhook(
        ack('message.ack', { messageId: sent, status: 'played' })
      ).statuses
    ).toEqual([]);
    expect(
      normalizeOpenWAWebhook(ack('message.ack', { status: 'read' })).statuses
    ).toEqual([]);
  });
});

describe('normalizeOpenWAWebhook — other events', () => {
  it.each([
    ['session.status', { sessionId: SESSION, status: 'ready' }],
    ['session.qr', { sessionId: SESSION, qr: 'data:image/png;base64,AAAA' }],
    [
      'message.reaction',
      { messageId: 'x', chatId: '1@c.us', reaction: '👍', senderId: '1@c.us' },
    ],
    ['group.join', { groupId: '1@g.us', participantIds: [] }],
  ])('ignores %s', (event, data) => {
    const out = normalizeOpenWAWebhook({ event, sessionId: SESSION, data });
    expect(out).toMatchObject({
      messages: [],
      statuses: [],
      unmappedLidSenders: 0,
    });
  });

  it('survives a body with no data', () => {
    expect(
      normalizeOpenWAWebhook({ event: 'message.received', sessionId: SESSION })
    ).toMatchObject({
      channelId: SESSION,
      messages: [],
      statuses: [],
    });
  });
});

describe('normalizeOpenWAWebhook — own sends (message.sent)', () => {
  function sent(data: Record<string, unknown>) {
    const base = received({}) as { data: Record<string, unknown> };
    return {
      ...base,
      event: 'message.sent',
      data: {
        ...base.data,
        from: '971558233531@c.us',
        to: '971501234567@c.us',
        chatId: '971501234567@c.us',
        body: 'typed on the phone',
        fromMe: true,
        ...data,
      },
    };
  }

  it('files message.sent under ownSends, not messages', () => {
    const out = normalizeOpenWAWebhook(sent({}));
    expect(out.messages).toEqual([]);
    expect(out.ownSends).toEqual([
      {
        id: 'false_971501234567@c.us_3EB0ABC123',
        peerPhone: '971501234567',
        peerLid: null,
        text: 'typed on the phone',
        timestamp: '1793174400',
      },
    ]);
  });

  it('still drops a fromMe message.received', () => {
    const out = normalizeOpenWAWebhook(
      received({ fromMe: true, to: '971501234567@c.us' })
    );
    expect(out.messages).toEqual([]);
    expect(out.ownSends).toEqual([]);
  });

  it('carries an @lid peer as peerLid with no phone', () => {
    const out = normalizeOpenWAWebhook(
      sent({ to: '123456789@lid', chatId: '123456789@lid' })
    );
    expect(out.ownSends).toHaveLength(1);
    expect(out.ownSends[0].peerLid).toBe('123456789@lid');
    expect(out.ownSends[0].peerPhone).toBeNull();
  });

  it('stores an image as [photo] plus its caption', () => {
    const out = normalizeOpenWAWebhook(
      sent({ type: 'image', body: 'the brochure' })
    );
    expect(out.ownSends[0].text).toBe('[photo] the brochure');
  });

  it('drops a group own send', () => {
    const out = normalizeOpenWAWebhook(
      sent({
        isGroup: true,
        kind: 'group',
        to: '120363@g.us',
        chatId: '120363@g.us',
      })
    );
    expect(out.ownSends).toEqual([]);
    expect(out.messages).toEqual([]);
  });
});
