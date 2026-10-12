// ============================================================
// The login page's decisions, kept pure so they are testable without a
// DOM: where to go after signing in, and which message an answer from
// POST /api/auth/login shows.
// ============================================================

/**
 * After sign-in: `/join/<token>` for an invitation (the middleware's
 * rule for a signed-in visitor to `/login?invite=`), else a same-origin
 * `next` path, else the dashboard. `next` never leaves the origin.
 */
export function loginDestination(params: {
  get(name: string): string | null;
}): string {
  const invite = params.get('invite');
  if (invite) return `/join/${encodeURIComponent(invite)}`;
  return safeNextPath(params.get('next')) ?? '/dashboard';
}

function safeNextPath(next: string | null): string | null {
  // "//host" and "/\host" are protocol-relative to a browser.
  if (!next || !next.startsWith('/') || /^\/[/\\]/.test(next)) return null;
  try {
    const base = 'https://origin.invalid';
    const url = new URL(next, base);
    return url.origin === base ? url.pathname + url.search + url.hash : null;
  } catch {
    return null;
  }
}

export type LoginFailure =
  | {
      key:
        | 'invalidCredentials'
        | 'deactivated'
        | 'rateLimited'
        | 'unavailable'
        | 'genericError';
    }
  | { key: 'tooManyAttempts'; minutes: number };

/** The message for a refused sign-in (`status` 0 = no answer). */
export function loginFailure(status: number, body: unknown): LoginFailure {
  switch (status) {
    case 400:
    case 401:
      return { key: 'invalidCredentials' };
    case 403:
      return { key: 'deactivated' };
    case 423: {
      const seconds = (body as { retryAfterSeconds?: unknown } | null)
        ?.retryAfterSeconds;
      const minutes =
        typeof seconds === 'number' && seconds > 0
          ? Math.ceil(seconds / 60)
          : 15;
      return { key: 'tooManyAttempts', minutes };
    }
    case 429:
      return { key: 'rateLimited' };
    case 503:
      return { key: 'unavailable' };
    default:
      return { key: 'genericError' };
  }
}
