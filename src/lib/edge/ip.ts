/**
 * Client-IP key for rate limits and lockout: IPv4-mapped IPv6 → the IPv4,
 * zone id dropped, other IPv6 bucketed to its /64 (a subscriber usually
 * holds a whole /64 and can rotate within it).
 */
import { isIPv4, isIPv6 } from 'node:net';

export function ipKey(ip: string | undefined): string {
  if (typeof ip !== 'string') return 'unknown';
  const raw = ip.trim().split('%')[0];
  if (isIPv4(raw) || !isIPv6(raw)) return raw;
  const g = groups(raw);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`;
}

/** The eight 16-bit groups of a valid IPv6 address. */
function groups(addr: string): number[] {
  let s = addr.toLowerCase();
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill =
    tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}
