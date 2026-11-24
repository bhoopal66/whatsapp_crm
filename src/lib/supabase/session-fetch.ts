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
    if (res.status < 500) stopWaiting();
    else if (wait && throttled.pausedUntil() >= wait.until) giveUp();
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
          refresh(refreshToken),
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

function isTokenRefresh(input: RequestInfo | URL): boolean {
  const url =
    typeof input === 'string' || input instanceof URL ? input : input.url;
  const { pathname, searchParams } = new URL(url);
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
