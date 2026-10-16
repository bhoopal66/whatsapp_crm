import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import {
  WhapiError,
  chatIdToPhone,
  getChannelInfo,
  getContactProfile,
  getMediaUrl,
  getRiskOfBlocking,
  parseRiskOfBlocking,
  phoneToChatId,
  registerWebhook,
  sendInteractiveButtons,
  sendMediaMessage,
  sendReactionMessage,
  sendTemplateMessage,
  sendTextMessage,
  toWhapiRecipient,
} from './whapi-api'
import type { MessageTemplate } from '@/types'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Canonical Whapi success envelope for a send. */
function sent(id = 'wamid.1') {
  return {
    ok: true,
    status: 201,
    json: async () => ({ sent: true, message: { id } }),
  }
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit]
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  }
}

describe('recipient helpers', () => {
  it('strips the + that Whapi’s `to` pattern rejects', () => {
    expect(toWhapiRecipient('+15551234567')).toBe('15551234567')
  })

  it('passes a full chat id through untouched, so group sends keep working', () => {
    expect(toWhapiRecipient('123@g.us')).toBe('123@g.us')
  })

  it('round-trips between phone and chat id, idempotently', () => {
    expect(phoneToChatId('+15551234567')).toBe('15551234567@s.whatsapp.net')
    expect(phoneToChatId('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net')
    expect(chatIdToPhone('15551234567@s.whatsapp.net')).toBe('15551234567')
    expect(chatIdToPhone('15551234567')).toBe('15551234567')
  })
})

describe('sendTextMessage', () => {
  it('posts to /messages/text with the bearer token', async () => {
    fetchMock.mockResolvedValue(sent('wamid.text'))

    const result = await sendTextMessage({
      token: 'tok',
      to: '+15551234567',
      text: 'hello',
    })

    expect(result).toEqual({ messageId: 'wamid.text' })
    const call = lastCall()
    expect(call.url).toBe('https://gate.whapi.cloud/messages/text')
    expect(call.method).toBe('POST')
    expect(call.headers.Authorization).toBe('Bearer tok')
    expect(call.body).toMatchObject({ to: '15551234567', body: 'hello' })
  })

  it('attaches a well-formed quoted id', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendTextMessage({
      token: 'tok',
      to: '15551234567',
      text: 'sure',
      quotedMessageId: 'yqKj.Z7XWg0g1lA-wD8Sij1GoQ',
    })
    expect(lastCall().body.quoted).toBe('yqKj.Z7XWg0g1lA-wD8Sij1GoQ')
  })

  it('drops an unusable quoted id and still sends', async () => {
    fetchMock.mockResolvedValue(sent())
    // A Meta-era wamid doesn't match Whapi's id pattern. Losing the
    // quote preview is far better than 400-ing the whole message.
    await sendTextMessage({
      token: 'tok',
      to: '15551234567',
      text: 'sure',
      quotedMessageId: 'wamid.HBgLMTU1NTEyMzQ1NjcVAgAR',
    })
    expect(lastCall().body.quoted).toBeUndefined()
    expect(lastCall().body.body).toBe('sure')
  })
})

describe('sendMediaMessage', () => {
  it('routes each kind to its own endpoint', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendMediaMessage({ token: 't', to: '1555', kind: 'image', link: 'https://x/y.jpg' })
    expect(lastCall().url).toBe('https://gate.whapi.cloud/messages/image')

    await sendMediaMessage({ token: 't', to: '1555', kind: 'voice', link: 'https://x/y.ogg' })
    expect(lastCall().url).toBe('https://gate.whapi.cloud/messages/voice')
  })

  it('sends a caption and filename only where they are accepted', async () => {
    fetchMock.mockResolvedValue(sent())

    await sendMediaMessage({
      token: 't',
      to: '1555',
      kind: 'document',
      link: 'https://x/y.pdf',
      caption: 'invoice',
      filename: 'invoice.pdf',
    })
    expect(lastCall().body).toMatchObject({ caption: 'invoice', filename: 'invoice.pdf' })

    // Audio takes neither — Whapi rejects the fields on that endpoint.
    await sendMediaMessage({
      token: 't',
      to: '1555',
      kind: 'audio',
      link: 'https://x/y.ogg',
      caption: 'ignored',
      filename: 'ignored.ogg',
    })
    expect(lastCall().body.caption).toBeUndefined()
    expect(lastCall().body.filename).toBeUndefined()
  })
})

