import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  API_LIMIT_DEFAULTS,
  FixedWindowLimiter,
  apiIpKey,
  apiLimitsFrom,
  apiRequestLogLine,
  isApiLimitExempt,
  isRequestLogOn,
  logIpPrefix,
  redactApiPath,
  requestIdFor,
} from '../api-edge';
import { ipKey } from '../ip';

describe('requestIdFor', () => {
  const gen = () => 'generated';

  it('keeps a short safe inbound id', () => {
    expect(requestIdFor('abc-123_X.y', gen)).toBe('abc-123_X.y');
    expect(requestIdFor('a'.repeat(64), gen)).toBe('a'.repeat(64));
  });

  it('replaces a missing, long or unsafe one', () => {
    for (const bad of [
      null,
      undefined,
      '',
      'a'.repeat(65),
      'has space',
      'line\nbreak',
      'semi;colon',
      '<script>',
      'ünïcode',
    ]) {
      expect(requestIdFor(bad, gen), String(bad)).toBe('generated');
    }
  });

  it('generates a UUID by default', () => {
    expect(requestIdFor(null)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('isApiLimitExempt', () => {
  it('exempts every webhook, the public API, crons and health probes', () => {
    for (const p of [
      '/api/whatsapp/webhook',
      '/api/whatsapp/meta/webhook',
      '/api/whatsapp/openwa/webhook',
      '/api/sms/webhook',
      '/api/rcs/webhook',
      '/api/taamul-sales/webhook',
      '/api/pbx/gateway/events',
      '/api/pbx/yeastar/events/tok',
      '/api/v1/messages',
      '/api/v1',
      '/api/automations/cron',
      '/api/flows/cron',
      '/api/journeys/cron',
      '/api/pbx/cron',
      '/api/deal-rooms/cron',
      '/api/whatsapp/broadcast/cron',
      '/api/whatsapp/health/cron',
      '/api/healthz',
      '/api/readyz',
      '/api/metrics',
    ]) {
      expect(isApiLimitExempt(p), p).toBe(true);
    }
  });

  it('limits the dashboard routes, the webhook admin screens included', () => {
    for (const p of [
      '/api/contacts',
      '/api/account/webhooks',
      '/api/whatsapp/broadcast',
      '/api/v1x/thing',
      '/api/healthz/extra',
      '/api/cron-settings',
    ]) {
      expect(isApiLimitExempt(p), p).toBe(false);
    }
  });

  it('covers every webhook and cron route in the tree', () => {
    const root = path.join(process.cwd(), 'src/app/api');
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === 'route.ts') {
          routes.push(
            '/api/' +
              path
                .relative(root, dir)
                .split(path.sep)
                .map((s) => (s.startsWith('[') ? 'x' : s))
                .join('/')
          );
        }
      }
    };
    walk(root);
    const inbound = routes.filter((r) => /\/(webhook|cron)(\/|$)/.test(r));
    expect(inbound.length).toBeGreaterThan(10);
    for (const r of inbound) expect(isApiLimitExempt(r), r).toBe(true);
  });
});

describe('apiLimitsFrom', () => {
  it('defaults to 600 per person and 1200 per IP a minute', () => {
    expect(apiLimitsFrom({})).toEqual(API_LIMIT_DEFAULTS);
    expect(API_LIMIT_DEFAULTS).toEqual({
      perUser: 600,
      perIp: 1200,
      windowMs: 60_000,
    });
  });

  it('takes a non-negative integer override and ignores junk', () => {
    expect(
      apiLimitsFrom({
        EDGE_API_LIMIT_PER_USER: '5',
        EDGE_API_LIMIT_PER_IP: '0',
      })
    ).toMatchObject({ perUser: 5, perIp: 0 });
    expect(
      apiLimitsFrom({
        EDGE_API_LIMIT_PER_USER: '-1',
        EDGE_API_LIMIT_PER_IP: 'lots',
      })
    ).toMatchObject({ perUser: 600, perIp: 1200 });
  });
});

describe('FixedWindowLimiter', () => {
  it('refuses past the limit until the window resets, with Retry-After', () => {
    const l = new FixedWindowLimiter();
    expect(l.hit('k', 2, 60_000, 0).allowed).toBe(true);
    expect(l.hit('k', 2, 60_000, 1000).allowed).toBe(true);
    expect(l.hit('k', 2, 60_000, 1500)).toEqual({
      allowed: false,
      retryAfterSeconds: 59,
    });
    expect(l.hit('other', 2, 60_000, 1500).allowed).toBe(true);
    expect(l.hit('k', 2, 60_000, 60_000).allowed).toBe(true);
  });

  it('stays bounded, evicting the oldest window first', () => {
    const l = new FixedWindowLimiter(3);
    l.hit('a', 1, 60_000, 0);
    l.hit('b', 1, 60_000, 1);
    l.hit('c', 1, 60_000, 2);
    l.hit('d', 1, 60_000, 3);
    expect(l.size).toBe(3);
    // 'a' was evicted, so it is forgiven (fail open); 'b' is still held.
    expect(l.hit('a', 1, 60_000, 4).allowed).toBe(true);
    expect(l.hit('c', 1, 60_000, 5).allowed).toBe(false);
  });
});

describe('apiIpKey', () => {
  it("gives ip.ts's answers", () => {
    for (const ip of [
      '203.0.113.7',
      '::ffff:203.0.113.7',
      '::FFFF:cb00:7107',
      '2001:db8:1:2::1',
      '2001:0db8:0001:0002:ffff:eeee:dddd:cccc',
      '2001:db8:1:3::1',
      '::1',
      'fe80::1%eth0',
      ' 198.51.100.2 ',
      'not-an-ip',
      '1:2:3:4:5:6:7:8:9',
      '2001:db8::1::2',
    ]) {
      expect(apiIpKey(ip), ip).toBe(ipKey(ip));
    }
    expect(apiIpKey(undefined)).toBe('unknown');
  });

  it('imports no Node built-in (the middleware runs in the Edge runtime)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/edge/api-edge.ts'),
      'utf8'
    );
    expect(src).not.toMatch(/from ['"]node:/);
    expect(src).not.toMatch(/^import /m);
  });
});

describe('the access log', () => {
  it('is off unless EDGE_REQUEST_LOG=1', () => {
    expect(isRequestLogOn({})).toBe(false);
    expect(isRequestLogOn({ EDGE_REQUEST_LOG: '0' })).toBe(false);
    expect(isRequestLogOn({ EDGE_REQUEST_LOG: 'true' })).toBe(false);
    expect(isRequestLogOn({ EDGE_REQUEST_LOG: '1' })).toBe(true);
  });

  it('shows only a prefix of the client IP', () => {
    expect(logIpPrefix('203.0.113.7')).toBe('203.0.113.0/24');
    expect(logIpPrefix('2001:db8:1:2::1')).toBe('2001:db8:1::/48');
    expect(logIpPrefix('::ffff:203.0.113.7')).toBe('203.0.113.0/24');
    expect(logIpPrefix('garbage')).toBe('other');
    expect(logIpPrefix(undefined)).toBeNull();
  });

  it('redacts token segments and long opaque ones, keeps UUIDs', () => {
    const uuid = '0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4';
    expect(redactApiPath('/api/pbx/yeastar/events/short')).toBe(
      '/api/pbx/yeastar/events/:redacted'
    );
    expect(redactApiPath('/api/invitations/abc/redeem')).toBe(
      '/api/invitations/:redacted/redeem'
    );
    expect(redactApiPath('/api/public/web-form/' + 'f'.repeat(64))).toBe(
      '/api/public/web-form/:redacted'
    );
    expect(redactApiPath(`/api/x/${'a'.repeat(40)}/y`)).toBe(
      '/api/x/:redacted/y'
    );
    expect(redactApiPath(`/api/contacts/${uuid}`)).toBe(
      `/api/contacts/${uuid}`
    );
    expect(redactApiPath('/api/' + 'a/'.repeat(200)).length).toBeLessThan(205);
  });

  it('is one JSON line with exactly the allowed fields', () => {
    const line = apiRequestLogLine({
      time: new Date('2026-11-28T10:00:00Z'),
      requestId: 'rid-1',
      method: 'POST',
      pathname: '/api/invitations/secret-token/redeem',
      ip: '203.0.113.7',
      userId: 'user-1',
    });
    expect(line).not.toContain('\n');
    expect(line).not.toContain('secret-token');
    expect(line).not.toContain('203.0.113.7');
    expect(JSON.parse(line)).toEqual({
      time: '2026-11-28T10:00:00.000Z',
      msg: 'api_request',
      request_id: 'rid-1',
      method: 'POST',
      path: '/api/invitations/:redacted/redeem',
      ip: '203.0.113.0/24',
      user_id: 'user-1',
    });
  });
});
