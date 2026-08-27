import { describe, it, expect } from 'vitest'

import {
  buildWebhookUrl,
  extractWebhookSecret,
  generateWebhookSecret,
  redactWebhookUrl,
  secretsMatch,
} from './whapi-webhook-auth'

describe('generateWebhookSecret', () => {
  it('produces 64 hex chars and does not repeat', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('secretsMatch', () => {
  it('accepts an exact match', () => {
    const secret = generateWebhookSecret()
    expect(secretsMatch(secret, secret)).toBe(true)
  })

  it('rejects a mismatch', () => {
    expect(secretsMatch(generateWebhookSecret(), generateWebhookSecret())).toBe(false)
  })

  it('rejects rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on unequal lengths, and that throw is
    // itself an oracle for the secret's length — the implementation
    // hashes first so every input takes one path.
    expect(secretsMatch('short', generateWebhookSecret())).toBe(false)
  })

  it('rejects empty or missing values instead of matching them', () => {
    expect(secretsMatch('', '')).toBe(false)
    expect(secretsMatch(null, 'x')).toBe(false)
    expect(secretsMatch('x', undefined)).toBe(false)
  })
})

describe('extractWebhookSecret', () => {
  const req = (url: string, headers: Record<string, string> = {}) =>
    ({
      url,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    }) as unknown as Request

  it('reads the query parameter Whapi is registered with', () => {
    expect(
      extractWebhookSecret(req('https://crm.test/api/whatsapp/webhook?secret=abc123')),
    ).toBe('abc123')
  })

  it('prefers an X-Whapi-Secret header, for proxies that strip the query', () => {
    expect(
      extractWebhookSecret(
        req('https://crm.test/api/whatsapp/webhook?secret=fromquery', {
          'x-whapi-secret': 'fromheader',
        }),
      ),
    ).toBe('fromheader')
  })

  it('returns null when no secret is present', () => {
    expect(extractWebhookSecret(req('https://crm.test/api/whatsapp/webhook'))).toBeNull()
  })
})

describe('buildWebhookUrl', () => {
  it('appends the secret to the webhook path', () => {
    expect(buildWebhookUrl('https://crm.example.com', 'sekret')).toBe(
      'https://crm.example.com/api/whatsapp/webhook?secret=sekret',
    )
  })

  it('tolerates a trailing slash on the origin', () => {
    expect(buildWebhookUrl('https://crm.example.com/', 'sekret')).toBe(
      'https://crm.example.com/api/whatsapp/webhook?secret=sekret',
    )
  })

  it('refuses a plaintext origin, because Whapi will not deliver to one', () => {
    // Failing here — with a message naming NEXT_PUBLIC_SITE_URL — beats
    // an opaque rejection from PATCH /settings later.
    expect(() => buildWebhookUrl('http://localhost:3000', 'sekret')).toThrow(/HTTPS/)
  })
})

describe('redactWebhookUrl', () => {
  it('keeps the host readable while masking the secret', () => {
    expect(
      redactWebhookUrl('https://crm.example.com/api/whatsapp/webhook?secret=abcdef123456'),
    ).toBe('https://crm.example.com/api/whatsapp/webhook?secret=abcd****')
  })

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(redactWebhookUrl('not a url')).toBe('not a url')
  })
})
