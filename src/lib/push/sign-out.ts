/**
 * Forget this browser's push subscription as its session ends, so a
 * shared or handed-on device stops showing the signed-out person's
 * notifications. Every sign-out path calls this *before*
 * `auth.signOut()`: the server delete needs the session still valid.
 *
 * Best-effort by contract: it never throws and gives up after
 * `timeoutMs` (2 s), so it can never hold sign-out hostage. `all` (the
 * "sign out everywhere" path) also deletes every device the person
 * registered, not only this one.
 */

export interface PushSubscriptionLike {
  endpoint: string;
  unsubscribe(): Promise<boolean>;
}

export interface PushSignOutDeps {
  /** This browser's subscription, or null when it has none. */
  getSubscription(): Promise<PushSubscriptionLike | null>;
  /** POST /api/push/unsubscribe with the given body. */
  post(body: { endpoint: string } | { all: true }): Promise<unknown>;
}

export const PUSH_SIGN_OUT_TIMEOUT_MS = 2_000;

export async function releasePushOnSignOut(
  { all = false }: { all?: boolean } = {},
  deps: PushSignOutDeps = browserPushDeps(),
  timeoutMs = PUSH_SIGN_OUT_TIMEOUT_MS
): Promise<void> {
  const work = (async () => {
    const sub = await deps.getSubscription().catch(() => null);
    // Server first, while the session is still good; the browser-side
    // unsubscribe runs whatever the server answered.
    if (all) await deps.post({ all: true }).catch(() => undefined);
    else if (sub) {
      await deps.post({ endpoint: sub.endpoint }).catch(() => undefined);
    }
    if (sub) await sub.unsubscribe().catch(() => false);
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([work, timeout]);
  clearTimeout(timer);
}

/**
 * The one way the app signs out: release push first, then run
 * `signOut` (the caller's `supabase.auth.signOut(...)`) and return its
 * result untouched.
 */
export async function signOutReleasingPush<R>(
  signOut: () => Promise<R>,
  opts: { all?: boolean } = {},
  deps?: PushSignOutDeps
): Promise<R> {
  await releasePushOnSignOut(opts, deps);
  return signOut();
}

/** The real browser: the root service worker's push subscription. */
export function browserPushDeps(): PushSignOutDeps {
  return {
    async getSubscription() {
      if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
        return null;
      }
      const reg = await navigator.serviceWorker.getRegistration('/');
      return (await reg?.pushManager?.getSubscription()) ?? null;
    },
    post: (body) =>
      fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      }),
  };
}
