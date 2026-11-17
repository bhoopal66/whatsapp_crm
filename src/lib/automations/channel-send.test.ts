import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendTemplate: vi.fn(),
  resolveBotChannel: vi.fn(),
  assertAutoStart: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
}))

vi.mock('@/lib/whatsapp/provider', () => ({
  sendText: h.sendText,
  sendTemplate: h.sendTemplate,
}))
vi.mock('@/lib/flows/channel-send', () => ({
  engineSendInteractiveButtons: vi.fn(),
  engineSendInteractiveList: vi.fn(),
}))
vi.mock('@/lib/whatsapp/channels', () => ({
  resolveBotChannel: h.resolveBotChannel,
}))
vi.mock('@/lib/team-activity/auto-guard', () => ({
  assertAutoStartAllowed: h.assertAutoStart,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        update: () => chain,
        maybeSingle: () =>
          Promise.resolve({
            data: { id: 'contact-1', phone: '+971501234567' },
            error: null,
          }),
        insert: (row: Record<string, unknown>) => {
          h.inserts.push({ table, row })
          return Promise.resolve({ error: null })
        },
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ error: null }).then(ok),
      }
      return chain
    },
  }),
}))

import { engineSendText } from './channel-send'

const OPENWA = { id: 'ch-openwa', provider: 'openwa' }

const ARGS = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'Hello',
}

beforeEach(() => {
  h.inserts = []
  h.sendText.mockResolvedValue({ messageId: 'wamid-1' })
  h.resolveBotChannel.mockResolvedValue(OPENWA)
  h.assertAutoStart.mockResolvedValue(undefined)
})

describe('automation engineSendText and the number daily limit (migration 204)', () => {
  it('asks before sending, and sends when allowed', async () => {
    await engineSendText(ARGS)
    expect(h.assertAutoStart).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conv-1',
      OPENWA,
      'automations',
    )
    expect(h.sendText).toHaveBeenCalledTimes(1)
  })

  it('sends and records nothing when the start is refused', async () => {
    h.assertAutoStart.mockRejectedValue(new Error('at its daily limit'))
    await expect(engineSendText(ARGS)).rejects.toThrow('at its daily limit')
    expect(h.sendText).not.toHaveBeenCalled()
    expect(h.inserts).toEqual([])
  })
})
