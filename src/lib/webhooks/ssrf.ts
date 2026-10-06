// ============================================================
// SSRF guard for server-side fetches of caller-influenced URLs.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one), as is an automation's
// `send_webhook` target, a template header media URL, and a message's
// `media_url`. Our server makes the request, so an unguarded fetch is a
// Server-Side Request Forgery primitive: a URL pointing at `127.0.0.1`,
// a cloud metadata IP (`169.254.169.254`), or an RFC1918 host would let
// a caller probe / POST to internal services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, multicast, or otherwise non-
// publicly-routable. Combined with `redirect: 'manual'` at the call
// site (so a public URL can't 3xx-bounce to an internal one — or use
// `fetchPublicUrl`, which follows redirects itself and re-checks every
// hop), this blocks the common SSRF vectors.
//
// IPv6 is the classic bypass: WHATWG URL parsing normalises
// `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so a regex over the dotted
// form misses it. Classification therefore parses every address into
// its 16 bytes and un-maps each IPv4-in-IPv6 encoding (mapped,
// compatible, NAT64, 6to4) before checking the IPv4 ranges.
//
// Residual risk — DNS rebinding: a host that resolves public here but
// flips to private before connect. Closing that needs the validated IP
// pinned into the socket (an undici `Agent` with a `connect.lookup`),
// and undici is not a declared dependency — only a transitive one of
// the shadcn CLI — so it is not imported here. The window is the gap
// between our lookup and fetch's own, usually milliseconds, and the
// attacker needs a TTL-0 record they control.
// ============================================================

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + limited broadcast
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo (embeds an obfuscated IPv4)
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockList.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of BLOCKED_V6) blockList.addSubnet(net, prefix, 'ipv6');

/** Expand a valid IPv6 literal into its 8 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip;
  // An embedded dotted quad (`::ffff:1.2.3.4`) becomes two groups.
  const dotted = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s =
      s.slice(0, dotted.index) +
      ((a << 8) | b).toString(16) +
      ':' +
      ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) =>
    parseInt(g, 16)
  );
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) {
    return null;
  }
  return groups;
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
}

/**
 * True for loopback / private / link-local / reserved / multicast IPv4
 * or IPv6, including every IPv4-in-IPv6 spelling of such an address.
 * Anything unparseable is treated as unsafe.
 */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  // Brackets from a URL host, and a zone id (`fe80::1%eth0`).
  const ip = rawIp.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const family = isIP(ip);
  if (family === 4) return blockList.check(ip, 'ipv4');
  if (family !== 6) return true;

  const g = ipv6Groups(ip);
  if (!g) return true;

  // ::ffff:a.b.c.d — IPv4-mapped. Also the SIIT form ::ffff:0:a.b.c.d.
  if (
    g[0] === 0 &&
    g[1] === 0 &&
    g[2] === 0 &&
    g[3] === 0 &&
    ((g[4] === 0 && g[5] === 0xffff) || (g[4] === 0xffff && g[5] === 0))
  ) {
    return blockList.check(v4FromGroups(g[6], g[7]), 'ipv4');
  }
  // 64:ff9b::a.b.c.d — well-known NAT64 prefix. A DNS64 resolver maps
  // public hosts into it, so only the embedded address decides.
  if (
    g[0] === 0x64 &&
    g[1] === 0xff9b &&
    g[2] === 0 &&
    g[3] === 0 &&
    g[4] === 0 &&
    g[5] === 0
  ) {
    return blockList.check(v4FromGroups(g[6], g[7]), 'ipv4');
  }
  // 2002:AABB:CCDD::/48 — 6to4, embeds a.b.c.d in groups 1-2.
  if (g[0] === 0x2002) {
    return blockList.check(v4FromGroups(g[1], g[2]), 'ipv4');
  }

  const canonical = g.map((x) => x.toString(16)).join(':');
  return blockList.check(canonical, 'ipv6');
}

/**
 * True if `rawUrl` is http(s) and its host resolves only to publicly-
 * routable address(es). Returns false for a malformed URL, a non-http
 * scheme, an obvious internal name (`localhost`, `*.local`,
 * `*.internal`), a literal private IP, or a hostname that resolves to
 * any private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    host = url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase().replace(/\.+$/, '');
  if (
    !lower ||
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true, verbatim: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}

/** Thrown by `fetchPublicUrl` when a hop fails the SSRF guard. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchPublicUrlOptions {
  /** Redirect hops to follow (each re-checked). Default 3. */
  maxRedirects?: number;
  /**
   * Hosts that skip the SSRF check and may receive `trustedHeaders`
   * (e.g. a gateway's own media host, which can be an on-prem address).
   * Re-evaluated on every hop, so a trusted host that redirects
   * elsewhere does not carry its credentials along.
   */
  isTrusted?: (url: URL) => boolean;
  /** Extra headers sent only to a trusted hop — typically a bearer. */
  trustedHeaders?: Record<string, string>;
}

/**
 * GET-style fetch of a caller-influenced URL. Every hop — the original
 * URL and each redirect target — must be http(s) and either trusted or
 * publicly routable; redirects are followed by hand with
 * `redirect: 'manual'` so fetch never connects to an unchecked host.
 * Throws `UnsafeUrlError` on a refused hop or too many redirects.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  init: RequestInit = {},
  opts: FetchPublicUrlOptions = {}
): Promise<Response> {
  const { maxRedirects = 3, isTrusted, trustedHeaders } = opts;
  let current = rawUrl;

  for (let hop = 0; ; hop++) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new UnsafeUrlError('Malformed URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new UnsafeUrlError(`Refusing ${url.protocol} URL`);
    }

    const trusted = isTrusted?.(url) ?? false;
    if (!trusted && !(await isDeliverableUrl(url.href))) {
      throw new UnsafeUrlError('Refusing non-public URL');
    }

    const headers = new Headers(init.headers);
    if (trusted && trustedHeaders) {
      for (const [k, v] of Object.entries(trustedHeaders)) headers.set(k, v);
    } else {
      // Never forward credentials to an untrusted hop, even if the
      // caller put them in `init`.
      headers.delete('authorization');
    }

    const res = await fetch(url.href, {
      ...init,
      headers,
      redirect: 'manual',
    });

    const location = res.headers?.get?.('location');
    if (!REDIRECT_STATUSES.has(res.status) || !location) return res;
    if (hop >= maxRedirects) throw new UnsafeUrlError('Too many redirects');
    current = new URL(location, url).href;
  }
}
