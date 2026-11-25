import { describe, expect, it, vi } from 'vitest';

import { clientIp } from '../client-ip';

const h = (init: Record<string, string>) => new Headers(init);

describe('clientIp', () => {
  it('is undefined when no header is configured, whatever the request says', () => {
    expect(clientIp(h({ 'x-forwarded-for': '1.2.3.4' }), {})).toBeUndefined();
  });

  it('reads a single-value header (cf-connecting-ip, x-real-ip)', () => {
    const env = { EDGE_CLIENT_IP_HEADER: 'CF-Connecting-IP' };
    expect(clientIp(h({ 'cf-connecting-ip': ' 203.0.113.9 ' }), env)).toBe(
      '203.0.113.9'
    );
    expect(
      clientIp(h({ 'x-real-ip': '198.51.100.7' }), {
        EDGE_CLIENT_IP_HEADER: 'x-real-ip',
      })
    ).toBe('198.51.100.7');
    expect(clientIp(h({}), env)).toBeUndefined();
  });

  it('takes the x-forwarded-for entry one hop from the right by default', () => {
    const env = { EDGE_CLIENT_IP_HEADER: 'x-forwarded-for' };
    // The left-most entry is whatever the client sent; never trusted.
    expect(
      clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), env)
    ).toBe('203.0.113.9');
    expect(clientIp(h({ 'x-forwarded-for': '203.0.113.9' }), env)).toBe(
      '203.0.113.9'
    );
  });

  it('counts EDGE_TRUSTED_PROXY_HOPS from the right', () => {
    const env = {
      EDGE_CLIENT_IP_HEADER: 'x-forwarded-for',
      EDGE_TRUSTED_PROXY_HOPS: '2',
    };
    expect(
      clientIp(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }), env)
    ).toBe('203.0.113.9');
    // Fewer entries than trusted proxies: not routed through them.
    expect(clientIp(h({ 'x-forwarded-for': '10.0.0.2' }), env)).toBeUndefined();
  });

  it('falls back to one hop on an invalid hop count', () => {
    for (const hops of ['0', '-1', 'abc', '1.5']) {
      const env = {
        EDGE_CLIENT_IP_HEADER: 'x-forwarded-for',
        EDGE_TRUSTED_PROXY_HOPS: hops,
      };
      expect(clientIp(h({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), env)).toBe(
        '1.1.1.1'
      );
    }
  });
});

describe('clientIp without EDGE_CLIENT_IP_HEADER', () => {
  it('warns once in production, never in development', async () => {
    const { clientIp, resetClientIpWarning } = await import('../client-ip');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetClientIpWarning();
    const h = new Headers({ 'cf-connecting-ip': '1.2.3.4' });
    expect(clientIp(h, { NODE_ENV: 'development' })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    clientIp(h, { NODE_ENV: 'production' });
    clientIp(h, { NODE_ENV: 'production' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/EDGE_CLIENT_IP_HEADER/);
    warn.mockRestore();
  });
});
