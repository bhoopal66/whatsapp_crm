import { describe, it, expect } from 'vitest';

import {
  isTemplateStatusPayload,
  normalizeMetaMessage,
  normalizeMetaStatus,
  normalizeMetaWebhook,
  type RawMetaWebhookPayload,
} from './meta-webhook';

/**
 * Fixtures follow Meta's published Cloud API webhook examples rather
 * than being invented, so a shape change on their side surfaces here
 * rather than as an empty inbox in production.
 */

const CONTACTS = [{ wa_id: '15551234567', profile: { name: 'Jane Doe' } }];

const BASE = {
  id: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTVGN0E=',
  from: '15551234567',
  timestamp: '1712995245',
};

/** Wrap a `value` in the entry/changes envelope Meta actually posts. */
function envelope(value: Record<string, unknown>): RawMetaWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [{ field: 'messages', value: value as never }],
      },
    ],
  };
}

describe('normalizeMetaMessage — content types', () => {
  it('maps a plain text message and zips the profile name by wa_id', () => {
    const m = normalizeMetaMessage(
      { ...BASE, type: 'text', text: { body: 'Hello world' } },
      CONTACTS
    );
    expect(m).toMatchObject({
      id: BASE.id,
      type: 'text',
      text: 'Hello world',
      from: '15551234567',
      fromName: 'Jane Doe',
      timestamp: '1712995245',
      // The Cloud API never echoes our sends and has no groups, so both
      // filters the Whapi normaliser needs are structurally moot.
      fromMe: false,
      isGroup: false,
    });
  });

  it('synthesises a chat id so downstream chat-id parsing works on both providers', () => {
    const m = normalizeMetaMessage(
      { ...BASE, type: 'text', text: { body: 'hi' } },
      []
    );
    expect(m?.chatId).toBe('15551234567@s.whatsapp.net');
  });

  it('falls back to a null display name when contacts carry no match', () => {
    const m = normalizeMetaMessage(
      { ...BASE, type: 'text', text: { body: 'hi' } },
      [{ wa_id: '99999999999', profile: { name: 'Someone Else' } }]
    );
    expect(m?.fromName).toBeNull();
  });

  it('maps an image, exposing the media id with a NULL link', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'image',
        image: {
          id: 'MEDIA_123',
          mime_type: 'image/jpeg',
          caption: 'the receipt',
        },
      },
      CONTACTS
    );
    expect(m).toMatchObject({ type: 'image', text: 'the receipt' });
    // Meta hands over an id, never a URL — the route exchanges it via
    // GET /{media-id}. A non-null link here would skip that.
    expect(m?.media).toEqual({
      id: 'MEDIA_123',
      mimeType: 'image/jpeg',
      link: null,
      filename: null,
      fileSize: null,
    });
  });

  it('carries a document filename and a numeric file size', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'document',
        document: {
          id: 'DOC_1',
          mime_type: 'application/pdf',
          filename: 'invoice.pdf',
          file_size: '20480',
        },
      },
      CONTACTS
    );
    expect(m?.media).toMatchObject({
      filename: 'invoice.pdf',
      fileSize: 20480,
    });
  });

  it('maps a location', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'location',
        location: {
          latitude: 12.34,
          longitude: 56.78,
          name: 'HQ',
          address: '1 Road',
        },
      },
      CONTACTS
    );
    expect(m?.location).toEqual({
      latitude: 12.34,
      longitude: 56.78,
      name: 'HQ',
      address: '1 Road',
    });
  });

  it('maps a reaction, and an empty emoji means the reaction was removed', () => {
    const added = normalizeMetaMessage(
      {
        ...BASE,
        type: 'reaction',
        reaction: { message_id: 'wamid.TARGET', emoji: '👍' },
      },
      CONTACTS
    );
    expect(added).toMatchObject({
      type: 'reaction',
      reaction: { targetMessageId: 'wamid.TARGET', emoji: '👍' },
    });

    const removed = normalizeMetaMessage(
      { ...BASE, type: 'reaction', reaction: { message_id: 'wamid.TARGET' } },
      CONTACTS
    );
    expect(removed?.reaction).toEqual({
      targetMessageId: 'wamid.TARGET',
      emoji: '',
    });
  });

  it('drops a message with no id or no sender', () => {
    expect(
      normalizeMetaMessage({ from: '15551234567', type: 'text' }, [])
    ).toBeNull();
    expect(
      normalizeMetaMessage({ id: 'wamid.X', type: 'text' }, [])
    ).toBeNull();
  });
});

