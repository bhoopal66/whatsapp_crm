import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  cspForRequest,
  cspHeaderName,
  cspModeFromEnv,
  newCspNonce,
  originOf,
} from './csp';

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `));

const NONCE = 'q83vEh1Ufj2rT0b9xXo3Yw==';

describe('contentSecurityPolicy with a nonce (enforced)', () => {
  it('allows scripts only by nonce, no inline or eval, no plugins', () => {
    expect(contentSecurityPolicy({}, { nonce: NONCE })).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'wasm-unsafe-eval'`,
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https://*.supabase.co",
        "font-src 'self' data:",
        "frame-src 'self' https://*.supabase.co",
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        'report-uri /api/csp-report',
      ].join('; ')
    );
  });

  it("adds 'unsafe-eval' only in dev, and keeps the env origins", () => {
    const dev = contentSecurityPolicy(
      { supabaseUrl: 'https://db.example.com' },
      { nonce: NONCE, dev: true }
    );
    expect(directive(dev, 'script-src')).toBe(
      `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'wasm-unsafe-eval' 'unsafe-eval'`
    );
    expect(directive(dev, 'connect-src')).toContain('wss://db.example.com');
    const prod = contentSecurityPolicy({}, { nonce: NONCE });
    expect(prod).not.toContain("'unsafe-eval'");
    expect(directive(prod, 'script-src')).not.toContain("'unsafe-inline'");
  });

  it('never puts a malformed nonce in the policy', () => {
    for (const bad of ["x' 'unsafe-inline", 'abc', 'a;b'.repeat(8), '']) {
      expect(contentSecurityPolicy({}, { nonce: bad })).toBe(
        contentSecurityPolicy({})
      );
    }
  });
});

describe('request nonces and modes', () => {
  it('makes a fresh 128-bit base64 nonce every time', () => {
    const a = newCspNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newCspNonce()).not.toBe(a);
    expect(newCspNonce((b) => b.fill(0))).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
  });

  it('enforces unless CSP_MODE says report-only', () => {
    expect(cspModeFromEnv(undefined)).toBe('enforce');
    expect(cspModeFromEnv('')).toBe('enforce');
    expect(cspModeFromEnv('off')).toBe('enforce');
    expect(cspModeFromEnv(' Report-Only ')).toBe('report-only');
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe(
      'Content-Security-Policy-Report-Only'
    );
  });

  it('builds the header for one request around its nonce', () => {
    const r = cspForRequest({}, { mode: 'enforce', nonce: NONCE });
    expect(r).toEqual({
      header: 'Content-Security-Policy',
      value: contentSecurityPolicy({}, { nonce: NONCE }),
      nonce: NONCE,
    });
    const fresh = cspForRequest({}, { mode: 'report-only' });
    expect(fresh.header).toBe('Content-Security-Policy-Report-Only');
    expect(fresh.value).toContain(`'nonce-${fresh.nonce}'`);
  });
});

describe('contentSecurityPolicy without a nonce', () => {
  it('keeps every existing directive when nothing is configured', () => {
    expect(contentSecurityPolicy({})).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https://*.supabase.co",
        "font-src 'self' data:",
        "frame-src 'self' https://*.supabase.co",
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        'report-uri /api/csp-report',
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
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.example.com"
    );
    expect(directive(csp, 'connect-src')).toBe(
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com https://db.example.com wss://db.example.com https://pbx.example.com:8088 wss://pbx.example.com:8088"
    );
    expect(directive(csp, 'media-src')).toBe(
      "media-src 'self' blob: https://*.supabase.co https://db.example.com"
    );
    expect(directive(csp, 'frame-src')).toBe(
      "frame-src 'self' https://*.supabase.co https://db.example.com"
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
