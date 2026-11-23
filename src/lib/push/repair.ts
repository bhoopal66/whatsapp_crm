/**
 * Whose device is this browser? A push subscription belongs to the
 * browser, not to the login, so a session that ends without a sign-out
 * leaves the next person on a shared PC with the previous person's
 * notifications; and the server can lose its row while the browser
 * still holds a subscription nothing will ever reach.
 *
 * The answer is a localStorage marker holding the id of the person who
 * turned push on here (nothing else), written by subscribe() and
 * removed by unsubscribe() and an explicit sign-out. A device turned on
 * before the marker existed is recognised by its own server row (RLS
 * returns a person only their own) and marked then.
 */

export const PUSH_ENABLED_BY_KEY = 'taamul.push-enabled-by';

export function readPushEnabledBy(): string | null {
  try {
    return window.localStorage.getItem(PUSH_ENABLED_BY_KEY) || null;
  } catch {
    return null;
  }
}

/** Remember (or, with null, forget) who turned push on in this browser. */
export function writePushEnabledBy(userId: string | null): void {
  try {
    if (userId) window.localStorage.setItem(PUSH_ENABLED_BY_KEY, userId);
    else window.localStorage.removeItem(PUSH_ENABLED_BY_KEY);
  } catch {
    // Storage blocked: the person's own server row still recognises them.
  }
}

/**
 * A session change seen by an open tab: does this browser's
 * subscription have to go now? Always when nobody is signed in. Not when
 * the device already belongs to the person signed in now (another tab
 * may just have registered it for them), and not when nobody is
 * recorded: the dashboard's repair asks the server.
 */
export function releaseOnSessionChange(
  enabledBy: string | null,
  nextUserId: string | null
): boolean {
  if (nextUserId === null) return true;
  return enabledBy !== null && enabledBy !== nextUserId;
}

export interface RepairDeps {
  enabledBy(): string | null;
  setEnabledBy(userId: string): void;
  /** Notification permission is granted. */
  granted: boolean;
  subscription(): Promise<{ endpoint: string } | null>;
  /** Whether the caller has a server row for this endpoint; throws when unknown. */
  ownsRow(endpoint: string): Promise<boolean>;
  /** POST this browser's subscription; the HTTP status. Throws offline. */
  register(): Promise<number>;
  /** Subscribe the browser again and register it; the HTTP status. */
  resubscribe(): Promise<number>;
  unsubscribe(): Promise<unknown>;
}

/**
 * Put this browser's subscription right for the person signed in:
 * - theirs (marker, or their own server row): registered again, which
 *   restores a row the server lost;
 * - theirs, but the browser lost it (a lost session releases it) and the
 *   permission still stands: subscribed again;
 * - anyone else's, or nobody knows whose: unsubscribed in the browser.
 * 'failed' changes nothing (offline, a server error): a hiccup must
 * never cost someone their notifications.
 */
export async function repairPush(
  userId: string,
  d: RepairDeps
): Promise<'none' | 'kept' | 'released' | 'failed'> {
  try {
    let mine = d.enabledBy() === userId;
    const sub = await d.subscription();
    if (!sub) {
      if (!mine || !d.granted) return 'none';
      return (await d.resubscribe()) < 300 ? 'kept' : 'failed';
    }
    if (!mine && (await d.ownsRow(sub.endpoint))) {
      d.setEnabledBy(userId);
      mine = true;
    }
    if (!mine) {
      await d.unsubscribe();
      return 'released';
    }
    const status = await d.register();
    if (status === 409) {
      // Registered to someone else with other keys: this subscription
      // can never work here; the next load makes a new one.
      await d.unsubscribe();
      return 'released';
    }
    return status < 300 ? 'kept' : 'failed';
  } catch {
    return 'failed';
  }
}
