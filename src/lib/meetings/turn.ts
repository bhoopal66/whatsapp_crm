// ============================================================
// ICE servers for a meeting seat — Cloudflare TURN (free with the SFU).
//
// With CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_API_TOKEN set,
// every join mints short-lived TURN credentials, so a participant
// behind a strict NAT or firewall still connects (relayed over 443).
// Without them, or on any failure, the seat gets STUN only, which is
// v1's behaviour: TURN is an improvement, never a reason to refuse a
// join. Credentials are only ever sent to the client; nothing here logs
// a token, a username or a credential, only Cloudflare's status.
// ============================================================

import { MEETING_ICE_SERVERS, type IceServer } from './types';

const TURN_BASE_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys';
/** Credentials outlive any realistic meeting (6 h). */
export const TURN_TTL_SECONDS = 21_600;
export const TURN_TIMEOUT_MS = 5_000;

function turnKey(): { id: string; token: string } | null {
  const id = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const token = process.env.CLOUDFLARE_TURN_KEY_API_TOKEN?.trim();
  return id && token ? { id, token } : null;
}

/** The explicit port of a stun:/turn:/turns: URL (RFC 7064/7065), else null. */
export function iceUrlPort(url: string): string | null {
  const m =
    /^(?:stuns?|turns?):(?:\[[^\]]*\]|[^:?]*)(?::(\d+))?(?:\?.*)?$/i.exec(url);
  return m?.[1] ?? null;
}

/**
 * Cloudflare's answer as the browser should get it: well-formed entries
 * only, and no URL on port 53, which browsers block (Chrome refuses the
 * whole RTCPeerConnection config, Firefox times out on it). An entry
 * left with no URL is dropped.
 */
export function usableIceServers(raw: unknown): IceServer[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: IceServer[] = [];
  for (const s of list) {
    if (typeof s !== 'object' || s === null) continue;
    const { urls, username, credential } = s as Record<string, unknown>;
    const all = typeof urls === 'string' ? [urls] : urls;
    if (!Array.isArray(all)) continue;
    const kept = all.filter(
      (u): u is string => typeof u === 'string' && iceUrlPort(u) !== '53'
    );
    if (kept.length === 0) continue;
    const server: IceServer = { urls: kept };
    if (typeof username === 'string') server.username = username;
    if (typeof credential === 'string') server.credential = credential;
    out.push(server);
  }
  return out;
}

/** TURN + STUN when configured and Cloudflare answers, else STUN only. */
export async function meetingIceServers(): Promise<IceServer[]> {
  const key = turnKey();
  if (!key) return MEETING_ICE_SERVERS;
  try {
    const res = await fetch(
      `${TURN_BASE_URL}/${encodeURIComponent(key.id)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        cache: 'no-store',
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      console.error('[meetings] TURN credentials refused', res.status);
      return MEETING_ICE_SERVERS;
    }
    const json = (await res.json().catch(() => null)) as {
      iceServers?: unknown;
    } | null;
    const servers = usableIceServers(json?.iceServers);
    if (servers.length === 0) {
      console.error('[meetings] TURN answer had no usable servers', res.status);
      return MEETING_ICE_SERVERS;
    }
    return servers;
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    console.error('[meetings] TURN credentials unavailable', name ?? 'error');
    return MEETING_ICE_SERVERS;
  }
}