describe('sendReactionMessage', () => {
  it('PUTs to the target message — no recipient needed', async () => {
    // Whapi models a reaction as a mutation of the target, unlike
    // Meta's "send a message of type reaction".
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })

    const res = await sendReactionMessage({
      token: 't',
      targetMessageId: 'abc.def-ghi',
      emoji: '👍',
    })

    const call = lastCall()
    expect(call.method).toBe('PUT')
    expect(call.url).toBe('https://gate.whapi.cloud/messages/abc.def-ghi/reaction')
    expect(call.body).toEqual({ emoji: '👍' })
    // No id came back, so the target is echoed as a stable handle.
    expect(res.messageId).toBe('abc.def-ghi')
  })
})

describe('sendInteractiveButtons', () => {
  it('shapes the Whapi button payload', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendInteractiveButtons({
      token: 't',
      to: '1555',
      bodyText: 'Pick one',
      footerText: 'thanks',
      buttons: [
        { id: 'p1', title: 'Point 1' },
        { id: 'p2', title: 'Point 2' },
      ],
    })
    expect(lastCall().body).toMatchObject({
      type: 'button',
      body: { text: 'Pick one' },
      footer: { text: 'thanks' },
      action: {
        buttons: [
          { type: 'quick_reply', id: 'p1', title: 'Point 1' },
          { type: 'quick_reply', id: 'p2', title: 'Point 2' },
        ],
      },
    })
  })

  it('rejects more buttons than WhatsApp renders, before the network call', async () => {
    await expect(
      sendInteractiveButtons({
        token: 't',
        to: '1555',
        bodyText: 'too many',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
          { id: 'c', title: 'C' },
          { id: 'd', title: 'D' },
        ],
      }),
    ).rejects.toThrow(/1-3 buttons/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate button ids — the reply would be ambiguous', async () => {
    await expect(
      sendInteractiveButtons({
        token: 't',
        to: '1555',
        bodyText: 'dupes',
        buttons: [
          { id: 'same', title: 'A' },
          { id: 'same', title: 'B' },
        ],
      }),
    ).rejects.toThrow(/Duplicate/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('sendTemplateMessage — rendered locally, not registered remotely', () => {
  const template = (over: Partial<MessageTemplate> = {}) =>
    ({
      id: 'tpl-1',
      user_id: 'u-1',
      name: 'order_update',
      category: 'Utility',
      language: 'en_US',
      body_text: 'Your order {{1}} ships on {{2}}',
      created_at: '2026-01-01T00:00:00Z',
      ...over,
    }) as MessageTemplate

  it('substitutes body params and sends as plain text', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendTemplateMessage({
      token: 't',
      to: '1555',
      template: template({ footer_text: 'Acme' }),
      bodyParams: ['A123', 'Friday'],
    })
    expect(lastCall().url).toBe('https://gate.whapi.cloud/messages/text')
    expect(lastCall().body.body).toBe('Your order A123 ships on Friday\n\nAcme')
  })

  it('sends a media-header template as a captioned attachment', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendTemplateMessage({
      token: 't',
      to: '1555',
      template: template({ header_type: 'image', header_content: 'https://x/y.jpg' }),
      bodyParams: ['A123', 'Friday'],
    })
    expect(lastCall().url).toBe('https://gate.whapi.cloud/messages/image')
    expect(lastCall().body).toMatchObject({
      media: 'https://x/y.jpg',
      caption: 'Your order A123 ships on Friday',
    })
  })

  it('honours a per-send media override', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendTemplateMessage({
      token: 't',
      to: '1555',
      template: template({ header_type: 'image', header_content: 'https://x/default.jpg' }),
      headerMediaUrl: 'https://x/override.jpg',
    })
    expect(lastCall().body.media).toBe('https://x/override.jpg')
  })

  it('sends a quick-reply template through the interactive endpoint', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendTemplateMessage({
      token: 't',
      to: '1555',
      template: template({
        buttons: [
          { type: 'QUICK_REPLY', text: 'Yes' },
          { type: 'URL', text: 'Visit', url: 'https://x' },
        ] as unknown as MessageTemplate['buttons'],
      }),
      bodyParams: ['A123', 'Friday'],
    })
    expect(lastCall().url).toBe('https://gate.whapi.cloud/messages/interactive')
    // The URL button has no free-form equivalent and is dropped.
    expect(lastCall().body.action.buttons).toHaveLength(1)
    expect(lastCall().body.action.buttons[0].title).toBe('Yes')
  })

  it('leaves an unfilled placeholder visible rather than blanking it', async () => {
    fetchMock.mockResolvedValue(sent())
    await sendTemplateMessage({
      token: 't',
      to: '1555',
      template: template(),
      bodyParams: ['A123'],
    })
    expect(lastCall().body.body).toBe('Your order A123 ships on {{2}}')
  })
})

