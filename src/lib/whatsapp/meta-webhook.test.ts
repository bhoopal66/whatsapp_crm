import { describe, it, expect } from 'vitest';

import {
  collectMetaStatuses,
  isTemplateWebhookPayload,
  normalizeMetaMessage,
  normalizeMetaStatus,
  isMetaWebhookShape,
  metaPhoneNumberIds,
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

describe('normalizeMetaMessage — contact cards', () => {
  it('keeps the structured card the Cloud API sends', () => {
    const m = normalizeMetaMessage(
      {
        ...BASE,
        type: 'contacts',
        contacts: [
          {
            name: { formatted_name: 'Ahmed Al Mansoori', first_name: 'Ahmed' },
            phones: [{ phone: '+971 50 123 4567', type: 'CELL', wa_id: '971501234567' }],
            emails: [{ email: 'ahmed@dargol.ae' }],
            org: { company: 'Dargol Logistics FZE' },
          },
        ],
      },
      CONTACTS
    );
    expect(m).toMatchObject({
      type: 'contacts',
      text: 'Contact: Ahmed Al Mansoori',
      contacts: [
        {
          name: 'Ahmed Al Mansoori',
          phones: ['+971 50 123 4567'],
          emails: ['ahmed@dargol.ae'],
          org: 'Dargol Logistics FZE',
        },
      ],
    });
  });

  it('leaves contacts null on every other message type', () => {
    const m = normalizeMetaMessage(
      { ...BASE, type: 'text', text: { body: 'hi' } },
      CONTACTS
    );
    expect(m?.contacts).toBeNull();
  });
});

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

  it('flags a forwarded message, which carries no quote id', () => {
    const forwarded = normalizeMetaMessage(
      {
        ...BASE,
        type: 'text',
        text: { body: 'pass it on' },
        context: { forwarded: true },
      },
      CONTACTS
    );
    const frequently = normalizeMetaMessage(
      {
        ...BASE,
        type: 'text',
        text: { body: 'pass it on' },
        context: { frequently_forwarded: true },
      },
      CONTACTS
    );
    const plain = normalizeMetaMessage(
      { ...BASE, type: 'text', text: { body: 'hi' } },
      CONTACTS
    );
    expect(forwarded).toMatchObject({ forwarded: true, contextMessageId: null });
    expect(frequently?.forwarded).toBe(true);
    expect(plain?.forwarded).toBe(false);
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

  it("carries the first error of a failed receipt — Meta's example shape", () => {
    const s = normalizeMetaStatus({
      id: 'wamid.OUT',
      status: 'failed',
      timestamp: '1712995245',
      recipient_id: '15551234567',
      errors: [
        {
          code: 131026,
          title: 'Message undeliverable',
          message: 'Message undeliverable',
          error_data: {
            details: 'Message Undeliverable.',
          },
        },
        { code: 1, title: 'second error is ignored' },
      ],
    });
    expect(s?.error).toEqual({
      code: 131026,
      title: 'Message undeliverable',
      details: 'Message Undeliverable.',
    });
  });

  it('keeps only the error fields that are present', () => {
    const s = normalizeMetaStatus({
      id: 'wamid.OUT',
      status: 'failed',
      errors: [{ code: 131049 }],
    });
    expect(s?.error).toEqual({ code: 131049 });
  });

  it('leaves error unset when there is none (or it is empty)', () => {
    const plain = normalizeMetaStatus({ id: 'wamid.OUT', status: 'delivered' });
    expect(plain).not.toHaveProperty('error');
    const empty = normalizeMetaStatus({
      id: 'wamid.OUT',
      status: 'failed',
      errors: [{}],
    });
    expect(empty).not.toHaveProperty('error');
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

describe('isTemplateWebhookPayload', () => {
  it('detects a template review callback so it can be routed away from the inbox', () => {
    expect(
      isTemplateWebhookPayload({
        entry: [
          { changes: [{ field: 'message_template_status_update', value: {} }] },
        ],
      })
    ).toBe(true);
  });

  it.each([
    'message_template_quality_update',
    'message_template_components_update',
  ])('detects a %s-only callback too — it carries no status change', (field) => {
    expect(
      isTemplateWebhookPayload({ entry: [{ id: 'W1', changes: [{ field }] }] })
    ).toBe(true);
  });

  it('is false for an ordinary message callback', () => {
    expect(
      isTemplateWebhookPayload(
        envelope({ metadata: { phone_number_id: '1' }, messages: [] })
      )
    ).toBe(false);
  });

  it('is false for WABA-level fields the template handler does not take', () => {
    expect(
      isTemplateWebhookPayload({
        entry: [{ changes: [{ field: 'account_update' }, {}] }],
      })
    ).toBe(false);
  });
});

describe('collectMetaStatuses — raw receipts for the cost ledger', () => {
  const pricing = { billable: true, pricing_model: 'PMP', category: 'marketing' };

  it('returns every status verbatim, paired with its phone_number_id', () => {
    const out = collectMetaStatuses(
      envelope({
        metadata: { phone_number_id: 'PN1' },
        statuses: [
          { id: 'wamid.1', status: 'delivered', recipient_id: '971501', timestamp: '1', pricing },
          { id: 'wamid.2', status: 'read', recipient_id: '971501', timestamp: '2' },
        ],
      })
    );
    expect(out).toHaveLength(2);
    expect(out[0].phoneNumberId).toBe('PN1');
    // The normaliser drops `pricing`; the ledger needs it intact.
    expect(out[0].status.pricing).toEqual(pricing);
    expect(out[1].status).toMatchObject({ id: 'wamid.2', status: 'read' });
  });

  it('keeps statuses the normaliser discards (e.g. warning), but not ones without id/status', () => {
    const out = collectMetaStatuses(
      envelope({
        metadata: { phone_number_id: 'PN1' },
        statuses: [
          { id: 'wamid.1', status: 'warning', recipient_id: '971501' },
          { status: 'delivered' },
          { id: 'wamid.3' },
        ],
      })
    );
    expect(out.map((s) => s.status.id)).toEqual(['wamid.1']);
  });

  it('skips changes with no phone_number_id and non-message fields', () => {
    const payload: RawMetaWebhookPayload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            { field: 'messages', value: { statuses: [{ id: 'x', status: 'sent' }] } as never },
            {
              field: 'message_template_status_update',
              value: { metadata: { phone_number_id: 'PN1' }, statuses: [{ id: 'y', status: 'sent' }] } as never,
            },
          ],
        },
      ],
    };
    expect(collectMetaStatuses(payload)).toEqual([]);
  });
});

describe('batched callbacks for several numbers', () => {
  const change = (phoneNumberId: string, id: string) => ({
    field: 'messages',
    value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: phoneNumberId, phone_number_id: phoneNumberId },
      contacts: [{ wa_id: '15550001111', profile: { name: 'A' } }],
      messages: [
        {
          from: '15550001111',
          id,
          timestamp: '1700000000',
          type: 'text',
          text: { body: `hi ${id}` },
        },
      ],
    },
  });
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      { id: 'waba', changes: [change('PN-1', 'wamid.1'), change('PN-2', 'wamid.2')] },
    ],
  } as unknown as Parameters<typeof normalizeMetaWebhook>[0];

  it('lists every number in the batch, once each', () => {
    expect(metaPhoneNumberIds(payload)).toEqual(['PN-1', 'PN-2']);
  });

  it('skips a phone_number_id that is not a string', () => {
    // An unsigned body is read before any signature check; a number or
    // object here used to reach the drop tally and throw.
    const forged = {
      entry: [
        {
          changes: [
            { field: 'messages', value: { metadata: { phone_number_id: 12345 } } },
            { field: 'messages', value: { metadata: { phone_number_id: { a: 1 } } } },
            { field: 'messages', value: { metadata: { phone_number_id: 'PN-3' } } },
          ],
        },
      ],
    } as unknown as Parameters<typeof metaPhoneNumberIds>[0];
    expect(metaPhoneNumberIds(forged)).toEqual(['PN-3']);
  });

  it('accepts the shape Meta sends, and nothing that would throw on a read', () => {
    expect(isMetaWebhookShape(payload)).toBe(true);
    expect(isMetaWebhookShape({})).toBe(true);
    expect(isMetaWebhookShape({ entry: [{ id: 123, changes: [] }] })).toBe(true);
    expect(isMetaWebhookShape({ entry: [{ id: null }] })).toBe(true);
    for (const forged of [
      null,
      5,
      'x',
      [],
      { entry: 5 },
      { entry: {} },
      { entry: [null] },
      { entry: [5] },
      { entry: [{ changes: 5 }] },
      { entry: [{ changes: [null] }] },
      { entry: [{ changes: [[]] }] },
      { entry: [{ id: JSON.parse('{"toString":null}') }] },
      { entry: [{ id: ['a'] }] },
    ]) {
      expect(isMetaWebhookShape(forged), JSON.stringify(forged)).toBe(false);
    }
  });

  it("keeps only one number's messages when asked", () => {
    const second = normalizeMetaWebhook(payload, 'PN-2');
    expect(second.channelId).toBe('PN-2');
    expect(second.messages.map((m) => m.id)).toEqual(['wamid.2']);
  });
});
