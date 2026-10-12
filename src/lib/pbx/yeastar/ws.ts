import { YEASTAR_EVENT } from './events';
import { DEFAULT_API_PATH, joinUrl } from './http';

/**
 * Framing for the Yeastar event WebSocket
 * (`wss://{pbx}/openapi/v1.0/subscribe?access_token=...`). Pure: the
 * socket itself belongs to whoever runs the connection loop.
 *
 * The PBX drops a connection after 60 s with no traffic; the plain-text
 * frame `heartbeat` keeps it open and is answered by the plain text
 * `heartbeat response`, not JSON. No replay or resume is documented, so
 * events during a gap are lost and must be backfilled from `cdr/search`.
 * Whether a second `topic_list` replaces or extends the first is
 * undocumented: always send the full list after each (re)connect.
 */

export const DEFAULT_TOPICS: readonly number[] = [
  YEASTAR_EVENT.REGISTRATION,
  YEASTAR_EVENT.EXTENSION_CALL_STATE,
  YEASTAR_EVENT.PRESENCE,
  YEASTAR_EVENT.CALL_STATE,
  YEASTAR_EVENT.CALL_END,
];

export const HEARTBEAT = 'heartbeat';
/** Half the PBX's 60 s idle timeout. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** The text frame that subscribes, e.g. `{"topic_list":[30011,30012]}`. */
export function subscribeMessage(topics: readonly number[]): string {
  return JSON.stringify({ topic_list: [...topics] });
}

export function isHeartbeatReply(text: string): boolean {
  return typeof text === 'string' && text.trim() === 'heartbeat response';
}

/**
 * The reply to a subscribe frame (`{"errcode":0,"errmsg":"SUCCESS"}`),
 * or null for any other frame. An event carries `type`, never `errcode`.
 */
export function parseSubscribeReply(
  text: string
): { ok: boolean; errcode: number; errmsg: string } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const { errcode, errmsg, type } = v as Record<string, unknown>;
  if (type !== undefined || typeof errcode !== 'number') return null;
  return {
    ok: errcode === 0,
    errcode,
    errmsg: typeof errmsg === 'string' ? errmsg : '',
  };
}

/**
 * Capped exponential backoff with equal jitter: half the step is fixed,
 * so a reconnect loop never hammers the PBX (5 failed logins block the
 * IP), and half is random so several workers spread out.
 */
export function nextBackoffMs(
  attempt: number,
  {
    baseMs = 1_000,
    maxMs = 60_000,
    random = Math.random,
  }: { baseMs?: number; maxMs?: number; random?: () => number } = {}
): number {
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const step = Math.min(maxMs, baseMs * 2 ** n);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(step / 2 + (step / 2) * r);
}

/**
 * `https://pbx…` → `wss://pbx…/openapi/v1.0/subscribe?access_token=…`.
 * The URL carries a live token: never log it (see `redactToken`).
 */
export function wsUrl(baseUrl: string, accessToken: string): string {
  const url = new URL(joinUrl(baseUrl, `${DEFAULT_API_PATH}/subscribe`));
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new TypeError(`baseUrl must be http(s), got ${url.protocol}`);
  url.searchParams.set('access_token', accessToken);
  return url.toString();
}
