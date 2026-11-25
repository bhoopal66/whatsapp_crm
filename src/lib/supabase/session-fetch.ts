import {
  AuthRetryableFetchError,
  type SupabaseClient,
} from '@supabase/supabase-js';

/**
 * `fetch` for a client that holds a session. auth-js removes the session
 * on any refused token refresh, and takes a 429, and a 4xx that is a page
 * (a Cloudflare challenge), for a refusal. Neither is the auth service's
 * word on the session, so both reach auth-js as a 503, which it retries
 * and keeps the session for. Everything else, the sign-in
 * (`grant_type=password`) included, passes untouched.
 *
 * auth-js sends a refresh answered 503 eight times in 25 s. After such an
 * answer the client therefore answers its own refreshes for as long as it
 * was asked to (`Retry-After`), and the retries never reach the limiter.
 * The pause is the client's: make one fetch for each.
 */
export function createSessionFetch(): typeof fetch {
  return createThrottledFetch().fetch;
}

/**
 * The browser's. A PC whose clock runs slow believes an expired access
 * token is still good: auth-js compares the server's `expires_at` with
 * the PC's time, so for as many minutes as the clock is behind (less the
 * 90 s margin), every hour, each request was refused "JWT expired" and
 * nothing loaded. So
 *  - a token received ends by the PC's own clock (`expires_in`), never
 *    later; a clock running fast keeps the earlier server time;
 *  - a request refused for an expired token (the server side refreshed
 *    it, or the clock was moved) is sent once more with a renewed one.
 */
export function createBrowserSessionFetch(
  client: () => Pick<SupabaseClient, 'auth'> | undefined
): typeof fetch {
  const throttled = createThrottledFetch().fetch;
  return async (input, init) => {
    const res = await throttled(input, init);
    if (isAuthCall(input)) return isTokenGrant(input) ? byOwnClock(res) : res;
    if (!(await saysExpired(res))) return res;
    const headers = new Headers(init?.headers);
    const sent = headers.get('authorization')?.replace(/^Bearer /i, '');
    const auth = client()?.auth;
    // A stream cannot be read a second time.
    if (!sent || !auth || init?.body instanceof ReadableStream) return res;
    const token = await renewedToken(auth, sent).catch(() => null);
    if (!token) return res;
    headers.set('authorization', `Bearer ${token}`);
    return throttled(input, { ...init, headers });
  };
}

/** The token another request or tab already got, or a new one. */
async function renewedToken(
  auth: SupabaseClient['auth'],
  sent: string
): Promise<string | null> {
  const held = (await auth.getSession()).data.session?.access_token;
  if (held && held !== sent) return held;
  const { data } = await auth.refreshSession();
  const token = data.session?.access_token;
  return token && token !== sent ? token : null;
}

async function saysExpired(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 400 && res.status !== 403) {
    return false;
  }
  if (!/json/.test(res.headers.get('content-type') ?? '')) return false;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== 'object') return false;
  const { code, message } = body as { code?: unknown; message?: unknown };
  return (
    code === 'PGRST303' ||
    message === 'JWT expired' ||
    // Storage's words for it.
    message === '"exp" claim timestamp check failed'
  );
}

async function byOwnClock(res: Response): Promise<Response> {
  if (!res.ok) return res;
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null);
  if (!body || typeof body !== 'object') return res;
  const { expires_in, expires_at } = body as Record<string, unknown>;
  if (typeof expires_in !== 'number' || typeof expires_at !== 'number') {
    return res;
  }
  const own = Math.floor(Date.now() / 1000) + expires_in;
  if (own >= expires_at) return res;
  // Not `Response.json`: Safari before 17 (an iPhone 8 stays on iOS 16)
  // does not have it, and a refresh that throws is sent again.
  return new Response(JSON.stringify({ ...body, expires_at: own }), {
    status: res.status,
    statusText: res.statusText,
    headers: { 'content-type': 'application/json' },
  });
}

const DEFAULT_PAUSE_S = 5;
const MAX_PAUSE_S = 30;

function createThrottledFetch() {
  let pausedUntil = 0;
  const throttled: typeof fetch = async (input, init) => {
    if (!isTokenRefresh(input)) return fetch(input, init);
    if (Date.now() < pausedUntil) return noAnswer('paused');
    const res = await fetch(input, init);
    if (!(await saysNothing(res))) return res;
    pausedUntil = Date.now() + pauseSeconds(res) * 1000;
    return noAnswer(`HTTP ${res.status}`);
  };
  return { fetch: throttled, pausedUntil: () => pausedUntil };
}

