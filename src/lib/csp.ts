// ============================================================
// The Content-Security-Policy value, built from build-time env so a
// self-hosted install's own origins are allowed (next.config.ts sends
// it as Content-Security-Policy-Report-Only; see the note there).
// Pure, so csp.test.ts can pin every directive.
//
// Optional origins, each added only when its env var parses:
//   - NEXT_PUBLIC_SUPABASE_URL → media-src: recordings and media are
//     played from signed URLs on the Supabase origin, which on a
//     self-hosted install is not *.supabase.co.
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

export function contentSecurityPolicy(env: CspEnv): string {
  const supabase = originOf(env.supabaseUrl, ['https:', 'http:']);
  const sdk = originOf(env.linkusSdkUrl);
  const pbx = originOf(env.pbxOrigin);
  return [
    "default-src 'self'",
    // Next.js needs 'unsafe-inline' for its inline hydration script
    // and 'unsafe-eval' in dev + some production optimisations.
    // Nonce-based CSP is a later project.
    join("script-src 'self' 'unsafe-inline' 'unsafe-eval'", sdk),
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
    // Supabase REST + realtime (WSS). All Meta API calls happen
    // server-side, so graph.facebook.com does not belong here. The
    // PBX for the browser softphone.
    join(
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      pbx,
      pbx && pbx.replace(/^https:/, 'wss:')
    ),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}
