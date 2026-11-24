/**
 * `fetch` for the clients that hold a session. auth-js removes the
 * session on any refused token refresh, and takes a 429, and a 4xx that
 * is a page (a Cloudflare challenge), for a refusal. Neither is the auth
 * service's word on the session, so both reach auth-js as a 503, which
 * it retries and keeps the session for. Everything else, the sign-in
 * (`grant_type=password`) included, passes untouched.
 */
export const sessionFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (!isTokenRefresh(input) || !(await saysNothing(res))) return res;
  return new Response(null, { status: 503, statusText: `HTTP ${res.status}` });
};

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