/** How long one request may wait for a token refresh. */
export const SERVER_REFRESH_WAIT_MS = 3000;

/**
 * Forwarded by the middleware, to this request's route handler or page
 * only, when its own refresh got no answer: they do not ask (and wait)
 * again.
 */
export const REFRESH_UNANSWERED_COOKIE = 'sb-wacrm-refresh-unanswered';

/**
 * The same for a client that lives for one request, which must not sit
 * out auth-js's 25 s of retries: after `SERVER_REFRESH_WAIT_MS`, or at
 * once when the pause outlasts that, the refresh ends the way those
 * retries end (AuthRetryableFetchError: the session is kept, and an
 * access token still valid is still used).
 *
 * auth-js has no option for it, hence `bound` replacing the method that
 * runs the retries. They go on behind it and cannot be stopped, so from
 * then on nothing is sent: a token rotated after the answer has gone out
 * would never reach the browser.
 */
export function createServerRefresh(alreadyUnanswered = () => false) {
  const throttled = createThrottledFetch();
  const inFlight = new AbortController();
  let gaveUp = false;
  let announce: () => void = () => {};
  const givenUp = new Promise<void>((resolve) => (announce = resolve));
  let wait: { until: number; timer: ReturnType<typeof setTimeout> } | undefined;

  const stopWaiting = () => {
    clearTimeout(wait?.timer);
    wait = undefined;
  };
  const giveUp = () => {
    stopWaiting();
    gaveUp = true;
    announce();
    inFlight.abort();
  };

  const serverFetch: typeof fetch = async (input, init) => {
    if (!isTokenRefresh(input)) return fetch(input, init);
    if (gaveUp || alreadyUnanswered()) {
      giveUp();
      return noAnswer('given up');
    }
    wait ??= {
      until: Date.now() + SERVER_REFRESH_WAIT_MS,
      timer: setTimeout(giveUp, SERVER_REFRESH_WAIT_MS),
    };
    const res = await throttled.fetch(input, {
      ...init,
      signal: inFlight.signal,
    });
    if (res.status >= 500 && wait && throttled.pausedUntil() >= wait.until) {
      giveUp();
    }
    return res;
  };

  return {
    fetch: serverFetch,
    gaveUp: () => gaveUp,
    /** Applies the bound to the client made with `fetch`; returns it. */
    bound<C extends Pick<SupabaseClient, 'auth'>>(client: C): C {
      const auth = client.auth as unknown as {
        _refreshAccessToken?: (refreshToken: string) => Promise<unknown>;
      };
      const refresh = auth._refreshAccessToken?.bind(auth);
      if (!refresh) return client;
      auth._refreshAccessToken = (refreshToken) =>
        Promise.race([
          // Not once fetch answers: the answer's body may stall too.
          refresh(refreshToken).finally(stopWaiting),
          givenUp.then(() => ({
            data: { session: null, user: null },
            error: new AuthRetryableFetchError('No answer', 503),
          })),
        ]);
      return client;
    },
  };
}

function noAnswer(statusText: string): Response {
  return new Response(null, { status: 503, statusText });
}

function pauseSeconds(res: Response): number {
  const asked = Number(res.headers.get('retry-after') ?? NaN);
  return asked > 0 ? Math.min(asked, MAX_PAUSE_S) : DEFAULT_PAUSE_S;
}

function urlOf(input: RequestInfo | URL): URL {
  return new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url
  );
}

const isAuthCall = (input: RequestInfo | URL) =>
  urlOf(input).pathname.includes('/auth/v1/');

const isTokenGrant = (input: RequestInfo | URL) =>
  urlOf(input).pathname.endsWith('/auth/v1/token');

function isTokenRefresh(input: RequestInfo | URL): boolean {
  const { pathname, searchParams } = urlOf(input);
  return (
    pathname.endsWith('/auth/v1/token') &&
    searchParams.get('grant_type') === 'refresh_token'
  );
}

async function saysNothing(res: Response): Promise<boolean> {
  if (res.status === 429) return true;
  if (res.status < 400 || res.status >= 500) return false;
  return res
    .clone()
    .json()
    .then(
      () => false,
      () => true
    );
}
