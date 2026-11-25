/**
 * Where a workspace's PBX may live. The admin of any workspace types the
 * PBX base URL, and the server then calls it (connection test, sync,
 * credentials): without a check, an admin could point it at the cloud
 * metadata address, the internal Supabase host or any port behind the
 * app, and read the answers from the test's error text.
 *
 * A public address is allowed. A private, loopback or internal one (an
 * on-premises Yeastar on the office LAN) only when the operator listed
 * its host in PBX_ALLOWED_HOSTS (comma-separated `host` or `host:port`),
 * because that is a decision for whoever runs the server, not for a
 * workspace admin. Uses the webhook SSRF guard's address rules.
 */
import { isDeliverableUrl, type Resolver } from '@/lib/webhooks/ssrf';

export function pbxAllowedHosts(
  raw: string | undefined = process.env.PBX_ALLOWED_HOSTS
): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function isAllowedPbxBaseUrl(
  baseUrl: string,
  opts: { allowedHosts?: Set<string>; resolve?: Resolver } = {}
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const allowed = opts.allowedHosts ?? pbxAllowedHosts();
  if (
    allowed.has(url.host.toLowerCase()) ||
    allowed.has(url.hostname.toLowerCase())
  )
    return true;
  return isDeliverableUrl(url.origin, { resolve: opts.resolve });
}

export const PBX_HOST_REFUSED =
  'This PBX address is private or internal. If it is your own PBX on the local network, ask whoever runs the server to add its host to PBX_ALLOWED_HOSTS.';
