// ============================================================
// Which push endpoints we will ever POST to. A subscription endpoint is
// a URL the *browser* hands us, so a staff member can post any https URL
// by hand; sending to it (dispatch.ts, POST /api/push/test) would then be
// a blind server-side request to wherever they point it, such as
// `https://10.0.0.5/...`. Real endpoints always live on a browser vendor's
// push service, so only those are accepted: https, no userinfo, the
// default port, and a host that is the service's domain or a subdomain of
// it (a real label boundary, so `xfcm.googleapis.com` and
// `fcm.googleapis.com.attacker.tld` fail).
// ============================================================

const PUSH_SERVICE_DOMAINS = [
  'fcm.googleapis.com', // Chrome, Edge, Opera, Samsung
  'push.services.mozilla.com', // Firefox (updates.push.services.mozilla.com)
  'notify.windows.com', // WNS (*.notify.windows.com)
  'push.apple.com', // Safari (web.push.apple.com)
];

export function isKnownPushEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_SERVICE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
