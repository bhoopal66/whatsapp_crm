import { describe, it, expect } from 'vitest'

import {
  normalizeButtonReplyId,
  normalizeWhapiMessage,
  normalizeWhapiStatus,
  normalizeWhapiWebhook,
} from './whapi-webhook'

/**
 * Payload fixtures below are taken from Whapi's published webhook
 * examples rather than invented, so a shape change on their side shows
 * up here rather than as an empty inbox in production.
 */

const BASE = {
  id: 'p.w30M7fgwWD4XwHu-gBgTwl0rVw',
  from_me: false,
  chat_id: '919984351847@s.whatsapp.net',
  from: '919984351847',
  from_name: 'Gerald',
  timestamp: 1712995245,
  source: 'mobile',
}

describe('normalizeWhapiMessage — contact cards', () => {
  const VCARD =
    'BEGIN:VCARD\nVERSION:3.0\nN:Al Mansoori;Ahmed;;;\nFN:Ahmed Al Mansoori\nORG:Dargol Logistics FZE;\nTEL;type=CELL;waid=971501234567:+971 50 123 4567\nEND:VCARD'

  it('parses a single shared contact into a card', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'contact',
      contact: { name: 'Ahmed Al Mansoori', vcard: VCARD },
    })
    expect(m).toMatchObject({
      type: 'contacts',
      text: 'Contact: Ahmed Al Mansoori',
      contacts: [
        {
          name: 'Ahmed Al Mansoori',
          phones: ['+971 50 123 4567'],
          org: 'Dargol Logistics FZE',
        },
      ],
    })
  })

  it('keeps every card of a contact list', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'contact_list',
      contact_list: {
        list: [
          { name: 'Ahmed', vcard: VCARD },
          { name: 'Fatima', vcard: 'BEGIN:VCARD\nFN:Fatima\nTEL:+971500000001\nEND:VCARD' },
        ],
      },
    })
    expect(m?.contacts).toHaveLength(2)
    expect(m?.text).toBe('Contact: Ahmed Al Mansoori, Fatima')
  })

  it('still yields a card when only a name is known', () => {
    const m = normalizeWhapiMessage({ ...BASE, type: 'contact', contact: { name: 'Someone' } })
    expect(m?.contacts).toEqual([{ name: 'Someone', phones: [], emails: [], org: null }])
  })
})

describe('normalizeWhapiMessage — content types', () => {
  it('maps a plain text message', () => {
    const m = normalizeWhapiMessage({ ...BASE, type: 'text', text: { body: 'Hello world' } })
    expect(m).toMatchObject({
      type: 'text',
      text: 'Hello world',
      from: '919984351847',
      fromName: 'Gerald',
      timestamp: '1712995245',
      fromMe: false,
      isGroup: false,
    })
  })

  it('treats a link preview as text — the card is WhatsApp’s own rendering', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'link_preview',
      link_preview: {
        body: 'This is text with url https://whapi.cloud/features',
        url: 'https://whapi.cloud/features',
      },
    })
    expect(m).toMatchObject({
      type: 'text',
      text: 'This is text with url https://whapi.cloud/features',
    })
  })

  it('carries the auto-downloaded link and size through on media', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'document',
      document: {
        id: 'pdf-b487',
        mime_type: 'application/pdf',
        file_size: 1438781,
        file_name: 'File_example.pdf',
        link: 'https://s3.example/in-files/pdf-b487.pdf',
        caption: 'This is text with file',
      },
    })
    expect(m).toMatchObject({
      type: 'document',
      text: 'This is text with file',
      media: {
        id: 'pdf-b487',
        mimeType: 'application/pdf',
        link: 'https://s3.example/in-files/pdf-b487.pdf',
        filename: 'File_example.pdf',
        fileSize: 1438781,
      },
    })
  })

  it('collapses gif and PTV onto video, and voice onto audio', () => {
    expect(normalizeWhapiMessage({ ...BASE, type: 'gif', gif: { id: 'g1' } })?.type).toBe('video')
    expect(normalizeWhapiMessage({ ...BASE, type: 'short', short: { id: 's1' } })?.type).toBe('video')
    expect(normalizeWhapiMessage({ ...BASE, type: 'voice', voice: { id: 'v1' } })?.type).toBe('audio')
  })

  it('reads a reaction out of the `action` envelope', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'action',
      action: { type: 'reaction', target: 'yqJRppZk7BI-wNoTwl0rVw', emoji: '👍' },
    })
    expect(m).toMatchObject({
      type: 'reaction',
      reaction: { targetMessageId: 'yqJRppZk7BI-wNoTwl0rVw', emoji: '👍' },
    })
  })

  it('treats an emptied reaction as a removal rather than dropping it', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'action',
      action: { type: 'reaction', target: 'abc-def', emoji: '' },
    })
    expect(m?.reaction).toEqual({ targetMessageId: 'abc-def', emoji: '' })
  })

  it('marks non-reaction actions (edits, deletes) unsupported', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'action',
      action: { type: 'media_notify', participant: '1000@s.whatsapp.net' },
    })
    expect(m?.type).toBe('unsupported')
  })

  it('reads a quoted parent off `context.quoted_id`', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      type: 'text',
      text: { body: 'sure' },
      context: { quoted_id: 'yqKj.Z7XWg0g1lA-wD8Sij1GoQ' },
    })
    expect(m?.contextMessageId).toBe('yqKj.Z7XWg0g1lA-wD8Sij1GoQ')
  })

  it('flags a forwarded message off `context.forwarded` or a forwarding score', () => {
    const forwarded = normalizeWhapiMessage({
      ...BASE,
      type: 'text',
      text: { body: 'pass it on' },
      context: { forwarded: true },
    })
    const scored = normalizeWhapiMessage({
      ...BASE,
      type: 'text',
      text: { body: 'pass it on' },
      context: { forwarding_score: 5 },
    })
    const plain = normalizeWhapiMessage({
      ...BASE,
      type: 'text',
      text: { body: 'my own words' },
    })
    expect(forwarded?.forwarded).toBe(true)
    expect(scored?.forwarded).toBe(true)
    expect(plain?.forwarded).toBe(false)
  })

  it('flags a group chat so the 1:1 inbox can skip it', () => {
    const m = normalizeWhapiMessage({
      ...BASE,
      chat_id: '123456789012345678@g.us',
      type: 'text',
      text: { body: 'hi all' },
    })
    expect(m?.isGroup).toBe(true)
  })

  it('returns null for a message with no id — there is nothing to dedupe on', () => {
    expect(normalizeWhapiMessage({ type: 'text', text: { body: 'x' } })).toBeNull()
  })
})

