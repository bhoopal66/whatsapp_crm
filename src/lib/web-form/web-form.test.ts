import { describe, expect, it } from 'vitest';

import {
  decideOrigin,
  normalizeAllowedOrigin,
  originOfUrl,
  parseAllowedOrigins,
} from './origin';
import {
  bodyKindOf,
  isHoneypotFilled,
  isWellFormedToken,
  readFields,
  validateSubmission,
} from './submission';
import { hostedFormUrl, htmlFormSnippet, submitEndpoint } from './snippet';

describe('normalizeAllowedOrigin', () => {
  it('accepts https origins, lower-cased, with a port', () => {
    expect(normalizeAllowedOrigin(' HTTPS://www.Example.com/ ')).toBe(
      'https://www.example.com'
    );
    expect(normalizeAllowedOrigin('https://shop.example.co.uk:8443')).toBe(
      'https://shop.example.co.uk:8443'
    );
  });
  it('refuses http, paths, credentials and junk', () => {
    for (const bad of [
      'http://example.com',
      'https://example.com/apply',
      'https://user@example.com',
      'example.com',
      'https://',
      'https://-bad.com',
      '*',
    ]) {
      expect(normalizeAllowedOrigin(bad), bad).toBeNull();
    }
  });
});

describe('parseAllowedOrigins', () => {
  it('splits lines, drops blanks and duplicates, reports bad lines', () => {
    expect(
      parseAllowedOrigins(
        'https://a.com\n\n https://A.com/ \r\nhttp://b.com\nhttps://c.com'
      )
    ).toEqual({
      origins: ['https://a.com', 'https://c.com'],
      invalid: ['http://b.com'],
    });
  });
});

describe('originOfUrl', () => {
  it('reads an origin or answers null', () => {
    expect(originOfUrl('https://crm.example.com/x?y')).toBe(
      'https://crm.example.com'
    );
    expect(originOfUrl('nope')).toBeNull();
    expect(originOfUrl(undefined)).toBeNull();
  });
});

describe('decideOrigin', () => {
  const selfOrigins = ['https://crm.example.com'];
  it('lets the hosted page in without a CORS header', () => {
    expect(
      decideOrigin({
        origin: 'https://crm.example.com',
        selfOrigins,
        allowed: [],
      })
    ).toEqual({ ok: true, cors: null });
  });
  it('echoes a listed origin', () => {
    expect(
      decideOrigin({
        origin: 'https://www.shop.com',
        selfOrigins,
        allowed: ['https://www.shop.com'],
      })
    ).toEqual({ ok: true, cors: 'https://www.shop.com' });
  });
  it('refuses an unlisted site, with or without a list', () => {
    expect(
      decideOrigin({ origin: 'https://evil.com', selfOrigins, allowed: [] }).ok
    ).toBe(false);
    expect(
      decideOrigin({
        origin: 'https://evil.com',
        selfOrigins,
        allowed: ['https://www.shop.com'],
      }).ok
    ).toBe(false);
  });
  it('takes no Origin only while the list is empty, and never "null"', () => {
    expect(decideOrigin({ origin: null, selfOrigins, allowed: [] })).toEqual({
      ok: true,
      cors: null,
    });
    expect(
      decideOrigin({ origin: null, selfOrigins, allowed: ['https://a.com'] }).ok
    ).toBe(false);
    expect(decideOrigin({ origin: 'null', selfOrigins, allowed: [] }).ok).toBe(
      false
    );
  });
});

describe('body reading', () => {
  it('knows JSON and urlencoded only', () => {
    expect(bodyKindOf('application/json; charset=utf-8')).toBe('json');
    expect(bodyKindOf('application/x-www-form-urlencoded')).toBe('form');
    expect(bodyKindOf('multipart/form-data; boundary=x')).toBeNull();
    expect(bodyKindOf(null)).toBeNull();
  });
  it('keeps string fields only', () => {
    expect(readFields('json', '{"name":"A","phone":971,"x":["y"]}')).toEqual({
      name: 'A',
    });
    expect(readFields('json', '[1]')).toBeNull();
    expect(readFields('json', '{bad')).toBeNull();
    expect(readFields('form', 'name=A+B&phone=%2B971&name=C')).toEqual({
      name: 'A B',
      phone: '+971',
    });
  });
  it('spots the honeypot', () => {
    expect(isHoneypotFilled({ website: ' http://spam ' })).toBe(true);
    expect(isHoneypotFilled({ website: '  ' })).toBe(false);
    expect(isHoneypotFilled({})).toBe(false);
  });
  it('checks the token shape', () => {
    expect(isWellFormedToken('a'.repeat(64))).toBe(true);
    expect(isWellFormedToken('A'.repeat(64))).toBe(false);
    expect(isWellFormedToken('a'.repeat(63))).toBe(false);
  });
});

describe('validateSubmission', () => {
  it('normalises the phone and cleans the fields', () => {
    expect(
      validateSubmission({
        name: '  Sara ',
        phone: '+971 50 123 4567',
        email: 'Sara@Example.com',
        message: ' Call me ',
        page_url: 'https://www.shop.com/apply?utm=1',
      })
    ).toEqual({
      ok: true,
      value: {
        name: 'Sara',
        phone: '971501234567',
        email: 'sara@example.com',
        message: 'Call me',
        pageUrl: 'https://www.shop.com/apply',
      },
    });
  });
  it('falls back to the Referer for the page', () => {
    const out = validateSubmission(
      { phone: '971501234567' },
      'https://crm.example.com/f/abc'
    );
    expect(out.ok && out.value.pageUrl).toBe('https://crm.example.com/f/abc');
  });
  it('refuses a missing or bad phone, a bad email and long fields', () => {
    expect(validateSubmission({})).toMatchObject({ error: 'phone_required' });
    expect(validateSubmission({ phone: '050 123 4567' })).toMatchObject({
      error: 'bad_phone',
    });
    expect(
      validateSubmission({ phone: '971501234567', email: 'nope' })
    ).toMatchObject({ error: 'bad_email' });
    expect(
      validateSubmission({ phone: '971501234567', message: 'x'.repeat(2001) })
    ).toMatchObject({ error: 'too_long', field: 'message' });
    expect(
      validateSubmission({ phone: '971501234567', name: 'x'.repeat(121) })
    ).toMatchObject({ error: 'too_long', field: 'name' });
  });
  it('drops a page url that is not http(s)', () => {
    const out = validateSubmission({
      phone: '971501234567',
      page_url: 'javascript:alert(1)',
    });
    expect(out.ok && out.value.pageUrl).toBeNull();
  });
});

describe('snippet', () => {
  const tok = 'a'.repeat(64);
  it('builds the hosted link and the endpoint from the site url', () => {
    expect(hostedFormUrl('https://crm.example.com/', tok)).toBe(
      `https://crm.example.com/f/${tok}`
    );
    expect(submitEndpoint('https://crm.example.com', tok)).toBe(
      `https://crm.example.com/api/public/web-form/${tok}`
    );
  });
  it('is a script-free form posting to the endpoint, with the honeypot', () => {
    const html = htmlFormSnippet('https://crm.example.com', tok);
    expect(html).toContain(
      `<form method="post" action="https://crm.example.com/api/public/web-form/${tok}">`
    );
    expect(html).toContain('name="website"');
    expect(html).toContain('name="phone"');
    expect(html).not.toMatch(/<script|<iframe/);
  });
});
