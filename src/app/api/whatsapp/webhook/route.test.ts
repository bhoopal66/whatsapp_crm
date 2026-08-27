import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Shared secret the fixture channel is registered with.
 *
 * Hoisted, because the `whatsapp_config` mock factory below is lifted
 * above ordinary module-scope consts and would hit the temporal dead
 * zone otherwise.
 */
const { WEBHOOK_SECRET } = vi.hoisted(() => ({
  WEBHOOK_SECRET: 'a'.repeat(64),
}))

// Shared, hoisted state the module mocks close over. Reset per test.
const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to. A genuine insert
    // returns the row; a replayed delivery conflicts and returns [].
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    /** Row `lookupInternalIdByWhatsAppId` resolves for a quoted id. */
    replyContextParent: null as { id: string } | null,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' },
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    afterCallbacks: [] as (() => Promise<void> | void)[],
    automationStarted: 0,
    automationCompleted: 0,
    /** whatsapp_config.mirror_inbound_media for the matched row (#466). */
    mirrorInboundMedia: true as boolean | undefined,
    /** Objects the inbound-media mirror pushed into chat-media. */
    storageUploads: [] as {
      bucket: string
      path: string
      options: { contentType?: string }
    }[],
    /** Error the next storage upload resolves with, if any. */
    storageUploadError: null as { message: string } | null,
    /** `messages.status` writes made by the delivery-status handler. */
    messageStatusUpdates: [] as { messageId: string; status: string }[],
  },
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void> | void) => {
    h.state.afterCallbacks.push(cb)
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, init }),
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'whatsapp_config':
          // The Whapi route resolves tenancy from the webhook SECRET,
          // not from a payload field, so it loads every row and
          // compares decrypted verify_tokens — hence `select('*')`
          // awaited directly rather than a filtered `.eq()`.
          return {
            select: () =>
              Promise.resolve({
                data: [
                  {
                    account_id: 'acc-1',
                    user_id: 'user-1',
                    phone_number_id: 'CHANNEL-1',
                    access_token: 'enc:plain-token',
                    verify_token: `enc:${WEBHOOK_SECRET}`,
                    mirror_inbound_media: h.state.mirrorInboundMedia,
                  },
                ],
                error: null,
              }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }
        case 'broadcast_recipients': {
          // Two chains land here:
          //   flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
          //   handleStatusUpdate:      select().eq().maybeSingle()
          // A permissive self-returning builder answers both without
          // encoding either chain's exact shape.
          const br: Record<string, unknown> = {}
          const self = () => br
          for (const m of ['select', 'eq', 'in', 'order', 'update']) br[m] = self
          br.limit = () => Promise.resolve({ data: [], error: null })
          br.maybeSingle = () => Promise.resolve({ data: null, error: null })
          return br
        }
        case 'messages':
          return {
            // Two different chains land here, told apart by the count
            // option: the prior-message count (head request) and the
            // reply-context parent lookup.
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? // priorCustomerMsgCount: select('id',{count,head}).eq().eq()
                  {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : // Two non-head chains land here, both ending in
                  // maybeSingle():
                  //   lookupInternalIdByWhatsAppId: .eq().eq()
                  //   handleStatusUpdate's owner lookup: .eq().limit()
                  (() => {
                    const m: Record<string, unknown> = {}
                    const self = () => m
                    m.eq = self
                    m.limit = self
                    m.maybeSingle = () =>
                      Promise.resolve({
                        data: h.state.replyContextParent,
                        error: null,
                      })
                    return m
                  })(),
            // handleStatusUpdate: update({status}).eq('message_id', id)
            update: (row: { status?: string }) => ({
              eq: (_column: string, messageId: string) => {
                h.state.messageStatusUpdates.push({
                  messageId,
                  status: String(row.status),
                })
                return Promise.resolve({ error: null })
              },
            }),
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
    // Service-role Storage, used by the inbound-media mirror (#466).
    storage: {
      from(bucket: string) {
        return {
          upload: (
            path: string,
            _body: unknown,
            options: { contentType?: string },
          ) => {
            h.state.storageUploads.push({ bucket, path, options })
            return Promise.resolve({ error: h.state.storageUploadError })
          },
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.test/${bucket}/${path}` },
          }),
        }
      },
    },
  }),
}))

// A reversible stand-in: the route compares the presented secret
// against `decrypt(verify_token)`, so a mock that returns one constant
// for every column would make the secret check vacuous.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
  encrypt: (v: string) => `enc:${v}`,
  isLegacyFormat: () => false,
}))
vi.mock('@/lib/whatsapp/whapi-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
}))
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { POST } from './route'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/whapi-api'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)

const TEXT_MESSAGE = {
  id: 'p.w30M7fgwWD4XwHu-gBgTwl0rVw',
  from_me: false,
  from: '15551230000',
  from_name: 'Ada',
  chat_id: '15551230000@s.whatsapp.net',
  timestamp: 1700000000,
  type: 'text',
  text: { body: 'hello' },
}

function inboundRequest(
  message: Record<string, unknown> = TEXT_MESSAGE,
  opts: { secret?: string | null } = {},
) {
  const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret
  const body = {
    messages: [message],
    event: { type: 'messages', event: 'post' },
    channel_id: 'CHANNEL-1',
  }
  const url = secret
    ? `https://crm.test/api/whatsapp/webhook?secret=${secret}`
    : 'https://crm.test/api/whatsapp/webhook'
  return {
    url,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Request
}

/** Post a statuses callback rather than a messages one. */
function statusRequest(status: Record<string, unknown>) {
  return {
    url: `https://crm.test/api/whatsapp/webhook?secret=${WEBHOOK_SECRET}`,
    json: async () => ({
      statuses: [status],
      event: { type: 'statuses', event: 'post' },
      channel_id: 'CHANNEL-1',
    }),
    headers: { get: () => null },
  } as unknown as Request
}

async function runWebhook(message?: Record<string, unknown>) {
  const res = await POST(inboundRequest(message))
  // Drain the after() callback exactly as the runtime would.
  for (const cb of h.state.afterCallbacks) await cb()
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.replyContextParent = null
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.afterCallbacks = []
  h.state.automationStarted = 0
  h.state.automationCompleted = 0
  h.state.mirrorInboundMedia = true
  h.state.storageUploads = []
  h.state.storageUploadError = null
  h.state.messageStatusUpdates = []
  mockGetMediaUrl.mockResolvedValue({
    url: 'https://lookaside.fbsbx.com/whatsapp/abc',
    mimeType: 'image/jpeg',
    fileSize: 2048,
  })
  mockDownloadMedia.mockResolvedValue({
    buffer: Buffer.alloc(2048),
    contentType: 'image/jpeg',
  })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockImplementation(() => {
    h.state.automationStarted++
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        h.state.automationCompleted++
        resolve()
      }, 0)
    })
  })
})

describe('inbound webhook: caller authentication', () => {
  // Meta signed each POST with an HMAC of the body. Whapi signs nothing
  // and cannot attach a custom header, so the shared secret rides in the
  // callback URL and is the only authenticated fact in the request.

  it('rejects a callback with no secret, loudly rather than silently', async () => {
    const res = (await POST(inboundRequest(TEXT_MESSAGE, { secret: null }))) as unknown as {
      init: { status: number }
    }

    // 401 (not a quiet 200) so a broken rotation shows up in Whapi's
    // delivery log instead of events being eaten.
    expect(res.init.status).toBe(401)
    expect(h.state.afterCallbacks).toHaveLength(0)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('rejects an unrecognised secret', async () => {
    const res = (await POST(
      inboundRequest(TEXT_MESSAGE, { secret: 'b'.repeat(64) }),
    )) as unknown as { init: { status: number } }

    expect(res.init.status).toBe(401)
    expect(h.state.upsertCalls).toHaveLength(0)
  })

  it('drops a payload whose channel_id disagrees with the secret’s channel', async () => {
    // Tenancy comes from the secret; `channel_id` is attacker-controlled
    // data. A mismatch means a second channel was pointed at a URL
    // minted for the first, so the messages would be filed to the wrong
    // account.
    const req = {
      url: `https://crm.test/api/whatsapp/webhook?secret=${WEBHOOK_SECRET}`,
      json: async () => ({
        messages: [TEXT_MESSAGE],
        event: { type: 'messages', event: 'post' },
        channel_id: 'SOMEONE-ELSE',
      }),
      headers: { get: () => null },
    } as unknown as Request

    const res = (await POST(req)) as unknown as { init: { status: number } }
    for (const cb of h.state.afterCallbacks) await cb()

    // Still acked — retrying would not help — but nothing is written.
    expect(res.init.status).toBe(200)
    expect(h.state.upsertCalls).toHaveLength(0)
  })
})

describe('inbound webhook: delivery statuses', () => {
  it('maps a Whapi status onto the messages row', async () => {
    await POST(statusRequest({
      id: 'YhNqCveDWW90-wO4Twl0rVw',
      code: 3,
      status: 'delivered',
      recipient_id: '15551230000@s.whatsapp.net',
      timestamp: '1700000100',
    }))
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.state.messageStatusUpdates).toContainEqual({
      messageId: 'YhNqCveDWW90-wO4Twl0rVw',
      status: 'delivered',
    })
  })

  it('ignores a `deleted` status, which is not a delivery state', async () => {
    await POST(statusRequest({
      id: 'YhNqCveDWW90-wO4Twl0rVw',
      status: 'deleted',
      timestamp: '1700000100',
    }))
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.state.messageStatusUpdates).toHaveLength(0)
  })
})

describe('inbound webhook: idempotent insert (#367)', () => {
  it('a genuine first delivery persists once and fans out downstream', async () => {
    await runWebhook()

    // Inserted via upsert with the (conversation_id, message_id) conflict
    // target — not a bare insert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].options).toMatchObject({
      onConflict: 'conversation_id,message_id',
      ignoreDuplicates: true,
    })
    // Downstream side effects ran exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('a replayed delivery is a no-op: no unread bump, no fan-out', async () => {
    // Upsert hits the unique index and returns no row.
    h.state.messageUpsertResult = []

    await runWebhook()

    expect(h.state.upsertCalls).toHaveLength(1)
    // None of the downstream side effects fire on a replay.
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })
})

