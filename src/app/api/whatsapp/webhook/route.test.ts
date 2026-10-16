import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  screenWebhook: vi.fn(),
  confirmAccepted: vi.fn(),
  clientIp: vi.fn(),
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
    /** whatsapp_config.phone_number_id — the Whapi channel id. */
    channelId: 'CHANNEL-1' as string,
    /** whatsapp_config.waba_id — the connected phone number. Equal to
        `channelId` when the save path took its phone fallback. */
    wabaId: '15551230000' as string,
    /** Writes the channel-id adoption made to whatsapp_config. */
    configUpdates: [] as Record<string, unknown>[],
    conversationUpdates: [] as Record<string, unknown>[],
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
          // not from a payload field, so it loads the Whapi rows and
          // compares decrypted verify_tokens. Since migration 046 that
          // read is `.select('*').eq('provider', 'whapi')` — a Meta
          // row's verify_token is a different credential entirely.
          return {
            select: () => ({
              eq: () =>
                Promise.resolve({
                  data: [
                    {
                      id: 'cfg-1',
                      account_id: 'acc-1',
                      user_id: 'user-1',
                      provider: 'whapi',
                      label: 'Support',
                      phone_number_id: h.state.channelId,
                      waba_id: h.state.wabaId,
                      access_token: 'enc:plain-token',
                      verify_token: `enc:${WEBHOOK_SECRET}`,
                      is_primary: true,
                      mirror_inbound_media: h.state.mirrorInboundMedia,
                      status: 'connected',
                    },
                  ],
                  error: null,
                }),
            }),
            // `adoptChannelId` writes the real channel id back once an
            // authenticated callback reveals it.
            update: (row: Record<string, unknown>) => ({
              eq: () => {
                h.state.configUpdates.push(row)
                return Promise.resolve({ error: null })
              },
            }),
          }
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          // plus the channel stamp (migration 060): update().eq()
          return {
            update: (row: Record<string, unknown>) => ({
              eq: () => ({
                // Conditional on no pin (061), re-checked in the statement.
                is: () => {
                  h.state.conversationUpdates.push(row)
                  return Promise.resolve({ error: null })
                },
              }),
            }),
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
          // flagBroadcastReplyIfAny awaits .limit(); handleStatusUpdate
          // chains .limit(1).maybeSingle() — answer both.
          br.limit = () => {
            const res = Promise.resolve({ data: [], error: null }) as Promise<unknown> &
              Record<string, unknown>
            res.maybeSingle = () => Promise.resolve({ data: null, error: null })
            return res
          }
          br.maybeSingle = () => Promise.resolve({ data: null, error: null })
          return br
        }
        case 'messages':
          return {
            // Three chains land here: the prior-customer-message probe
            // (select('id').eq().eq().limit(1), awaited directly) and two
            // that end in maybeSingle():
            //   lookupInternalIdByWhatsAppId: .eq().eq()
            //   handleStatusUpdate's owner lookup: .eq().limit()
            select: (columns?: string) =>
              (() => {
                    const m: Record<string, unknown> = {}
                    const self = () => m
                    // handleStatusUpdate resolves the rows it may touch
                    // (inside the callback's account) before updating.
                    if (columns?.includes('conversations!inner')) {
                      let messageId = ''
                      m.eq = (column: string, value: string) => {
                        if (column === 'message_id') messageId = value
                        return m
                      }
                      m.limit = () =>
                        Promise.resolve({
                          data: [
                            {
                              id: `row-${messageId}`,
                              conversation_id: 'conv-1',
                              conversations: { account_id: 'acc-1' },
                            },
                          ],
                          error: null,
                        })
                      return m
                    }
                    m.eq = self
                    m.limit = self
                    m.maybeSingle = () =>
                      Promise.resolve({
                        data: h.state.replyContextParent,
                        error: null,
                      })
                    m.then = (
                      resolve: (v: unknown) => unknown,
                      reject: (e: unknown) => unknown
                    ) =>
                      Promise.resolve({
                        data:
                          h.state.priorCustomerMsgCount > 0 ? [{ id: 'prior' }] : [],
                        error: null,
                      }).then(resolve, reject)
                    return m
                  })(),
            // handleStatusUpdate's forward-only write:
            //   update({status}).in('id', [row ids])
            //     .in('status', [predecessors]).select('id')
            // (A mock ending at the first .in() threw on the second, and
            // the after() catch hid it while a receipt was all a callback
            // carried.)
            update: (row: { status?: string }) => ({
              in: (_column: string, ids: string[]) => ({
                in: () => ({
                  select: () => {
                    for (const id of ids) {
                      h.state.messageStatusUpdates.push({
                        messageId: id.replace(/^row-/, ''),
                        status: String(row.status),
                      })
                    }
                    return Promise.resolve({
                      data: ids.map((id) => ({ id })),
                      error: null,
                    })
                  },
                }),
              }),
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
// Edge screening is its own module with its own tests; here it is a
// seam. By default every event is accepted with a claim token, which is
// the pre-screening behaviour the older tests describe. (The real stores
// would also land in `rpcCalls`, which several tests count.)
vi.mock('@/lib/edge', () => ({
  clientIp: h.clientIp,
  screenWebhook: h.screenWebhook,
  confirmAccepted: h.confirmAccepted,
  ReplayGuard: class {},
  RateLimiter: class {},
  RpcSeenStore: class {},
  RpcRateStore: class {},
}))
// The real pipeline, observed: the screening tests read the options
// each message was processed with.
vi.mock('@/lib/whatsapp/inbound-pipeline', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/whatsapp/inbound-pipeline')>()
  return { ...actual, processMessage: vi.fn(actual.processMessage) }
})

import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/whapi-api'
import { processMessage } from '@/lib/whatsapp/inbound-pipeline'

const mockGetMediaUrl = vi.mocked(getMediaUrl)
const mockDownloadMedia = vi.mocked(downloadMedia)
const mockProcessMessage = vi.mocked(processMessage)

type Outcome = 'accept' | 'duplicate' | 'rate_limited' | 'ip_limited'
type ScreenInputArg = {
  ip: string | undefined
  events: { key: string; senderKey?: string; kind: string }[]
}

/** A screenWebhook stand-in deciding each event by its key. */
function screenAs(outcomeOf: (key: string) => Outcome) {
  return async (_ctx: unknown, input: ScreenInputArg) => ({
    status: 200 as const,
    decisions: input.events.map((e) => {
      const outcome = outcomeOf(e.key)
      return outcome === 'accept'
        ? { key: e.key, outcome, claimToken: `tok:${e.key}` }
        : { key: e.key, outcome }
    }),
  })
}

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
  h.screenWebhook.mockImplementation(screenAs(() => 'accept'))
  h.confirmAccepted.mockResolvedValue({ unconfirmed: [] })
  h.clientIp.mockReturnValue('203.0.113.7')
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
  h.state.channelId = 'CHANNEL-1'
  h.state.wabaId = '15551230000'
  h.state.configUpdates = []
  h.state.conversationUpdates = []
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

  it('adopts the real channel id when the row still holds the phone fallback', async () => {
    // `/health` does not expose the channel id, so the save path falls
    // back to the connected phone number. A phone can never equal a
    // Whapi channel id, so the strict guard above used to drop EVERY
    // inbound callback — outbound looked healthy while nothing a
    // customer sent ever arrived. Learn the id instead of dropping.
    h.state.channelId = '15551230000'
    h.state.wabaId = '15551230000'

    const req = {
      url: `https://crm.test/api/whatsapp/webhook?secret=${WEBHOOK_SECRET}`,
      json: async () => ({
        messages: [TEXT_MESSAGE],
        event: { type: 'messages', event: 'post' },
        channel_id: 'NIGHTW-JJC9J',
      }),
      headers: { get: () => null },
    } as unknown as Request

    const res = (await POST(req)) as unknown as { init: { status: number } }
    for (const cb of h.state.afterCallbacks) await cb()

    expect(res.init.status).toBe(200)
    // The message is delivered, not dropped...
    expect(h.state.upsertCalls).toHaveLength(1)
    // ...and the id is persisted so the guard bites from now on.
    expect(h.state.configUpdates).toHaveLength(1)
    expect(h.state.configUpdates[0].phone_number_id).toBe('NIGHTW-JJC9J')
  })

  it('does not re-adopt once a real channel id is stored', async () => {
    // Guard stays strict after the first callback taught it the id.
    const req = {
      url: `https://crm.test/api/whatsapp/webhook?secret=${WEBHOOK_SECRET}`,
      json: async () => ({
        messages: [TEXT_MESSAGE],
        event: { type: 'messages', event: 'post' },
        channel_id: 'CHANNEL-1',
      }),
      headers: { get: () => null },
    } as unknown as Request

    await POST(req)
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.configUpdates).toHaveLength(0)
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

describe('inbound webhook: group events', () => {
  it('answers 200 and processes nothing for a groups.put callback', async () => {
    const res = await POST({
      url: `https://crm.test/api/whatsapp/webhook?secret=${WEBHOOK_SECRET}`,
      json: async () => ({
        groups_participants: [
          {
            group_id: '120363271212442249@g.us',
            participants: ['61280155346'],
            action: 'add',
          },
        ],
        event: { type: 'groups', event: 'put' },
        channel_id: 'CHANNEL-1',
      }),
      headers: { get: () => null },
    } as unknown as Request)
    for (const cb of h.state.afterCallbacks) await cb()

    expect(res).toMatchObject({ body: { status: 'received' } })
    expect(res).toMatchObject({ init: { status: 200 } })
    expect(h.state.upsertCalls).toHaveLength(0)
    expect(h.state.messageStatusUpdates).toHaveLength(0)
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
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
    // Downstream side effects ran exactly once: the unread bump and the
    // web push queue (migration 109).
    expect(h.state.rpcCalls.map((c) => c.name)).toEqual([
      'bump_conversation_on_inbound',
      'push_whatsapp_inbound',
    ])
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
  })

  it('records the exact number on the message and moves the thread to it (migration 060)', async () => {
    await runWebhook()

    expect(h.state.upsertCalls[0].row.channel_id).toBe('cfg-1')
    expect(h.state.conversationUpdates).toEqual([{ channel_id: 'cfg-1' }])
  })

  it('does not rewrite the thread number when it is already on this one', async () => {
    h.state.conversation = Object.assign(h.state.conversation, {
      channel_id: 'cfg-1',
    })

    await runWebhook()

    expect(h.state.conversationUpdates).toEqual([])
  })

  it('leaves a pinned chat where it is — a person chose its number (migration 061)', async () => {
    h.state.conversation = Object.assign(h.state.conversation, {
      channel_id: 'cfg-other',
      send_channel_id: 'cfg-1',
    })

    await runWebhook()

    // The message still records the number that carried it…
    expect(h.state.upsertCalls[0].row.channel_id).toBe('cfg-1')
    // …but the chat is not handed to that number's team.
    expect(h.state.conversationUpdates).toEqual([])
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

    const bumps = h.state.rpcCalls.filter(
      (c) => c.name === 'bump_conversation_on_inbound'
    )
    expect(bumps).toHaveLength(1)
    expect(bumps[0]).toMatchObject({
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
  })

  it('fires first_inbound_message only when the thread has no earlier customer message', async () => {
    const triggersFor = () =>
      h.runAutomationsForTrigger.mock.calls.map(
        (call) => (call[0] as { triggerType: string }).triggerType,
      )

    await runWebhook(buttonTap)
    expect(triggersFor()).toContain('first_inbound_message')

    h.runAutomationsForTrigger.mockClear()
    h.state.priorCustomerMsgCount = 3
    await runWebhook(buttonTap)
    expect(triggersFor()).not.toContain('first_inbound_message')
  })

  it('hands an unconsumed tap to the AI agent, flagged as interactive', async () => {
    // Nothing deterministic claimed it (no Flow consumed the message):
    // the tapped title is the customer's message and the bot answers
    // it. Typical case: a template quick-reply on a campaign sent with
    // no follow-up Flow. The flag lets the bot stand down when an
    // `interactive_reply` automation owns the buttons instead.
    await runWebhook(buttonTap)

    expect(h.dispatchInboundToAiReply).toHaveBeenCalledTimes(1)
    expect(h.dispatchInboundToAiReply).toHaveBeenCalledWith(
      expect.objectContaining({ interactiveReply: true }),
    )
  })

  it('keeps the AI out of a tap a Flow consumed', async () => {
    h.dispatchInboundToFlows.mockResolvedValueOnce({
      consumed: true,
      outcome: 'advanced',
    })
    await runWebhook(buttonTap)

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

describe('inbound webhook: edge screening (module 017a)', () => {
  const MSG_KEY = `whapi:cfg-1:${TEXT_MESSAGE.id}`
  const STATUS = {
    id: 'YhNqCveDWW90-wO4Twl0rVw',
    code: 3,
    status: 'delivered',
    recipient_id: '15551230000@s.whatsapp.net',
    timestamp: '1700000100',
  }
  const STATUS_KEY = `whapi:status:cfg-1:${STATUS.id}:delivered`
  /** A second customer writing in the same delivery. */
  const OTHER_MESSAGE = {
    ...TEXT_MESSAGE,
    id: 'p.Bq81Kd0vXz4LmNw-gBgTwl0rVw',
    from: '15550000000',
    chat_id: '15550000000@s.whatsapp.net',
    text: { body: 'hi' },
  }
  const OTHER_KEY = `whapi:cfg-1:${OTHER_MESSAGE.id}`

  /** One delivery carrying a receipt plus the given messages. */
  function deliveryRequest(
    messages: Record<string, unknown>[] = [TEXT_MESSAGE],
    opts: { channelId?: string; secret?: string } = {},
  ) {
    return {
      url: `https://crm.test/api/whatsapp/webhook?secret=${opts.secret ?? WEBHOOK_SECRET}`,
      json: async () => ({
        messages,
        statuses: [STATUS],
        event: { type: 'messages', event: 'post' },
        channel_id: opts.channelId ?? 'CHANNEL-1',
      }),
      headers: { get: () => null },
    } as unknown as Request
  }

  async function deliver(req: Request) {
    const res = (await POST(req)) as unknown as { init: { status: number } }
    for (const cb of h.state.afterCallbacks) await cb()
    return res
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('screens each delivery once, keyed by the config row the secret resolved', async () => {
    // The row still holds the phone placeholder and the payload names
    // the real channel. Keys use neither: the body cannot steer them,
    // and adopting the channel id cannot change them.
    h.state.channelId = '15551230000'
    h.state.wabaId = '15551230000'
    const req = deliveryRequest([TEXT_MESSAGE], { channelId: 'NIGHTW-JJC9J' })

    const res = await deliver(req)

    expect(res.init.status).toBe(200)
    expect(h.screenWebhook).toHaveBeenCalledTimes(1)
    expect(h.clientIp).toHaveBeenCalledWith(req.headers)
    expect(h.screenWebhook.mock.calls[0][1]).toEqual({
      ip: '203.0.113.7',
      events: [
        { key: STATUS_KEY, kind: 'status' },
        { key: MSG_KEY, senderKey: '15551230000', kind: 'message' },
      ],
    })
    // The first callback still adopts the real channel id, in after().
    expect(h.state.configUpdates).toHaveLength(1)
    expect(h.state.configUpdates[0].phone_number_id).toBe('NIGHTW-JJC9J')
    expect(h.state.upsertCalls).toHaveLength(1)
  })

  it('answers 503 and queues nothing while an event is in flight elsewhere', async () => {
    h.screenWebhook.mockResolvedValue({ status: 503, decisions: [] })

    const res = (await POST(deliveryRequest())) as unknown as {
      init: { status: number }
    }

    // Whapi redelivers a non-200; by then the other delivery has
    // confirmed (a duplicate) or its lease has lapsed (processed).
    expect(res.init.status).toBe(503)
    expect(h.state.afterCallbacks).toHaveLength(0)
    expect(mockProcessMessage).not.toHaveBeenCalled()
    expect(h.state.messageStatusUpdates).toHaveLength(0)
    expect(h.confirmAccepted).not.toHaveBeenCalled()
  })

  it('skips duplicates, logging the count once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.screenWebhook.mockImplementation(
      screenAs((key) => (key === OTHER_KEY ? 'accept' : 'duplicate')),
    )

    await deliver(deliveryRequest([TEXT_MESSAGE, OTHER_MESSAGE]))

    expect(mockProcessMessage).toHaveBeenCalledTimes(1)
    expect(mockProcessMessage.mock.calls[0][0]).toMatchObject({
      id: OTHER_MESSAGE.id,
    })
    expect(h.state.messageStatusUpdates).toHaveLength(0)
    expect(
      warn.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.startsWith('[whapi-webhook] skipped')),
    ).toEqual(['[whapi-webhook] skipped 2 duplicate and 0 IP-limited event(s)'])
  })

  it('persists a rate-limited message without fan-out', async () => {
    h.screenWebhook.mockImplementation(
      screenAs((key) => (key === MSG_KEY ? 'rate_limited' : 'accept')),
    )

    await deliver(deliveryRequest())

    expect(mockProcessMessage).toHaveBeenCalledTimes(1)
    expect(mockProcessMessage.mock.calls[0][5]).toEqual({ fanOut: false })
    // Kept in the inbox…
    expect(h.state.upsertCalls).toHaveLength(1)
    // …but nothing answers it.
    expect(h.dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(h.runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(h.dispatchInboundToAiReply).not.toHaveBeenCalled()
  })

  it('processes an accepted message with the default options', async () => {
    h.screenWebhook.mockImplementation(
      screenAs((key) => (key === MSG_KEY ? 'rate_limited' : 'accept')),
    )

    await deliver(deliveryRequest([TEXT_MESSAGE, OTHER_MESSAGE]))

    expect(mockProcessMessage).toHaveBeenCalledTimes(2)
    const accepted = mockProcessMessage.mock.calls[1]
    expect(accepted[0]).toMatchObject({ id: OTHER_MESSAGE.id })
    expect(accepted[5]).toBeUndefined()
    expect(h.dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(h.state.messageStatusUpdates).toContainEqual({
      messageId: STATUS.id,
      status: 'delivered',
    })
  })

  it('confirms the accepted claims only after processing', async () => {
    await POST(deliveryRequest())
    // Nothing is persisted before after() runs, so nothing is confirmed.
    expect(h.confirmAccepted).not.toHaveBeenCalled()
    for (const cb of h.state.afterCallbacks) await cb()

    expect(h.confirmAccepted).toHaveBeenCalledTimes(1)
    expect(h.confirmAccepted.mock.calls[0][1]).toEqual([
      { key: STATUS_KEY, outcome: 'accept', claimToken: `tok:${STATUS_KEY}` },
      { key: MSG_KEY, outcome: 'accept', claimToken: `tok:${MSG_KEY}` },
    ])
    expect(mockProcessMessage.mock.invocationCallOrder[0]).toBeLessThan(
      h.confirmAccepted.mock.invocationCallOrder[0],
    )
  })

  it('leaves the claims unconfirmed when processing threw', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockProcessMessage.mockRejectedValueOnce(new Error('boom'))

    await deliver(deliveryRequest())

    // Unconfirmed claims lapse with their lease, so a redelivery is
    // processed rather than skipped as a duplicate.
    expect(mockProcessMessage).toHaveBeenCalledTimes(1)
    expect(h.confirmAccepted).not.toHaveBeenCalled()
  })

  it('answers 200 and processes nothing over the IP limit', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.screenWebhook.mockImplementation(screenAs(() => 'ip_limited'))

    const res = await deliver(deliveryRequest())

    // Never a 429: that only makes the gateway retry sooner.
    expect(res.init.status).toBe(200)
    expect(mockProcessMessage).not.toHaveBeenCalled()
    expect(h.state.messageStatusUpdates).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(
      '[whapi-webhook] skipped 0 duplicate and 2 IP-limited event(s)',
    )
  })

  it('rejects an unknown secret with 401 before any screening', async () => {
    const res = (await POST(
      deliveryRequest([TEXT_MESSAGE], { secret: 'b'.repeat(64) }),
    )) as unknown as { init: { status: number } }

    expect(res.init.status).toBe(401)
    expect(h.screenWebhook).not.toHaveBeenCalled()
    expect(h.state.afterCallbacks).toHaveLength(0)
  })
})
