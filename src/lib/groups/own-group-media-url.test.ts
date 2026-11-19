import { afterEach, describe, expect, it, vi } from 'vitest';

import { ownGroupMediaLink, parseOwnGroupMedia } from './own-group-media-url';

const ACCT = '11111111-1111-4111-8111-111111111111';
const PATH = `account-${ACCT}/groups/1731999999999-scan.pdf`;
const url = (path = PATH, origin = 'https://crm.example.com') =>
  `${origin}/storage/v1/object/public/chat-media/${path}`;

describe('parseOwnGroupMedia', () => {
  it('returns the object path for an own-account group upload', () => {
    expect(parseOwnGroupMedia(url(), PATH, ACCT)).toBe(PATH);
  });

  it("refuses another account's folder", () => {
    const other = 'account-22222222-2222-4222-8222-222222222222/groups/f.pdf';
    expect(parseOwnGroupMedia(url(other), other, ACCT)).toBeNull();
  });

  it('refuses another folder of the own account', () => {
    const p = `account-${ACCT}/staged/f.pdf`;
    expect(parseOwnGroupMedia(url(p), p, ACCT)).toBeNull();
  });

  it('refuses another bucket', () => {
    const u = `https://crm.example.com/storage/v1/object/public/call-recordings/${PATH}`;
    expect(parseOwnGroupMedia(u, PATH, ACCT)).toBeNull();
  });

  it('refuses a dot segment, raw or resolved', () => {
    const p = `account-${ACCT}/groups/../groups/f.pdf`;
    expect(parseOwnGroupMedia(url(p), p, ACCT)).toBeNull();
    expect(
      parseOwnGroupMedia(url(p), `account-${ACCT}/groups/f.pdf`, ACCT)
    ).toBeNull();
    const enc = `account-${ACCT}/groups/%2e%2e/f.pdf`;
    expect(parseOwnGroupMedia(url(enc), enc, ACCT)).toBeNull();
  });

  it('refuses a query string or a fragment', () => {
    expect(parseOwnGroupMedia(`${url()}?x=1`, PATH, ACCT)).toBeNull();
    expect(parseOwnGroupMedia(`${url()}?`, PATH, ACCT)).toBeNull();
    expect(parseOwnGroupMedia(`${url()}#a`, PATH, ACCT)).toBeNull();
  });

  it('refuses http and non-URLs', () => {
    expect(
      parseOwnGroupMedia(url(PATH, 'http://crm.example.com'), PATH, ACCT)
    ).toBeNull();
    expect(parseOwnGroupMedia('not a url', PATH, ACCT)).toBeNull();
    expect(parseOwnGroupMedia(42, PATH, ACCT)).toBeNull();
  });

  it('refuses a path that is not the URL’s object', () => {
    expect(
      parseOwnGroupMedia(url(), `account-${ACCT}/groups/other.pdf`, ACCT)
    ).toBeNull();
    expect(parseOwnGroupMedia(url(), undefined, ACCT)).toBeNull();
  });

  it('refuses the folder itself (no file name)', () => {
    const p = `account-${ACCT}/groups`;
    expect(parseOwnGroupMedia(url(p), p, ACCT)).toBeNull();
  });
});

describe('ownGroupMediaLink', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('rebuilds the link on the configured public origin', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.org/');
    expect(ownGroupMediaLink(PATH)).toBe(
      `https://db.example.org/storage/v1/object/public/chat-media/${PATH}`
    );
  });
});