describe('inbound webhook: atomic unread bump (#369)', () => {
  it('increments unread through the DB-side RPC, not a read-modify-write', async () => {
    await runWebhook()

    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0]).toMatchObject({
      name: 'bump_conversation_on_inbound',
      args: { p_conversation_id: 'conv-1' },
    })
  })
})

describe('inbound webhook: quick-reply button taps', () => {
  // A customer tapping a quick-reply button on a message we sent.
  //
  // Meta split this across two envelopes — `interactive.button_reply`
  // for interactive messages and a separate `button` shape for
  // template ones (issue #478). Whapi reports both as `type: 'reply'`,
  // so the CRM sees one shape and the class of bug that issue was
  // about cannot recur.
  //
  // `context.quoted_id` points at the message we sent, which a
  // broadcast never wrote to `messages` — so the parent lookup
  // legitimately misses and the reply is stored unquoted.
  const buttonTap = {
    id: 'g0jEG0ZsSobn4yNG-gDYOS60TLw',
    from_me: false,
    from: '15551230000',
    from_name: 'Ada',
    chat_id: '15551230000@s.whatsapp.net',
    timestamp: 1700000000,
    type: 'reply',
    reply: {
      type: 'buttons_reply',
      // WhatsApp echoes the id back with its internal marker prefixed;
      // the normaliser strips it so flows match what they authored.
      buttons_reply: { id: 'ButtonsV3:YES_INTERESTED', title: 'Yes, interested' },
    },
    context: { quoted_id: 'yqKj.Z7XWg0g1lA-wD8Sij1GoQ' },
  }

  it('stores the tap as an interactive reply, not an unsupported message', async () => {
    await runWebhook(buttonTap)

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Yes, interested',
      interactive_reply_id: 'YES_INTERESTED',
      reply_to_message_id: null,
    })
  })

  it('routes the tap to flows and fires the interactive_reply trigger', async () => {
    await runWebhook(buttonTap)

    expect(h.dispatchInboundToFlows).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          kind: 'interactive_reply',
          reply_id: 'YES_INTERESTED',
          reply_title: 'Yes, interested',
          meta_message_id: 'g0jEG0ZsSobn4yNG-gDYOS60TLw',
        },
      }),
    )
    const triggers = h.runAutomationsForTrigger.mock.calls.map(
      (call) => (call[0] as { triggerType: string }).triggerType,
    )
    expect(triggers).toContain('interactive_reply')
    // The AI auto-reply must stay out of it — a button tap is not a
    // free-text question.
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('handles a list-row selection the same way', async () => {
    await runWebhook({
      ...buttonTap,
      reply: {
        type: 'list_reply',
        list_reply: { id: 'track_order', title: 'Track my order' },
      },
    })

    expect(h.state.upsertCalls[0].row).toMatchObject({
      content_type: 'interactive',
      content_text: 'Track my order',
      interactive_reply_id: 'track_order',
    })
  })
})

