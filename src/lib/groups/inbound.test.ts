import { describe, expect, it } from 'vitest';

import { normalizeWhapiWebhook } from '@/lib/whatsapp/whapi-webhook';

import {
  extractWhapiGroupMessages,
  GROUP_STATUS_PREDECESSORS,
} from './inbound';

const GROUP = '120363025555555555@g.us';

function body(...messages: Record<string, unknown>[]) {
  return {
    messages,
    event: { type: 'messages', event: 'post' },
    channel_id: 'CHANNEL-1',
  };
}

describe('extractWhapiGroupMessages', () => {
  it('reads a group text message', () => {
    const out = extractWhapiGroupMessages(
      body({
        id: 'g-1',
        from_me: false,
        type: 'text',
        chat_id: GROUP,
        from: '971501234567',
        from_name: 'Ada',
        timestamp: 1700000000,
        text: { body: 'hello group' },
      })
    );
    expect(out).toEqual([
      {
        id: 'g-1',
        waGroupId: GROUP,
        fromMe: false,
        senderWaId: '971501234567',
        senderName: 'Ada',
        type: 'text',
        body: 'hello group',
        media: null,
        sentAt: new Date(1700000000 * 1000).toISOString(),
      },
    ]);
  });

  it('keeps media id, link, mime type and filename, and our own sends', () => {
    const [m] = extractWhapiGroupMessages(
      body({
        id: 'g-2',
        from_me: true,
        type: 'document',
        chat_id: GROUP,
        from: '15551230000@s.whatsapp.net',
        timestamp: '1700000001',
        document: {
          id: 'media-1',
          link: 'https://gate.whapi.cloud/media/1',
          mime_type: 'application/pdf',
          file_name: 'offer.pdf',
          file_size: 1234,
          caption: 'the offer',
        },
      })
    );
    expect(m.fromMe).toBe(true);
    expect(m.senderWaId).toBe('15551230000');
    expect(m.type).toBe('document');
    expect(m.body).toBe('the offer');
    expect(m.media).toEqual({
      id: 'media-1',
      link: 'https://gate.whapi.cloud/media/1',
      mime_type: 'application/pdf',
      filename: 'offer.pdf',
      file_size: 1234,
    });
  });

  it('keeps a hidden number as its LID', () => {
    const [m] = extractWhapiGroupMessages(
      body({
        id: 'g-3',
        type: 'text',
        chat_id: GROUP,
        from: '123456789012345@lid',
        text: { body: 'x' },
      })
    );
    expect(m.senderWaId).toBe('123456789012345@lid');
  });

  it('skips 1:1 chats, broadcast lists, reactions and actions', () => {
    const out = extractWhapiGroupMessages(
      body(
        {
          id: 'a',
          type: 'text',
          chat_id: '15551230000@s.whatsapp.net',
          text: { body: '1:1' },
        },
        {
          id: 'b',
          type: 'text',
          chat_id: 'status@broadcast',
          text: { body: 'list' },
        },
        {
          id: 'c',
          type: 'action',
          chat_id: GROUP,
          action: { type: 'reaction', target: 'g-1', emoji: '👍' },
        },
        { id: 'd', type: 'action', chat_id: GROUP, action: { type: 'delete' } },
        { type: 'text', chat_id: GROUP, text: { body: 'no id' } }
      )
    );
    expect(out).toEqual([]);
  });

  it('tolerates a body with no messages or junk items', () => {
    expect(extractWhapiGroupMessages(null)).toEqual([]);
    expect(extractWhapiGroupMessages({ messages: 'x' })).toEqual([]);
    expect(extractWhapiGroupMessages({ messages: [null, 3] })).toEqual([]);
  });

  it('is the only reader of group chats: the normaliser still drops them', () => {
    const raw = body({
      id: 'g-1',
      type: 'text',
      chat_id: GROUP,
      from: '971501234567',
      text: { body: 'hello group' },
    });
    expect(normalizeWhapiWebhook(raw).messages).toEqual([]);
    expect(extractWhapiGroupMessages(raw)).toHaveLength(1);
  });
});

describe('GROUP_STATUS_PREDECESSORS', () => {
  it('is forward-only, and failed only from pending/sent', () => {
    expect(GROUP_STATUS_PREDECESSORS.pending).toEqual([]);
    expect(GROUP_STATUS_PREDECESSORS.sent).toEqual(['pending']);
    expect(GROUP_STATUS_PREDECESSORS.delivered).toEqual(['pending', 'sent']);
    expect(GROUP_STATUS_PREDECESSORS.read).toEqual([
      'pending',
      'sent',
      'delivered',
    ]);
    expect(GROUP_STATUS_PREDECESSORS.failed).toEqual(['pending', 'sent']);
  });
});
