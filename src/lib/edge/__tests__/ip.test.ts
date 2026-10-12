import { describe, it, expect } from 'vitest';
import { ipKey } from '../ip';

describe('ipKey', () => {
  it('two addresses in one IPv6 /64 share a bucket; another /64 does not', () => {
    expect(ipKey('2001:db8:1:2::1')).toBe(
      ipKey('2001:0db8:0001:0002:ffff:eeee:dddd:cccc')
    );
    expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
  });

  it('IPv4-mapped IPv6 equals the plain IPv4', () => {
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('drops a zone id', () => {
    expect(ipKey('fe80::1%eth0')).toBe(ipKey('fe80::2'));
  });

  it("a missing ip yields 'unknown' instead of throwing", () => {
    expect(ipKey(undefined)).toBe('unknown');
    expect(ipKey(undefined as unknown as string)).toBe('unknown');
  });
});
