import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { parseRcsWebhook, verifyRcsSignature } from './rcs-webhook';

const SECRET = 'rcs-test-secret-0123456789';
const enc = (s: string) => new TextEncoder().encode(s);
const sign = (raw: Uint8Array, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

describe('verifyRcsSignature', () => {
  const raw = enc('{"events":[]}');

  it('accepts the HMAC-SHA256 of the raw body', () => {
    expect(verifyRcsSignature(raw, sign(raw), SECRET)).toBe(true);
    expect(
      verifyRcsSignature(
        raw,
        sign(raw).toUpperCase().replace('SHA256', 'sha256'),
        SECRET
      )
    ).toBe(true);
  });

  it('refuses a signature made with another secret', () => {
    expect(
      verifyRcsSignature(raw, sign(raw, 'another-secret-xxxxxx'), SECRET)
    ).toBe(false);
  });

  it('refuses a missing or malformed header', () => {
    const hex = sign(raw).slice(7);
    for (const h of [
      undefined,
      null,
      '',
      hex,
      `sha1=${hex}`,
      `sha256=${hex.slice(2)}`,
      `sha256=${hex}00`,
      `sha256=${'z'.repeat(64)}`,
      42,
    ]) {
      expect(verifyRcsSignature(raw, h, SECRET)).toBe(false);
    }
  });

  it('refuses a body altered after signing', () => {
    const header = sign(raw);
    expect(verifyRcsSignature(enc('{"events":[ ]}'), header, SECRET)).toBe(
      false
    );
  });
});

describe('parseRcsWebhook', () => {
  it('keeps valid events and counts the rest as ignored', () => {
    const body = {
      events: [
        {
          messageId: 'm1',
          status: 'delivered',
          timestamp: '2026-11-20T10:00:00Z',
        },
        { messageId: 'm2', status: 'read', timestamp: 1763632800 },
        { messageId: 'm3', status: 'sent', timestamp: '1763632800' },
        {
          messageId: 'm4',
          status: 'failed',
          timestamp: 1763632800,
          errorCode: 4001,
        },
        { messageId: 'm5', status: 'failed', timestamp: 1763632800 },
        { messageId: '', status: 'sent', timestamp: 1 },
        { messageId: 'm6', status: 'bounced', timestamp: 1 },
        { messageId: 'm7', status: 'sent', timestamp: 'not a time' },
        { messageId: 'm8', status: 'sent' },
        'junk',
        null,
        [1],
      ],
    };
    const out = parseRcsWebhook(enc(JSON.stringify(body)));
    expect(out.ignored).toBe(7);
    expect(out.statuses).toEqual([
      {
        providerId: 'm1',
        state: 'delivered',
        at: new Date('2026-11-20T10:00:00Z'),
        errorCode: null,
      },
      {
        providerId: 'm2',
        state: 'read',
        at: new Date(1763632800 * 1000),
        errorCode: null,
      },
      {
        providerId: 'm3',
        state: 'sent',
        at: new Date(1763632800 * 1000),
        errorCode: null,
      },
      {
        providerId: 'm4',
        state: 'failed',
        at: new Date(1763632800 * 1000),
        errorCode: '4001',
      },
      {
        providerId: 'm5',
        state: 'failed',
        at: new Date(1763632800 * 1000),
        errorCode: 'unknown',
      },
    ]);
  });

  it('reads epoch seconds and ISO times alike', () => {
    const iso = '2026-11-20T10:00:00.000Z';
    const secs = Date.parse(iso) / 1000;
    const out = parseRcsWebhook(
      enc(
        JSON.stringify({
          events: [
            { messageId: 'a', status: 'sent', timestamp: iso },
            { messageId: 'b', status: 'sent', timestamp: secs },
            { messageId: 'c', status: 'sent', timestamp: String(secs) },
          ],
        })
      )
    );
    expect(out.statuses.map((s) => s.at.toISOString())).toEqual([
      iso,
      iso,
      iso,
    ]);
  });

  it('drops a code on a non-failed status', () => {
    const out = parseRcsWebhook(
      enc(
        JSON.stringify({
          events: [
            { messageId: 'a', status: 'read', timestamp: 1, errorCode: 'x' },
          ],
        })
      )
    );
    expect(out.statuses[0].errorCode).toBeNull();
  });

  it('never throws on a body that is not the expected shape', () => {
    for (const s of ['not json', '[]', '{}', '{"events":{}}', 'null', '']) {
      expect(parseRcsWebhook(enc(s))).toEqual({ statuses: [], ignored: 1 });
    }
  });
});