describe('inbound webhook: inbound media is mirrored (#466)', () => {
  // Whapi's auto-download (which `registerWebhook` turns on) puts a
  // ready-to-fetch `link` on the attachment, so the common path never
  // calls `getMediaUrl` at all — a round-trip Meta always required.
  // The link still expires in ~30 days, which is why the mirror exists.
  const WHAPI_IMAGE_LINK = 'https://s3.whapi.test/in-files/img-abc.jpg'

  const IMAGE_MESSAGE = {
    id: 'wamid.IMG1',
    from_me: false,
    from: '15551230000',
    from_name: 'Ada',
    chat_id: '15551230000@s.whatsapp.net',
    timestamp: 1700000000,
    type: 'image',
    image: {
      id: '1234567890123456',
      mime_type: 'image/jpeg',
      file_size: 2048,
      link: WHAPI_IMAGE_LINK,
      caption: 'hi',
    },
  }

  it('stores a durable bucket URL instead of the expiring gateway link', async () => {
    await runWebhook(IMAGE_MESSAGE)

    // The webhook already carried the link, so no id-resolution call.
    expect(mockGetMediaUrl).not.toHaveBeenCalled()

    expect(h.state.storageUploads).toHaveLength(1)
    expect(h.state.storageUploads[0].bucket).toBe('chat-media')
    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
    )
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url:
        'https://cdn.test/chat-media/account-acc-1/inbound/1234567890123456-image-1700000000.jpg',
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the gateway link when the upload is refused', async () => {
    h.state.storageUploadError = { message: 'mime type not supported' }

    await runWebhook(IMAGE_MESSAGE)

    // The message still lands, and it still lands with a usable URL —
    // the mirror failing must never cost us the message.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: WHAPI_IMAGE_LINK,
      media_type: 'image/jpeg',
    })
  })

  it('falls back to the gateway link when the download throws', async () => {
    mockDownloadMedia.mockRejectedValueOnce(
      new Error('Media download failed: 404'),
    )

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: WHAPI_IMAGE_LINK,
    })
  })

  it('resolves the media id when auto-download left no link', async () => {
    mockGetMediaUrl.mockResolvedValue({
      url: 'https://s3.whapi.test/in-files/resolved.jpg',
      mimeType: 'image/jpeg',
      fileSize: 2048,
    })

    const { link, ...withoutLink } = IMAGE_MESSAGE.image
    void link
    await runWebhook({ ...IMAGE_MESSAGE, image: withoutLink })

    expect(mockGetMediaUrl).toHaveBeenCalledWith({
      token: 'plain-token',
      mediaId: '1234567890123456',
    })
    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('skips media larger than the bucket accepts, without downloading it', async () => {
    const bigLink = 'https://s3.whapi.test/in-files/huge.pdf'

    await runWebhook({
      id: 'wamid.DOC1',
      from_me: false,
      from: '15551230000',
      from_name: 'Ada',
      chat_id: '15551230000@s.whatsapp.net',
      timestamp: 1700000000,
      type: 'document',
      document: {
        id: '999',
        mime_type: 'application/pdf',
        file_size: 40 * 1024 * 1024,
        file_name: 'huge.pdf',
        link: bigLink,
      },
    })

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: bigLink,
      media_type: 'application/pdf',
    })
  })

  it("names the object after a document's own filename", async () => {
    mockDownloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(4096),
      contentType: 'application/pdf',
    })

    await runWebhook({
      id: 'wamid.DOC2',
      from_me: false,
      from: '15551230000',
      from_name: 'Ada',
      chat_id: '15551230000@s.whatsapp.net',
      timestamp: 1700000000,
      type: 'document',
      document: {
        id: '1234567890123456',
        mime_type: 'application/pdf',
        file_size: 4096,
        file_name: 'invoice.pdf',
        link: 'https://s3.whapi.test/in-files/invoice.pdf',
        caption: 'have a look',
      },
    })

    expect(h.state.storageUploads[0].path).toBe(
      'account-acc-1/inbound/1234567890123456-invoice.pdf',
    )
  })

  it('does not mirror when the account has opted out', async () => {
    h.state.mirrorInboundMedia = false

    await runWebhook(IMAGE_MESSAGE)

    expect(mockDownloadMedia).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      media_url: WHAPI_IMAGE_LINK,
      // Still recorded — the MIME type costs nothing and makes the
      // download name right even for un-mirrored media.
      media_type: 'image/jpeg',
    })
  })

  it('mirrors when the column is absent, e.g. a row read before migration 039', async () => {
    h.state.mirrorInboundMedia = undefined

    await runWebhook(IMAGE_MESSAGE)

    expect(h.state.storageUploads).toHaveLength(1)
  })

  it('leaves text messages alone', async () => {
    await runWebhook()

    expect(mockGetMediaUrl).not.toHaveBeenCalled()
    expect(h.state.storageUploads).toHaveLength(0)
    expect(h.state.upsertCalls[0].row).toMatchObject({ media_type: null })
  })
})

describe('inbound webhook: after() awaits automations (#368)', () => {
  it('every triggered automation settles before the after() callback resolves', async () => {
    await runWebhook()

    // first_inbound_message + new_message_received + keyword_match.
    expect(h.state.automationStarted).toBe(3)
    // If the dispatches were fire-and-forget, completed would still be 0
    // here — the callback would have resolved before the timers fired.
    expect(h.state.automationCompleted).toBe(3)
  })
})
