import { afterEach, describe, it, expect } from 'vitest';
import {
  isPrivateOrReservedIp,
  isDeliverableUrl,
  fetchPublicUrl,
  UnsafeUrlError,
} from './ssrf';

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / CGNAT IPv4', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('flags loopback / ULA / link-local IPv6 and IPv4-mapped privates', () => {
    for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
    expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('isDeliverableUrl', () => {
  it('rejects literal private IPs and internal names without DNS', async () => {
    expect(await isDeliverableUrl('https://127.0.0.1/hook')).toBe(false);
    expect(await isDeliverableUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(await isDeliverableUrl('https://[::1]/hook')).toBe(false);
    expect(await isDeliverableUrl('https://localhost/hook')).toBe(false);
    expect(await isDeliverableUrl('https://foo.internal/hook')).toBe(false);
  });

  it('rejects a malformed URL', async () => {
    expect(await isDeliverableUrl('not a url')).toBe(false);
  });

  it('allows a literal public IP', async () => {
    expect(await isDeliverableUrl('https://8.8.8.8/hook')).toBe(true);
  });
});

describe('isPrivateOrReservedIp — bypass spellings and missing ranges', () => {
  it('un-maps IPv4-mapped / compatible IPv6 in hex and dotted forms', () => {
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // what WHATWG URL normalises the line above to
      '[::ffff:7f00:1]',
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '::ffff:0:7f00:1', // SIIT form
      '::127.0.0.1',
      '::7f00:1',
      '0:0:0:0:0:ffff:10.0.0.1',
      '::ffff:c0a8:101', // 192.168.1.1
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
    expect(isPrivateOrReservedIp('::ffff:808:808')).toBe(false); // 8.8.8.8
  });

  it('flags the IPv4 ranges the old regex missed', () => {
    for (const ip of [
      '198.18.0.1',
      '198.19.255.255',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
      '100.127.255.255',
      '0.1.2.3',
      '192.0.0.8',
      '192.0.2.1',
      '203.0.113.9',
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
    for (const ip of ['100.63.255.255', '100.128.0.0', '198.20.0.1', '223.255.255.255']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it('flags reserved IPv6 ranges', () => {
    for (const ip of [
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      'fe80::1%eth0',
      'febf::1',
      'fc00::1',
      'fdff:ffff::1',
      'ff02::1',
      'ff05::2',
      '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
      '64:ff9b::10.0.0.1',
      '64:ff9b:1::1',
      '2002:7f00:1::1', // 6to4 → 127.0.0.1
      '2001:db8::1',
      '2001::1', // Teredo
    ]) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
    for (const ip of ['2606:4700:4700::1111', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it('treats garbage as unsafe', () => {
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(true);
  });
});

describe('isDeliverableUrl — URL-level bypasses', () => {
  it('rejects IPv6 literals that normalise away from the dotted form', async () => {
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://[64:ff9b::127.0.0.1]/',
      'http://[fe80::1]/',
      'http://[ff02::1]/',
      'http://[::]/',
    ]) {
      expect(await isDeliverableUrl(url), url).toBe(false);
    }
  });

  it('rejects alternate IPv4 spellings WHATWG normalises', async () => {
    for (const url of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://0/']) {
      expect(await isDeliverableUrl(url), url).toBe(false);
    }
  });

  it('rejects non-http schemes and trailing-dot internal names', async () => {
    expect(await isDeliverableUrl('file:///etc/passwd')).toBe(false);
    expect(await isDeliverableUrl('ftp://8.8.8.8/x')).toBe(false);
    expect(await isDeliverableUrl('http://localhost./')).toBe(false);
  });
});

describe('fetchPublicUrl', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stub(responses: Response[]) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return responses.shift()!;
    }) as typeof fetch;
    return calls;
  }

  it('refuses a private URL without fetching', async () => {
    const calls = stub([]);
    await expect(fetchPublicUrl('http://127.0.0.1/x')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(calls).toHaveLength(0);
  });

  it('re-checks every redirect hop and refuses one into a private range', async () => {
    const calls = stub([
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    ]);
    await expect(fetchPublicUrl('https://8.8.8.8/a.jpg')).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('follows a public redirect and caps the hop count', async () => {
    const ok = stub([
      new Response(null, { status: 301, headers: { location: 'https://1.1.1.1/b' } }),
      new Response('bytes', { status: 200 }),
    ]);
    const res = await fetchPublicUrl('https://8.8.8.8/a');
    expect(res.status).toBe(200);
    expect(ok.map((c) => c.url)).toEqual(['https://8.8.8.8/a', 'https://1.1.1.1/b']);

    stub(
      Array.from({ length: 5 }, () =>
        new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/loop' } })
      )
    );
    await expect(fetchPublicUrl('https://8.8.8.8/a', {}, { maxRedirects: 2 })).rejects.toThrow(
      /Too many redirects/
    );
  });

  it('sends trusted headers only to trusted hops, never onward', async () => {
    const calls = stub([
      new Response(null, { status: 302, headers: { location: 'https://8.8.8.8/elsewhere' } }),
      new Response('ok', { status: 200 }),
    ]);
    await fetchPublicUrl(
      'https://media.gateway.test/f',
      { headers: { Authorization: 'Bearer leaked?' } },
      {
        isTrusted: (u) => u.hostname === 'media.gateway.test',
        trustedHeaders: { Authorization: 'Bearer secret' },
      }
    );
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer secret');
    expect(new Headers(calls[1].init.headers).get('authorization')).toBeNull();
  });
});