describe('getChannelInfo', () => {
  it('maps /health onto the CRM’s channel shape', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: { code: 3, text: 'AUTH' },
        version: '1.6.0',
        uptime: 1234,
        user: { id: '15551234567@s.whatsapp.net', name: 'Acme', pushname: 'Acme Support' },
      }),
    })

    const info = await getChannelInfo({ token: 't', wakeup: false })

    expect(info).toMatchObject({
      status: 'AUTH',
      authorized: true,
      phone: '15551234567',
      displayName: 'Acme Support',
      version: '1.6.0',
    })
    // wakeup=false must reach the wire: a status check should not
    // start a channel the operator deliberately stopped.
    expect(lastCall().url).toContain('wakeup=false')
  })

  it('reports a QR-pending channel as not authorized', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: { code: 1, text: 'QR' } }),
    })
    const info = await getChannelInfo({ token: 't' })
    expect(info.authorized).toBe(false)
    expect(info.phone).toBeNull()
  })
})

describe('error mapping', () => {
  it('surfaces Whapi’s own message and code', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 401, message: 'Invalid token' } }),
    })

    await expect(sendTextMessage({ token: 'bad', to: '1555', text: 'x' })).rejects.toMatchObject({
      name: 'WhapiError',
      status: 401,
      message: 'Invalid token',
    })
  })

  it('classifies auth and billing failures for the caller', async () => {
    expect(new WhapiError('x', 401).isAuthError).toBe(true)
    expect(new WhapiError('x', 402).isBillingError).toBe(true)
    expect(new WhapiError('x', 500).isAuthError).toBe(false)
  })

  it('keeps a fallback message when the body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    })
    await expect(sendTextMessage({ token: 't', to: '1', text: 'x' })).rejects.toThrow(
      /Whapi API error: 502/,
    )
  })

  it('turns a network failure into a WhapiError rather than a raw TypeError', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(sendTextMessage({ token: 't', to: '1', text: 'x' })).rejects.toMatchObject({
      name: 'WhapiError',
      status: 503,
    })
  })

  it('refuses to send without a token', async () => {
    await expect(sendTextMessage({ token: '', to: '1', text: 'x' })).rejects.toThrow(
      /Missing Whapi channel token/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getMediaUrl', () => {
  it('accepts either `link` or `url`, and NaN-guards the size', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ link: 'https://s3/x.jpg', mime_type: 'image/jpeg', file_size: '2048' }),
    })
    await expect(getMediaUrl({ token: 't', mediaId: 'm1' })).resolves.toEqual({
      url: 'https://s3/x.jpg',
      mimeType: 'image/jpeg',
      fileSize: 2048,
    })

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ url: 'https://s3/y.bin', file_size: 'unknown' }),
    })
    await expect(getMediaUrl({ token: 't', mediaId: 'm2' })).resolves.toMatchObject({
      url: 'https://s3/y.bin',
      mimeType: 'application/octet-stream',
      fileSize: null,
    })
  })
})

