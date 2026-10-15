// ============================================================
// Cloudflare Realtime SFU ("Calls") client — server only.
//
// Reads CLOUDFLARE_CALLS_APP_ID / CLOUDFLARE_CALLS_APP_SECRET at call
// time, never at module load, so an install without them still serves
// meeting CRUD (the join/SFU routes answer 503 instead). The secret is
// only ever sent as the bearer token: nothing here logs a request, a
// header or a URL.
// ============================================================

import type {
  CloseTracksRequest,
  CloseTracksResponse,
  GetSessionStateResponse,
  NewSessionResponse,
  RenegotiateResponse,
  SessionDescription,
  TracksRequest,
  TracksResponse,
} from './types';

const SFU_BASE_URL = 'https://rtc.live.cloudflare.com/v1/apps';
/** Per-request ceiling: a stuck negotiation must not hold the route open. */
export const SFU_TIMEOUT_MS = 15_000;

export class SfuError extends Error {
  /** HTTP status Cloudflare answered, 504 on a timeout, 502 unreachable,
   *  503 unconfigured. */
  readonly status: number;
  /** Cloudflare's `errorCode`, or `timeout` / `network` / `not_configured` /
   *  `bad_response` / `http_<status>`. */
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'SfuError';
    this.status = status;
    this.code = code;
  }

  get isTimeout(): boolean {
    return this.code === 'timeout';
  }
}

function credentials(): { appId: string; secret: string } | null {
  const appId = process.env.CLOUDFLARE_CALLS_APP_ID?.trim();
  const secret = process.env.CLOUDFLARE_CALLS_APP_SECRET?.trim();
  return appId && secret ? { appId, secret } : null;
}

/** Both env vars set. Unset → join/SFU routes answer 503. */
export function isMeetingsConfigured(): boolean {
  return credentials() !== null;
}

async function call<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<T> {
  const creds = credentials();
  if (!creds) {
    throw new SfuError('Meetings are not configured', 503, 'not_configured');
  }
  const url = `${SFU_BASE_URL}/${encodeURIComponent(creds.appId)}/${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${creds.secret}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(SFU_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new SfuError(
        `Cloudflare Realtime did not respond within ${SFU_TIMEOUT_MS}ms`,
        504,
        'timeout'
      );
    }
    throw new SfuError('Cloudflare Realtime is unreachable', 502, 'network');
  }

  const text = await res.text();
  let json: (T & { errorCode?: unknown }) | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const errorCode =
    json && typeof json.errorCode === 'string' && json.errorCode
      ? json.errorCode
      : null;

  if (!res.ok) {
    throw new SfuError(
      `Cloudflare Realtime answered ${res.status}`,
      res.status,
      errorCode ?? `http_${res.status}`
    );
  }
  // A request-level error inside a 2xx (per-track errors stay in the body
  // for the caller to read).
  if (errorCode) {
    throw new SfuError(
      `Cloudflare Realtime refused the request (${errorCode})`,
      502,
      errorCode
    );
  }
  if (!json || typeof json !== 'object') {
    throw new SfuError(
      'Cloudflare Realtime sent an unreadable answer',
      502,
      'bad_response'
    );
  }
  return json;
}

const session = (sessionId: string) =>
  `sessions/${encodeURIComponent(sessionId)}`;

/** POST sessions/new — an unconnected session; negotiation follows. */
export async function createSession(): Promise<NewSessionResponse> {
  const res = await call<NewSessionResponse>('POST', 'sessions/new');
  if (typeof res.sessionId !== 'string' || !res.sessionId) {
    throw new SfuError(
      'Cloudflare Realtime returned no session id',
      502,
      'bad_response'
    );
  }
  return res;
}

export function newTracks(
  sessionId: string,
  request: TracksRequest
): Promise<TracksResponse> {
  return call('POST', `${session(sessionId)}/tracks/new`, request);
}

export function renegotiate(
  sessionId: string,
  sessionDescription: SessionDescription
): Promise<RenegotiateResponse> {
  return call('PUT', `${session(sessionId)}/renegotiate`, {
    sessionDescription,
  });
}

export function closeTracks(
  sessionId: string,
  request: CloseTracksRequest
): Promise<CloseTracksResponse> {
  return call('PUT', `${session(sessionId)}/tracks/close`, request);
}

export function getSession(
  sessionId: string
): Promise<GetSessionStateResponse> {
  return call('GET', session(sessionId));
}
