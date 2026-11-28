// ============================================================
// The Content-Security-Policy value, built from build-time env so a
// self-hosted install's own origins are allowed. Pure, so csp.test.ts
// can pin every directive.
//
// Enforced since 2026-11-28: the middleware builds it per request with a
// fresh nonce (`cspForRequest`), sends it as `Content-Security-Policy`,
// and puts it on the request too, where Next.js reads the nonce and
// stamps it on its own scripts. A script runs only if it carries that
// nonce or was added by one that does ('strict-dynamic': the chunk
// loader, the Linkus SDK, MediaPipe's loader), so an injected
// <script> or inline handler does not run. CSP_MODE=report-only (server
// env, read at runtime) goes back to reporting only, without a rebuild,
// should a deploy find something legitimate that it blocks.
//
// Optional origins, each added only when its env var parses:
//   - NEXT_PUBLIC_SUPABASE_URL → media-src, frame-src (the desk's PDF
//     preview, 248), and connect-src with its
//     WebSocket twin: recordings and media are played from signed URLs
//     on the Supabase origin, and the browser's REST and Realtime calls
//     go there too, which on a self-hosted install is not *.supabase.co.
//   - NEXT_PUBLIC_LINKUS_SDK_URL → script-src: the operator-hosted
//     Linkus SDK bundle (browser softphone, module 015).
//   - NEXT_PUBLIC_PBX_ORIGIN → connect-src https: and wss:: the SDK
//     talks to the PBX (REST and SIP over WebSocket). The browser
//     cannot learn the PBX's address at build time, hence its own var.
// ============================================================

export interface CspEnv {
  supabaseUrl?: string;
  linkusSdkUrl?: string;
  pbxOrigin?: string;
}

export interface CspOptions {
  /**
   * This response's nonce. Without one the policy is the old,
   * nonce-less one ('unsafe-inline'), kept only for callers that have no
   * request to hang a nonce on.
   */
  nonce?: string;
  /** `next dev`: React's dev build needs eval for its error stacks. */
  dev?: boolean;
}

export type CspMode = 'enforce' | 'report-only';

/** CSP_MODE: anything but `report-only` enforces. */
export function cspModeFromEnv(raw: string | undefined): CspMode {
  return raw?.trim().toLowerCase() === 'report-only'
    ? 'report-only'
    : 'enforce';
}

export function cspHeaderName(mode: CspMode): string {
  return mode === 'report-only'
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
}

/** 128 random bits, base64: what Next.js's nonce parser accepts. */
export function newCspNonce(
  random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)
): string {
  const bytes = random(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const NONCE_SHAPE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** `scheme://host[:port]` of an absolute URL with an allowed scheme. */
export function originOf(
  raw: string | undefined,
  schemes: string[] = ['https:']
): string | null {
  const v = raw?.trim();
  // Empty, or a path on this origin ('self' already covers it).
  if (!v || v.startsWith('/')) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return schemes.includes(u.protocol) && u.host
      ? `${u.protocol}//${u.host}`
      : null;
  } catch {
    return null;
  }
}

const join = (...parts: (string | null)[]) =>
  [...new Set(parts.filter((p): p is string => Boolean(p)))].join(' ');

export function contentSecurityPolicy(
  env: CspEnv,
  opts: CspOptions = {}
): string {
  // A nonce that would break out of its quotes is never used: the
  // policy then falls back to the nonce-less form rather than a broken one.
  const nonce =
    opts.nonce && NONCE_SHAPE.test(opts.nonce) ? opts.nonce : undefined;
  const supabase = originOf(env.supabaseUrl, ['https:', 'http:']);
  // https → wss, http → ws: Realtime rides the same host.
  const supabaseWs = supabase && supabase.replace(/^http/, 'ws');
  const sdk = originOf(env.linkusSdkUrl);
  const pbx = originOf(env.pbxOrigin);
  return [
    "default-src 'self'",
    // With a nonce: Next.js stamps it on its own scripts (the framework,
    // the page chunks, the inline hydration data, the theme boot script
    // in app/layout.tsx), and 'strict-dynamic' lets those load further
    // scripts (lazy chunks, the Linkus SDK, MediaPipe's wasm loader).
    // Host sources are ignored under 'strict-dynamic', so the SDK origin
    // only matters to the nonce-less form. No 'unsafe-eval' in
    // production: the built chunks use Function("return this") only as a
    // fallback a browser never reaches (`self` exists).
    // 'wasm-unsafe-eval': the meeting effects compile WebAssembly.
    nonce
      ? join(
          `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
          opts.dev ? "'unsafe-eval'" : null
        )
      : join(
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
          sdk
        ),
    // The push worker, and the effects' frame clock: a Blob URL worker,
    // because a hidden tab throttles every page timer.
    "worker-src 'self' blob:",
    // Tailwind + inline style attributes on lots of components.
    "style-src 'self' 'unsafe-inline'",
    // Supabase public-bucket avatars, contact avatars (arbitrary
    // https URLs paste-able from the UI), OG images, data URLs for
    // tiny inline assets.
    "img-src 'self' data: blob: https:",
    // Outbound media previews (blob: from MediaRecorder + file picker)
    // and Supabase audio/video the inbox and call screens render.
    join("media-src 'self' blob: https://*.supabase.co", supabase),
    "font-src 'self' data:",
    // The case desk's file preview (248) shows a PDF from a short-lived
    // signed URL on the Supabase origin in an <iframe>; without this
    // frame-src falls back to default-src 'self' and the frame is empty.
    join("frame-src 'self' https://*.supabase.co", supabase),
    // Supabase REST + realtime (WSS), hosted or self-hosted. All Meta
    // API calls happen server-side, so graph.facebook.com does not
    // belong here. Cloudflare Realtime for video meetings (106). The
    // PBX for the browser softphone.
    join(
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://rtc.live.cloudflare.com",
      supabase,
      supabaseWs,
      pbx,
      pbx && pbx.replace(/^https:/, 'wss:')
    ),
    // No <object>/<embed> plugins anywhere in the app.
    nonce ? "object-src 'none'" : null,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // What the policy blocks (or would, under CSP_MODE=report-only), logged by rule and origin, so it can be
    // enforced on evidence (src/app/api/csp-report).
    'report-uri /api/csp-report',
  ]
    .filter((d): d is string => Boolean(d))
    .join('; ');
}

export interface RequestCsp {
  /** The header to send: enforced, or Report-Only under CSP_MODE. */
  header: string;
  value: string;
  nonce: string;
}

/** The policy for one request: a fresh nonce, the header CSP_MODE picks. */
export function cspForRequest(
  env: CspEnv,
  opts: { mode: CspMode; dev?: boolean; nonce?: string }
): RequestCsp {
  const nonce = opts.nonce ?? newCspNonce();
  return {
    header: cspHeaderName(opts.mode),
    value: contentSecurityPolicy(env, { nonce, dev: opts.dev }),
    nonce,
  };
}