describe('getContactProfile', () => {
  it('asks for the profile by bare digits and returns both icon sizes', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        name: 'Ali',
        icon: 'https://pps.whatsapp.net/small.jpg',
        icon_full: 'https://pps.whatsapp.net/full.jpg',
      }),
    })
    await expect(
      getContactProfile({ token: 'tok', contactId: '+971 50 123 4567' }),
    ).resolves.toEqual({
      icon: 'https://pps.whatsapp.net/small.jpg',
      iconFull: 'https://pps.whatsapp.net/full.jpg',
    })
    const call = lastCall()
    expect(call.url).toBe('https://gate.whapi.cloud/contacts/971501234567/profile')
    expect(call.method).toBe('GET')
    expect(call.headers.Authorization).toBe('Bearer tok')
  })

  it('reads a hidden picture (no icon in the body) as no picture', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ name: 'Ali', about: 'Busy' }),
    })
    await expect(getContactProfile({ token: 't', contactId: '15551234567' })).resolves.toBeNull()
  })

  it('reads a 404 as no picture rather than an error', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { code: 404, message: 'Not found' } }),
    })
    await expect(getContactProfile({ token: 't', contactId: '15551234567' })).resolves.toBeNull()
  })

  it('still throws anything else, so the caller can retry later', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: { code: 503, message: 'Unavailable' } }),
    })
    await expect(
      getContactProfile({ token: 't', contactId: '15551234567' }),
    ).rejects.toMatchObject({ name: 'WhapiError', status: 503 })
  })
})

describe('registerWebhook', () => {
  it('subscribes to messages, statuses and the three group events', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

    await registerWebhook({ token: 't', webhookUrl: 'https://crm.test/api/whatsapp/webhook?secret=s' })

    const ours = lastCall().body.webhooks.find((w: { url: string }) =>
      w.url.includes('secret=s'),
    )
    expect(ours.events).toEqual(
      expect.arrayContaining([
        { type: 'messages', method: 'post' },
        { type: 'statuses', method: 'post' },
        { type: 'statuses', method: 'put' },
        { type: 'groups', method: 'post' },
        { type: 'groups', method: 'put' },
        { type: 'groups', method: 'patch' },
      ]),
    )
  })

  it('merges with a third party’s hook instead of clobbering it', async () => {
    fetchMock
      // GET /settings
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          webhooks: [{ url: 'https://analytics.example/hook', mode: 'body' }],
        }),
      })
      // PATCH /settings
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

    await registerWebhook({ token: 't', webhookUrl: 'https://crm.test/api/whatsapp/webhook?secret=s' })

    const patch = lastCall()
    expect(patch.method).toBe('PATCH')
    const urls = patch.body.webhooks.map((w: { url: string }) => w.url)
    expect(urls).toContain('https://analytics.example/hook')
    expect(urls).toContain('https://crm.test/api/whatsapp/webhook?secret=s')
    // Auto-download must be on, or inbound attachments arrive with no
    // retrievable bytes.
    expect(patch.body.media.auto_download).toContain('image')
  })

  it('replaces our own entry on a re-register rather than duplicating it', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          webhooks: [{ url: 'https://crm.test/api/whatsapp/webhook?secret=OLD' }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

    await registerWebhook({ token: 't', webhookUrl: 'https://crm.test/api/whatsapp/webhook?secret=NEW' })

    const urls = lastCall().body.webhooks.map((w: { url: string }) => w.url)
    expect(urls).toEqual(['https://crm.test/api/whatsapp/webhook?secret=NEW'])
  })

  it('drops our entry from a PREVIOUS hostname, so tunnel URLs do not pile up', async () => {
    // A Cloudflare quick tunnel gets a new hostname every restart.
    // Matching on origin alone would leave every dead host behind, and
    // Whapi would keep retrying all of them.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          webhooks: [
            { url: 'https://old-tunnel.trycloudflare.com/api/whatsapp/webhook?secret=OLD' },
            { url: 'https://analytics.example/hook' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

    await registerWebhook({
      token: 't',
      webhookUrl: 'https://new-tunnel.trycloudflare.com/api/whatsapp/webhook?secret=NEW',
    })

    const urls = lastCall().body.webhooks.map((w: { url: string }) => w.url)
    expect(urls).toEqual([
      // A third party's hook on an unrelated path is preserved.
      'https://analytics.example/hook',
      'https://new-tunnel.trycloudflare.com/api/whatsapp/webhook?secret=NEW',
    ])
  })

  it('refuses a plaintext callback URL up front', async () => {
    await expect(
      registerWebhook({ token: 't', webhookUrl: 'http://localhost:3000/api/whatsapp/webhook' }),
    ).rejects.toThrow(/HTTPS/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still registers when the settings read fails', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })

    await expect(
      registerWebhook({ token: 't', webhookUrl: 'https://crm.test/api/whatsapp/webhook?secret=s' }),
    ).resolves.toMatchObject({ success: true })
  })
})

