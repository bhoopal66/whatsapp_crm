import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { contentSecurityPolicy } from './src/lib/csp';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * Baseline security headers applied to every response (X-Frame-Options
 * and the CSP: every response but /f/*, see FRAME_HEADERS below).
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
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // A page another site opened cannot reach back into the CRM's window
  // (window.opener), and a page the CRM opens cannot either unless it is
  // ours. `allow-popups` keeps the meeting and softphone windows the app
  // opens itself working.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
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
] as const;

/**
 * The two headers that forbid framing, kept apart from the rest so the
 * hosted web form (/f/<token>) can be left out of them: another site may
 * frame that one page, if it is on the form's own allowed-origins list.
 * The middleware sends /f/'s frame headers per request instead
 * (src/lib/web-form/frame-headers.ts): a non-empty list gets an
 * enforced `frame-ancestors <origins>` and no X-Frame-Options (XFO has
 * no allow-list, and a DENY here would block framing whatever the CSP
 * says); anything else gets `frame-ancestors 'none'` + DENY, as here.
 * Every other route gets exactly these two values.
 */
const FRAME_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
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
  // No "X-Powered-By: Next.js": the framework and its version are one
  // less thing to look up for an attacker scanning the site.
  poweredByHeader: false,
  /**
   * Client-side route cache.
   *
   * The role-gated screens (/team-inbox, /team-contacts, /calls, the
   * admin, agent and staff screens; the list is `guarded` in
   * src/components/layout/nav-items.ts) read cookies in their layout
   * guard, which makes them dynamic routes. Next gives dynamic segments
   * a client cache TTL of 0 by default, so every visit — including
   * flipping back to a tab opened seconds ago — refetched the RSC
   * payload. On this deployment that payload comes back through
   * Cloudflare and the tunnel, ~0.7s against ~0.02s from the origin
   * itself, and it is the delay the user sees before the screen even
   * starts rendering.
   *
   * Caching it makes a return visit instant. `dynamic` covers a route
   * visited or prefetched only down to its loading boundary; the
   * sidebar prefetches its guarded rows fully (`prefetch={true}`,
   * `navPrefetch`), and a full prefetch is held for `static`, so even
   * the first click on one needs no round trip. Nothing user-visible
   * goes stale: these pages are client components that fetch their own
   * data on mount, so the cached part is the empty shell, not the
   * contents. The role guard's answer is cached with it, so a demotion
   * takes up to `static` seconds (5 minutes) to close a screen whose
   * row was prefetched — accepted, because the data inside it is
   * RLS-gated regardless, which is what actually keeps a demoted user
   * out. The sidebar only renders, and so only prefetches, the rows
   * the current role may open.
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
        // A group's picture sets its own (no-store or a short private
        // life): a header set here replaces the route's.
        source: '/api/:path((?!whatsapp/groups/[^/]+/icon$).*)',
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
      {
        // X-Frame-Options + the Report-Only CSP on every response except
        // /f/* (the hosted web form) and the route it posts to, whose
        // frame headers the middleware sets per request (the post's 303
        // is shown inside the iframe): two frame-ancestors / XFO headers
        // on one response would combine to the stricter one.
        source: '/:path((?!f/|api/public/web-form/).*)',
        headers: [...FRAME_HEADERS],
      },
      {
        // The push service worker (public/sw.js): browsers re-check it on
        // every registration, and a cached copy would keep an old push
        // handler alive after a deploy. Last so it wins over the generic
        // page rule above.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
      {
        // Meeting effects: ~15 MB of runtime and model behind a slow
        // tunnel, which the page rule above would refetch on every use.
        // A day, not immutable: the names carry no hash. Last so it wins.
        // Outside the middleware's matcher, so a rotated auth cookie can
        // never ride on a publicly cacheable response.
        source: '/meeting-effects/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
