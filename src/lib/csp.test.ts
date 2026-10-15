import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, originOf } from './csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `));

describe('contentSecurityPolicy', () => {
  it('keeps every existing directive when nothing is configured', () => {
    expect(contentSecurityPolicy({})).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https://*.supabase.co",
        "font-src 'self' data:",
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );
  });

  it('adds the SDK, the PBX (https + wss) and the self-hosted Supabase origin', () => {
    const csp = contentSecurityPolicy({
      supabaseUrl: 'https://db.example.com/',
      linkusSdkUrl: 'https://cdn.example.com/sdk/ys-webrtc.umd.js',
      pbxOrigin: 'pbx.example.com:8088',
    });
    expect(directive(csp, 'script-src')).toBe(
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.example.com"
    );
    expect(directive(csp, 'connect-src')).toBe(
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com https://db.example.com wss://db.example.com https://pbx.example.com:8088 wss://pbx.example.com:8088"
    );
    expect(directive(csp, 'media-src')).toBe(
      "media-src 'self' blob: https://*.supabase.co https://db.example.com"
    );
  });

  it('ignores a same-origin SDK path, junk, and a non-https PBX', () => {
    const csp = contentSecurityPolicy({
      linkusSdkUrl: '/vendor/ys-webrtc.umd.js',
      pbxOrigin: 'http://pbx.example.com',
    });
    expect(csp).toBe(contentSecurityPolicy({}));
    expect(originOf('not a url; script-src *')).toBeNull();
    expect(originOf('http://localhost:54321', ['https:', 'http:'])).toBe(
      'http://localhost:54321'
    );
  });

  it('pairs a plain-http Supabase origin with ws: for Realtime', () => {
    const csp = contentSecurityPolicy({
      supabaseUrl: 'http://localhost:54321',
    });
    expect(directive(csp, 'connect-src')).toBe(
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com http://localhost:54321 ws://localhost:54321"
    );
  });
});
