import { describe, expect, it } from 'vitest';

import { isCrossSiteApiWrite } from './same-origin';

const req = (
  method: string,
  pathname: string,
  headers: Record<string, string> = {}
) => ({
  method,
  pathname,
  headers: new Headers(headers),
});

describe('isCrossSiteApiWrite', () => {
  it('lets the app’s own writes through', () => {
    expect(
      isCrossSiteApiWrite(
        req('POST', '/api/contacts', { 'sec-fetch-site': 'same-origin' })
      )
    ).toBe(false);
    expect(
      isCrossSiteApiWrite(
        req('PATCH', '/api/contacts/1', {
          origin: 'https://crm.example.com',
          host: 'crm.example.com',
        })
      )
    ).toBe(false);
    // Behind a proxy that rewrites Host to the container.
    expect(
      isCrossSiteApiWrite(
        req('DELETE', '/api/contacts/1', {
          origin: 'https://crm.example.com',
          host: 'localhost:3000',
          'x-forwarded-host': 'crm.example.com',
        })
      )
    ).toBe(false);
  });

  it('refuses writes a browser made from another site or subdomain', () => {
    for (const site of ['cross-site', 'same-site'])
      expect(
        isCrossSiteApiWrite(
          req('POST', '/api/contacts', { 'sec-fetch-site': site })
        ),
        site
      ).toBe(true);
    expect(
      isCrossSiteApiWrite(
        req('POST', '/api/contacts', {
          origin: 'https://evil.example',
          host: 'crm.example.com',
        })
      )
    ).toBe(true);
    expect(
      isCrossSiteApiWrite(
        req('POST', '/api/contacts', {
          origin: 'null',
          host: 'crm.example.com',
        })
      )
    ).toBe(true);
    expect(
      isCrossSiteApiWrite(
        req('POST', '/api/contacts', { origin: 'not a url', host: 'x' })
      )
    ).toBe(true);
  });

  it('leaves reads, other paths, exempt APIs and non-browser callers alone', () => {
    const evil = { 'sec-fetch-site': 'cross-site' };
    expect(isCrossSiteApiWrite(req('GET', '/api/contacts', evil))).toBe(false);
    expect(isCrossSiteApiWrite(req('OPTIONS', '/api/contacts', evil))).toBe(
      false
    );
    expect(isCrossSiteApiWrite(req('POST', '/inbox', evil))).toBe(false);
    expect(isCrossSiteApiWrite(req('POST', '/apiary', evil))).toBe(false);
    expect(isCrossSiteApiWrite(req('POST', '/api/v1/messages', evil))).toBe(
      false
    );
    expect(
      isCrossSiteApiWrite(req('POST', '/api/public/web-form/abc', evil))
    ).toBe(false);
    // A webhook or cron: no browser headers at all.
    expect(
      isCrossSiteApiWrite(req('POST', '/api/whatsapp/webhook', { host: 'x' }))
    ).toBe(false);
  });
});