describe('normalizeButtonReplyId', () => {
  it('strips WhatsApp’s internal button-format marker', () => {
    expect(normalizeButtonReplyId('ButtonsV3:randomId1')).toBe('randomId1')
    expect(normalizeButtonReplyId('ListV2:pick_one')).toBe('pick_one')
  })

  it('leaves a caller-authored id containing a colon intact', () => {
    // Cutting at the first colon unconditionally would silently break
    // ids like this one, which flows legitimately author.
    expect(normalizeButtonReplyId('order:1234')).toBe('order:1234')
  })

  it('returns null for a missing id', () => {
    expect(normalizeButtonReplyId(undefined)).toBeNull()
    expect(normalizeButtonReplyId('')).toBeNull()
  })
})

describe('normalizeWhapiStatus', () => {
  it.each([
    ['sent', 'sent'],
    ['delivered', 'delivered'],
    ['read', 'read'],
    ['failed', 'failed'],
    ['pending', 'pending'],
  ])('maps %s through unchanged', (input, expected) => {
    const s = normalizeWhapiStatus({
      id: 'YhNqCveDWW90-wO4Twl0rVw',
      status: input,
      recipient_id: '919984351847@s.whatsapp.net',
      timestamp: '1712995378',
    })
    expect(s).toMatchObject({ status: expected, recipientPhone: '919984351847' })
  })

  it('collapses `played` onto read — the schema has no stronger value', () => {
    expect(
      normalizeWhapiStatus({ id: 'a-b', status: 'played', timestamp: '1' })?.status,
    ).toBe('read')
  })

  it('drops `deleted`, which describes the message and not its delivery', () => {
    expect(normalizeWhapiStatus({ id: 'a-b', status: 'deleted', timestamp: '1' })).toBeNull()
  })
})

describe('normalizeWhapiWebhook — what reaches the inbox', () => {
  const envelope = (messages: Record<string, unknown>[]) => ({
    messages,
    event: { type: 'messages', event: 'post' },
    channel_id: 'MANTIS-M72HC',
  })

  it('drops messages the connected number sent itself', () => {
    // Whapi reports outbound messages from the operator's own phone and
    // from this CRM. Keeping them would double-insert everything we
    // just sent and bump unread counts for our own replies.
    const out = normalizeWhapiWebhook(
      envelope([{ ...BASE, from_me: true, type: 'text', text: { body: 'our reply' } }]),
    )
    expect(out.messages).toHaveLength(0)
  })

  it('drops group and broadcast chats', () => {
    const out = normalizeWhapiWebhook(
      envelope([
        { ...BASE, chat_id: '123@g.us', type: 'text', text: { body: 'group' } },
        { ...BASE, chat_id: '123@broadcast', type: 'text', text: { body: 'list' } },
      ]),
    )
    expect(out.messages).toHaveLength(0)
  })

  it('drops unsupported types rather than storing empty bubbles', () => {
    const out = normalizeWhapiWebhook(
      envelope([{ ...BASE, type: 'poll_update' }]),
    )
    expect(out.messages).toHaveLength(0)
  })

  it('keeps a genuine inbound message and surfaces the channel id', () => {
    const out = normalizeWhapiWebhook(
      envelope([{ ...BASE, type: 'text', text: { body: 'hello' } }]),
    )
    expect(out.channelId).toBe('MANTIS-M72HC')
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].text).toBe('hello')
  })

  it('handles an empty body without throwing', () => {
    expect(normalizeWhapiWebhook({})).toMatchObject({ messages: [], statuses: [] })
  })
})

describe('normalizeWhapiMessage — free entry', () => {
  it("is never free entry: Meta's 72 h window has no Whapi equivalent", () => {
    const m = normalizeWhapiMessage({ ...BASE, type: 'text', text: { body: 'Hi' } })
    expect(m?.freeEntry).toBe(false)
    expect(m).not.toHaveProperty('referral')
  })
})
