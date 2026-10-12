import { YeastarError } from './errors';

/** Where the PBX's Open API lives. */
export interface YeastarConnection {
  /** `https://{pbx_domain}` (Cloud) or `https://{ip}:8088` (on-prem). */
  baseUrl: string;
  /** Defaults to `openapi/v1.0`. */
  apiPath?: string;
  /** Defaults to `wacrm`. */
  userAgent?: string;
  /** Per-request timeout in ms; defaults to 10 s. */
  timeoutMs?: number;
}

export type YeastarMethod = 'GET' | 'POST';
export type YeastarQuery = Record<string, string | number | undefined>;
export type FetchFn = typeof fetch;

export const DEFAULT_API_PATH = 'openapi/v1.0';
export const DEFAULT_USER_AGENT = 'wacrm';
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface ResolvedConnection {
  baseUrl: string;
  apiPath: string;
  userAgent: string;
  timeoutMs: number;
}

export function resolveConnection(c: YeastarConnection): ResolvedConnection {
  return {
    baseUrl: c.baseUrl.replace(/\/+$/, ''),
    apiPath: (c.apiPath ?? DEFAULT_API_PATH).replace(/^\/+|\/+$/g, ''),
    userAgent: c.userAgent || DEFAULT_USER_AGENT,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Joins without doubling the slash: Yeastar's documented recipe is
 * `{base_url}/{download_resource_url}`, but `download_resource_url`
 * itself starts with `/api/...`.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Error text must never carry the token that rides in the query string. */
export function redactToken(text: string): string {
  return text.replace(/access_token=[^&\s"']+/g, 'access_token=REDACTED');
}

function transportReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err.cause : undefined;
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : null;
  return redactToken(code ? `${message} (${code})` : message);
}

/**
 * One Open API round trip. The token travels in the query string (the
 * docs show no header form), and every request carries a `User-Agent`:
 * the docs make it mandatory for the PBX to answer at all. The body is
 * parsed whatever the status line says, because `errcode` is the only
 * documented failure signal.
 */
export async function callYeastar(
  conn: ResolvedConnection,
  fetchImpl: FetchFn,
  method: YeastarMethod,
  endpoint: string,
  options: { query?: YeastarQuery; body?: unknown; accessToken?: string } = {}
): Promise<Record<string, unknown>> {
  const url = new URL(joinUrl(joinUrl(conn.baseUrl, conn.apiPath), endpoint));
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  if (options.accessToken !== undefined) {
    url.searchParams.set('access_token', options.accessToken);
  }

  const headers: Record<string, string> = {
    'User-Agent': conn.userAgent,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conn.timeoutMs);
  let status: number;
  let text: string;
  try {
    const res = await fetchImpl(url.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (err) {
    throw new YeastarError({
      endpoint,
      errcode: null,
      errmsg: controller.signal.aborted ? 'TIMEOUT' : 'NETWORK ERROR',
      detail: controller.signal.aborted
        ? `no answer within ${conn.timeoutMs} ms`
        : transportReason(err),
    });
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { errcode?: unknown }).errcode !== 'number'
  ) {
    throw new YeastarError({
      endpoint,
      errcode: null,
      errmsg: 'INVALID RESPONSE',
      httpStatus: status,
      detail: `HTTP ${status} without a Yeastar envelope`,
    });
  }
  const envelope = parsed as Record<string, unknown> & { errcode: number };
  if (envelope.errcode !== 0) {
    throw new YeastarError({
      endpoint,
      errcode: envelope.errcode,
      errmsg: typeof envelope.errmsg === 'string' ? envelope.errmsg : 'FAILURE',
      httpStatus: status,
      response: envelope,
    });
  }
  return envelope;
}
