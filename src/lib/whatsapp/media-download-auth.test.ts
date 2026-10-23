import { afterEach, describe, expect, it, vi } from 'vitest';

// Untrusted hops go through the SSRF guard's address-pinned transport,
// trusted gateway hops through plain fetch; both are stubbed below.
vi.mock('@/lib/webhooks/safe-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/webhooks/safe-fetch')>()),
  guardedRequest: vi.fn(),
}));

import { guardedRequest } from '@/lib/webhooks/safe-fetch';

import { downloadMedia as whapiDownload, isWhapiMediaHost } from './whapi-api';
import { downloadMedia as metaDownload, isMetaMediaHost } from './meta-api';
import { downloadMedia as mirrorDefaultDownload } from './mirror-inbound-media';

// The channel token must only ever reach the gateway's own hosts. A
// message's `media_url` is sender-controlled and forwarding downloads
// it through these functions, so an unconditional Bearer header hands
// the token to whoever owns the URL.

interface Call {
  url: string;
  auth: string | null;
  redirect: RequestRedirect | undefined;
}

function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  const record = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      auth: new Headers(init?.headers).get('authorization'),
      redirect: init?.redirect,
    });
    return responses.shift() ?? new Response('bytes', { status: 200 });
  };
  vi.stubGlobal('fetch', vi.fn(record));
  vi.mocked(guardedRequest).mockImplementation(record);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gateway media host allowlists', () => {
  it("Whapi: only the configured gateway's /media/ endpoint", () => {
    expect(
      isWhapiMediaHost(new URL('https://gate.whapi.cloud/media/abc'))
    ).toBe(true);
    for (const url of [
      'https://gate.whapi.cloud/settings',
      'https://gate.whapi.cloud/health',
      'https://gate.whapi.cloud/media/../settings',
      'https://gate.whapi.cloud/media/%2e%2e/settings',
      'http://gate.whapi.cloud/media/abc',
      'https://cdn.whapi.cloud/media/abc',
      'https://gate.whapi.cloud.attacker.example/media/abc',
      'https://user:pw@gate.whapi.cloud/media/abc',
    ]) {
      expect(isWhapiMediaHost(new URL(url)), url).toBe(false);
    }
  });

  it('Meta: https lookaside only, never the Graph API', () => {
    expect(
      isMetaMediaHost(new URL('https://lookaside.fbsbx.com/whatsapp/abc'))
    ).toBe(true);
    for (const url of [
      'https://graph.facebook.com/v23.0/1234/phone_numbers',
      'http://lookaside.fbsbx.com/x',
      'https://fbsbx.com.attacker.example/x',
      'https://notfbsbx.com/x',
    ]) {
      expect(isMetaMediaHost(new URL(url)), url).toBe(false);
    }
  });
});

describe('downloadMedia never leaks the token', () => {
  it('Whapi: sends the Bearer to the gateway media endpoint only', async () => {
    const calls = stubFetch([]);
    await whapiDownload({
      downloadUrl: 'https://gate.whapi.cloud/media/1',
      token: 'tok',
    });
    expect(calls[0].auth).toBe('Bearer tok');
    expect(calls[0].redirect).toBe('manual');
  });

  it('Whapi: fetches a public non-gateway URL WITHOUT the Bearer', async () => {
    const calls = stubFetch([]);
    const { buffer } = await whapiDownload({
      downloadUrl: 'https://8.8.8.8/in-files/a.jpg',
      token: 'tok',
    });
    expect(buffer.toString()).toBe('bytes');
    expect(calls[0].auth).toBeNull();
  });

  it('Whapi: refuses an internal URL without fetching', async () => {
    const calls = stubFetch([]);
    await expect(
      whapiDownload({
        downloadUrl: 'http://169.254.169.254/latest/meta-data',
        token: 'tok',
      })
    ).rejects.toThrow(/refused/);
    expect(calls).toHaveLength(0);
  });

  it('Whapi: drops the Bearer when the gateway redirects off-host', async () => {
    const calls = stubFetch([
      new Response(null, {
        status: 302,
        headers: { location: 'https://1.1.1.1/f' },
      }),
    ]);
    await whapiDownload({
      downloadUrl: 'https://gate.whapi.cloud/media/1',
      token: 'tok',
    });
    expect(calls.map((c) => c.auth)).toEqual(['Bearer tok', null]);
  });

  it('Meta: sends the Bearer to lookaside, not to an attacker URL', async () => {
    const calls = stubFetch([]);
    await metaDownload({
      downloadUrl: 'https://lookaside.fbsbx.com/whatsapp/abc',
      accessToken: 'mtok',
    });
    await metaDownload({
      downloadUrl: 'https://8.8.8.8/a.jpg',
      accessToken: 'mtok',
    });
    expect(calls.map((c) => c.auth)).toEqual(['Bearer mtok', null]);
  });

  it('Meta: refuses a redirect into a private range', async () => {
    stubFetch([
      new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.5/' },
      }),
    ]);
    await expect(
      metaDownload({
        downloadUrl: 'https://8.8.8.8/a.jpg',
        accessToken: 'mtok',
      })
    ).rejects.toThrow(/refused/);
  });

  it("mirror's default downloader keeps Meta inbound media authenticated", async () => {
    // The inbound pipeline mirrors Meta attachments without naming the
    // gateway; the lookaside URL must still get the channel's token.
    const calls = stubFetch([]);
    await mirrorDefaultDownload({
      downloadUrl:
        'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      token: 'mtok',
    });
    await mirrorDefaultDownload({
      downloadUrl: 'https://gate.whapi.cloud/media/abc',
      token: 'wtok',
    });
    await mirrorDefaultDownload({
      downloadUrl: 'https://8.8.8.8/in-files/a.jpg',
      token: 'wtok',
    });
    expect(calls.map((c) => c.auth)).toEqual([
      'Bearer mtok',
      'Bearer wtok',
      null,
    ]);
  });
});