describe('normalizeMetaMessage — the two button-reply envelopes (issue #478)', () => {
  it('reads a tap on an INTERACTIVE message from interactive.button_reply', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'opt_yes', title: 'Yes please' },
        },
      },
      CONTACTS
    );
    expect(m).toMatchObject({
      type: 'interactive',
      interactiveReplyId: 'opt_yes',
      interactiveReplyTitle: 'Yes please',
      text: 'Yes please',
    });
  });

  it('reads a tap on a TEMPLATE quick-reply from the separate `button` envelope', () => {
    // This is the shape that regressed in #478: a different object with
    // `payload`/`text` instead of `id`/`title`. Handling only the
    // interactive envelope silently ignores every template button tap.
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'button',
        button: { payload: 'opt_stop', text: 'Stop messages' },
        context: { id: 'wamid.TEMPLATE_WE_SENT' },
      },
      CONTACTS
    );
    expect(m).toMatchObject({
      type: 'interactive',
      interactiveReplyId: 'opt_stop',
      interactiveReplyTitle: 'Stop messages',
      contextMessageId: 'wamid.TEMPLATE_WE_SENT',
    });
  });

  it('reads a list selection from interactive.list_reply', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: {
            id: 'row_3',
            title: 'Billing',
            description: 'Invoices',
          },
        },
      },
      CONTACTS
    );
    expect(m).toMatchObject({
      interactiveReplyId: 'row_3',
      interactiveReplyTitle: 'Billing',
    });
  });

  it('records a swipe-reply parent as contextMessageId', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'text',
        text: { body: 'this one' },
        context: { id: 'wamid.PARENT' },
      },
      CONTACTS
    );
    expect(m?.contextMessageId).toBe('wamid.PARENT');
  });
});

describe('normalizeMetaStatus', () => {
  it.each([
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['read', 'read'],
    ['failed', 'failed'],
  ])('maps %s onto the messages.status CHECK value %s', (input, expected) => {
    const s = normalizeMetaStatus({
      id: 'wamid.OUT',
      status: input,
      timestamp: '1712995245',
      recipient_id: '15551234567',
    });
    expect(s).toMatchObject({ messageId: 'wamid.OUT', status: expected });
  });

  it('drops statuses the ladder does not model', () => {
    expect(
      normalizeMetaStatus({ id: 'wamid.X', status: 'deleted' })
    ).toBeNull();
    expect(
      normalizeMetaStatus({ id: 'wamid.X', status: 'warning' })
    ).toBeNull();
  });

  it('drops a status with no message id', () => {
    expect(normalizeMetaStatus({ status: 'read' })).toBeNull();
  });

  it('normalises the recipient to digits only', () => {
    const s = normalizeMetaStatus({
      id: 'wamid.OUT',
      status: 'read',
      recipient_id: '+1 (555) 123-4567',
    });
    expect(s?.recipientPhone).toBe('15551234567');
  });
});

describe('normalizeMetaWebhook — envelope', () => {
  it('extracts phone_number_id as the tenancy routing key', () => {
    const event = normalizeMetaWebhook(
      envelope({
        metadata: {
          display_phone_number: '15550001111',
          phone_number_id: '109876543210',
        },
        contacts: CONTACTS,
        messages: [{ ...BASE, type: 'text', text: { body: 'hi' } }],
      })
    );
    expect(event.channelId).toBe('109876543210');
    expect(event.messages).toHaveLength(1);
  });

  it('flattens messages and statuses across several entries and changes', () => {
    const event = normalizeMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '109876543210' },
                contacts: CONTACTS,
                messages: [{ ...BASE, type: 'text', text: { body: 'one' } }],
              },
            },
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '109876543210' },
                statuses: [
                  {
                    id: 'wamid.A',
                    status: 'delivered',
                    recipient_id: '15551234567',
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event.messages).toHaveLength(1);
    expect(event.statuses).toHaveLength(1);
  });

  it('drops unsupported types rather than inserting a blank bubble', () => {
    const event = normalizeMetaWebhook(
      envelope({
        metadata: { phone_number_id: '109876543210' },
        messages: [
          { ...BASE, type: 'unsupported', errors: [{ code: 131051 }] },
          { ...BASE, id: 'wamid.OK', type: 'text', text: { body: 'kept' } },
        ],
      })
    );
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0].text).toBe('kept');
  });

  it('ignores non-message changes such as template review results', () => {
    const event = normalizeMetaWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'W1',
          changes: [
            {
              field: 'message_template_status_update',
              value: { messaging_product: 'whatsapp' },
            },
          ],
        },
      ],
    });
    expect(event.messages).toHaveLength(0);
    expect(event.statuses).toHaveLength(0);
  });

  it('survives an empty or malformed payload without throwing', () => {
    expect(normalizeMetaWebhook({}).messages).toHaveLength(0);
    expect(normalizeMetaWebhook({ entry: [] }).channelId).toBeNull();
    expect(
      normalizeMetaWebhook({ entry: [{ changes: [{}] }] }).messages
    ).toHaveLength(0);
  });
});

describe('isTemplateStatusPayload', () => {
  it('detects a template review callback so it can be routed away from the inbox', () => {
    expect(
      isTemplateStatusPayload({
        entry: [
          { changes: [{ field: 'message_template_status_update', value: {} }] },
        ],
      })
    ).toBe(true);
  });

  it('is false for an ordinary message callback', () => {
    expect(
      isTemplateStatusPayload(
        envelope({ metadata: { phone_number_id: '1' }, messages: [] })
      )
    ).toBe(false);
  });
});
