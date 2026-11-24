// ============================================================
// Signing out of this device only. auth-js's default scope is `global`,
// which ended the person's session on every device they use; that is
// what Settings' "Sign out of all devices" is for.
// ============================================================

import { signOutReleasingPush } from '@/lib/push/sign-out';
import { statusFromAnswer } from './session-state';

/** The part of `supabase.auth` this needs. */
export interface DeviceAuth {
  signOut(options: { scope: 'local' }): Promise<{ error: unknown }>;
  getSession(): Promise<{
    data: { session: { user: unknown } | null };
    error: unknown;
  }>;
}

/** How long one call to the auth service may hold the sign-out up. */
export const SIGN_OUT_WAIT_MS = 8_000;

async function answerOf<T>(
  work: Promise<T>
): Promise<T | { data: { session: null }; error: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), SIGN_OUT_WAIT_MS);
  });
  try {
    return await Promise.race([work, late]);
  } catch (error) {
    return { data: { session: null }, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Release push, then end this device's session. Whether it ended: a
 * local sign-out drops the stored session before asking the server to
 * revoke it, so an error (offline, a 5xx) usually comes with the session
 * gone, and that is a sign-out. False = this device is still signed in.
 */
export async function signOutThisDevice(auth: DeviceAuth): Promise<boolean> {
  const { error } = await signOutReleasingPush(() =>
    answerOf(auth.signOut({ scope: 'local' }))
  );
  if (!error) return true;
  const left = await answerOf(auth.getSession());
  return statusFromAnswer(left.data.session?.user, left.error) === 'signed_out';
}
