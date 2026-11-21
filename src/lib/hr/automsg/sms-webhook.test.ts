import { describe, expect, it } from 'vitest';
import {
  ipAllowed,
  isSmsOptOut,
  parseSmsWebhook,
  verifySmsToken,
} from './sms-webhook';

const SECRET = 'sms-test-secret-0123456789';
const enc = (v: unknown) =>
  new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));

describe('verifySmsToken', () => {
  const cfg = { secret: SECRET, allowQueryToken: false };

  it('accepts the header, refuses a wrong or missing one', () => {
    expect(verifySmsToken(SECRET, null, cfg)).toBe(true);
    expect(verifySmsToken(SECRET + 'x', null, cfg)).toBe(false);
    expect(verifySmsToken('', null, cfg)).toBe(false);
    expect(verifySmsToken(null, null, cfg)).toBe(false);
  });

  it('reads ?token= only when allowed and the header is absent', () => {
    expect(verifySmsToken(null, SECRET, cfg)).toBe(false);
    const allowed = { ...cfg, allowQueryToken: true };
    expect(verifySmsToken(null, SECRET, allowed)).toBe(true);
    // A wrong header is not rescued by a right query token.
    expect(verifySmsToken('wrong', SECRET, allowed)).toBe(false);
  });
});

describe('ipAllowed', () => {
  it('lets everyone through with no list', () => {
    expect(ipAllowed(undefined, { allowIps: [] })).toBe(true);
    expect(ipAllowed('1.2.3.4', { allowIps: [] })).toBe(true);
  });

  it('with a list: exact matches only, an unknown IP refused', () => {
    const cfg = { allowIps: ['10.0.0.5'] };
    expect(ipAllowed('10.0.0.5', cfg)).toBe(true);
    expect(ipAllowed('10.0.0.50', cfg)).toBe(false);
    expect(ipAllowed(undefined, cfg)).toBe(false);
  });
});

describe('isSmsOptOut', () => {
  it('knows STOP, UNSUBSCRIBE and the HR opt-out phrases', () => {
    expect(isSmsOptOut(' stop ')).toBe(true);
    expect(isSmsOptOut('Unsubscribe')).toBe(true);
    expect(isSmsOptOut('please do not contact me')).toBe(true);
    expect(isSmsOptOut('I will stop by tomorrow')).toBe(false);
    expect(isSmsOptOut('Thanks, see you Monday')).toBe(false);
  });
});

describe('parseSmsWebhook', () => {
  it('maps sms_result statuses and keeps every ref id', () => {
    const p = parseSmsWebhook(
      enc({
        sn: 'x',
        sms_result: [
          {
            number: '+971501234567',
            user_id: 12,
            status: 'SENDING',
            ref_id: 'R1',
          },
          {
            number: '+971501234567',
            user_id: '12',
            status: 'SENT_OK',
            time: 1763632800,
          },
          {
            number: '971501234567',
            user_id: 13,
            status: 'DELIVERED',
            time: '2026-11-20 10:00:00',
          },
          {
            number: '971501234567',
            user_id: 14,
            status: 'FAILED',
            ref_id: 'R2',
          },
          { number: '971501234567', user_id: 'abc', status: 'SENT_OK' },
          { user_id: 15, status: 'SENT_OK' },
        ],
      })
    );
    expect(p.refs).toEqual([
      { userId: '12', number: '+971501234567', refId: 'R1' },
      { userId: '14', number: '971501234567', refId: 'R2' },
    ]);
    expect(p.statuses.map((s) => [s.userId, s.state, s.reason])).toEqual([
      ['12', 'sent', null],
      ['13', 'delivered', null],
      ['14', 'failed', 'FAILED'],
    ]);
    expect(p.statuses[0].at?.toISOString()).toBe('2025-11-20T10:00:00.000Z');
    // SENDING (status ignored), the bad user id and the missing number.
    expect(p.ignored).toBe(3);
  });

  it('maps sms_deliver_status codes', () => {
    const p = parseSmsWebhook(
      enc({
        sms_deliver_status: [
          { number: '971501234567', ref_id: 'R1', status_code: 0 },
          { number: '971501234567', ref_id: 'R2', status_code: 40 },
          { number: '971501234567', ref_id: 'R3', status_code: 64 },
          { number: '971501234567', status_code: 255 },
          { number: '971501234567', status_code: 10 },
          { number: '971501234567', status_code: 256 },
          { number: '971501234567', status_code: '0' },
        ],
      })
    );
    expect(
      p.statuses.map((s) => [s.userId, s.refId, s.state, s.reason])
    ).toEqual([
      [null, 'R1', 'delivered', null],
      [null, 'R2', 'sent', null],
      [null, 'R3', 'failed', '64'],
      [null, null, 'failed', '255'],
    ]);
    expect(p.ignored).toBe(3);
  });

  it('acts on an incoming STOP only, and keeps no other text', () => {
    const p = parseSmsWebhook(
      enc({
        sms: [
          { number: '+971501234567', text: 'STOP' },
          { number: '+971509999999', text: 'my salary is 5000, call me' },
          { text: 'STOP' },
        ],
      })
    );
    expect(p.optOutNumbers).toEqual(['+971501234567']);
    expect(JSON.stringify(p)).not.toContain('salary');
    expect(p.ignored).toBe(2);
  });

  it('never throws on junk', () => {
    expect(parseSmsWebhook(enc('not json')).ignored).toBe(1);
    expect(parseSmsWebhook(enc([1, 2])).ignored).toBe(1);
    expect(parseSmsWebhook(enc({ other: 1 })).ignored).toBe(1);
    expect(parseSmsWebhook(enc({ sms_result: [null, 'x', 3] })).ignored).toBe(
      3
    );
  });
});
