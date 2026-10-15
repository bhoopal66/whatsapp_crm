import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { contentSecurityPolicy } from './src/lib/csp';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     baseline OWASP hardening, no behavioural cost.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 */
const SECURITY_HEADERS = [
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder (and the
    // browser softphone can open the microphone). Camera, microphone
    // and display-capture are `self` for video meetings (migration 106:
    // camera tiles, screen sharing). Same-origin only, so no embedded
    // frame gets them; everything else stays denied — a compromised
    // dependency can't silently grab geolocation / payment / etc.
    key: 'Permissions-Policy',
    value:
      'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()',
  },
  {
    // Directives and the env-derived origins (Supabase media, the
    // Linkus SDK bundle, the PBX for the browser softphone) are built in
    // src/lib/csp.ts, which csp.test.ts pins.
    key: 'Content-Security-Policy-Report-Only',
    value: contentSecurityPolicy({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      linkusSdkUrl: process.env.NEXT_PUBLIC_LINKUS_SDK_URL,
      pbxOrigin: process.env.NEXT_PUBLIC_PBX_ORIGIN,
    }),
  },
] as const;

const nextConfig: NextConfig = {
  /**
   * Client-side route cache.
   *
   * The role-gated screens (/team-inbox, /team-contacts, /agents,
   * /flows, /automations, /broadcasts, /pipelines) read cookies in
   * their layout guard, which makes them dynamic routes. Next gives
   * dynamic segments a client cache TTL of 0 by default, so every
   * visit — including flipping back to a tab opened seconds ago —
   * refetched the RSC payload. On this deployment that payload comes
   * back through Cloudflare and the tunnel, ~0.7s against ~0.02s from
   * the origin itself, and it is the delay the user sees before the
   * screen even starts rendering.
   *
   * Caching it for a couple of minutes makes a return visit instant.
   * Nothing user-visible goes stale: these pages are client
   * components that fetch their own data on mount, so the cached part
   * is the empty shell, not the contents. The role guard does get
   * cached with it, so a demotion takes up to `dynamic` seconds to
   * close the screen — the data inside it is RLS-gated regardless,
   * which is what actually keeps a demoted user out.
   */
  experimental: {
    staleTimes: {
      dynamic: 120,
      static: 300,
    },
  },

  // Emit a self-contained server bundle (.next/standalone) so the
  // Docker image can run without node_modules or the Next CLI.
  // Harmless outside Docker: `next start` keeps working as before.
  output: 'standalone',

  /**
   * Cross-origin dev access (Next.js 16).
   *
   * Next 16 blocks requests to dev-only resources (`/_next/*` internals,
   * the HMR websocket, the dev overlay) unless the browser's Origin is
   * the host the dev server booted on — `localhost` by default. Tunnels
   * like ngrok serve the app from a public HTTPS host, so without
   * allow-listing that host those dev requests come back 403: HMR stops
   * working and the dev session degrades over the tunnel (issue #365).
   *
   * Wildcards match subdomains only (Next's CSRF matcher), so the
   * randomised tunnel subdomain is covered. Add any other host via
   * `ALLOWED_DEV_ORIGINS` (comma-separated). This key is dev-only and
   * has no effect on a production build.
   */
  allowedDevOrigins: [
    '*.ngrok-free.app',
    '*.ngrok.app',
    '*.ngrok.io',
    '*.trycloudflare.com',
    '*.loca.lt',
    ...(process.env.ALLOWED_DEV_ORIGINS
      ? process.env.ALLOWED_DEV_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : []),
  ],

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — `private, no-cache`. Never stored by a
   *     shared cache, always revalidated by the browser, so a deploy's
   *     chunk-hash drift can't outlive one request.
   *
   *   This rule used to be `public, s-maxage=300, stale-while-
   *   revalidate=86400`, on the belief that Next would still mark
   *   per-user responses `private`. It doesn't: a header set here
   *   REPLACES Next's own Cache-Control, so authenticated dashboard
   *   HTML, RSC payloads and the middleware's auth redirects
   *   (/inbox → /login) all went out as publicly cacheable, with a
   *   Vary that doesn't include Cookie. One "Cache Everything" rule at
   *   the CDN would then have served one user's page — or a logged-out
   *   visitor's redirect — to everyone else. Every page in this app is
   *   either behind auth or tiny (/login), so nothing is lost by
   *   keeping HTML out of shared caches entirely.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [{ key: 'Cache-Control', value: 'no-store' }],
      },
      {
        source: '/:path((?!_next/static|_next/image|api).*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'private, no-cache, max-age=0',
          },
        ],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt).
        source: '/:path*',
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
