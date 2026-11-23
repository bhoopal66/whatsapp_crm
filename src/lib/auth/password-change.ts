// ============================================================
// The change-password form's decisions, kept pure so they are testable
// without a DOM: the request, and which message a refusal shows
// (`Settings.profile`).
// ============================================================

export type PasswordChangeFailure =
  | {
      key:
        | 'currentPasswordIncorrect'
        | 'passwordRefused'
        | 'passwordRateLimited'
        | 'passwordUnavailable';
    }
  | { key: 'passwordLocked'; minutes: number };

/** Through our server, so the sign-in lockout counts a wrong guess. */
export async function changeMyPassword(
  currentPassword: string,
  newPassword: string
): Promise<PasswordChangeFailure | null> {
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch {
    // No answer at all: `status` stays 0.
  }
  return status === 200 ? null : passwordChangeFailure(status, body);
}

export function passwordChangeFailure(
  status: number,
  body: unknown
): PasswordChangeFailure {
  switch (status) {
    case 403:
      return { key: 'currentPasswordIncorrect' };
    case 400:
    case 422:
      return { key: 'passwordRefused' };
    case 423: {
      const seconds = (body as { retryAfterSeconds?: unknown } | null)
        ?.retryAfterSeconds;
      return {
        key: 'passwordLocked',
        minutes:
          typeof seconds === 'number' && seconds > 0
            ? Math.ceil(seconds / 60)
            : 15,
      };
    }
    case 429:
      return { key: 'passwordRateLimited' };
    default:
      return { key: 'passwordUnavailable' };
  }
}