describe('unknown-channel classification', () => {
  it('treats 404 as an unrecognised token, not a missing endpoint', async () => {
    // Verified against the live gateway: `GET /health` with a bogus
    // token answers 404 {"error":"Service not found"} rather than 401,
    // because the token is what selects the channel.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: { message: 'Service not found' } }),
    })

    await expect(getChannelInfo({ token: 'bogus' })).rejects.toMatchObject({
      name: 'WhapiError',
      status: 404,
    })

    expect(new WhapiError('x', 404).isUnknownChannel).toBe(true)
    expect(new WhapiError('x', 401).isUnknownChannel).toBe(false)
  })
})

describe('Safety Meter (riskOfBlocking)', () => {
  const body = {
    channel: 'SECRET-CHANNEL-TOKEN',
    lastUpdateDate: '9/30/2026',
    lifeTime: 1,
    riskFactor: 2,
    riskFactorChats: 3,
    riskFactorContacts: 2,
  }

  it('reads the stored rating with GET on the tools host', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
    const rating = await getRiskOfBlocking({ token: 'tok' })
    const call = lastCall()
    expect(call.url).toBe('https://tools.whapi.cloud/services/riskOfBlocking')
    expect(call.method).toBe('GET')
    expect(call.headers.Authorization).toBe('Bearer tok')
    expect(rating).toEqual({
      riskFactor: 2,
      lifeTime: 1,
      riskFactorChats: 3,
      riskFactorContacts: 2,
      lastUpdate: '9/30/2026',
    })
  })

  it('recalculates with POST', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body })
    await getRiskOfBlocking({ token: 'tok', recalculate: true })
    expect(lastCall().method).toBe('POST')
  })

  it('never passes the echoed token on', () => {
    expect(JSON.stringify(parseRiskOfBlocking(body))).not.toContain('SECRET')
  })

  it('drops values outside 1-3 and answers null when nothing is rated', () => {
    expect(parseRiskOfBlocking({ riskFactor: 7, lifeTime: '3' })).toEqual({
      riskFactor: null,
      lifeTime: 3,
      riskFactorChats: null,
      riskFactorContacts: null,
      lastUpdate: null,
    })
    expect(parseRiskOfBlocking({ channel: 'x' })).toBeNull()
    expect(parseRiskOfBlocking('nope')).toBeNull()
  })

  it('maps a refused token to a WhapiError', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 401, message: 'Unauthorized' } }),
    })
    await expect(getRiskOfBlocking({ token: 'bad' })).rejects.toBeInstanceOf(WhapiError)
  })
})
