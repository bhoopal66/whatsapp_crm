// localStorage is shared by every login on a browser, so anything a
// person keeps there about customers is keyed by user and removed on
// sign-out and on a user change (`use-auth.tsx`), like `session-cache.ts`.

/** Team-chat composer drafts: `wacrm.chat.draft.<userId>.<channelId>…`. */
export const DRAFT_KEY_PREFIX = 'wacrm.chat.draft.';

/** Keypad recent dials: `pbx:recent-dials:<accountId>:<userId>`. */
export const RECENT_DIALS_KEY_PREFIX = 'pbx:recent-dials';

export const recentDialsKey = (
  accountId: string | null | undefined,
  userId: string | null | undefined
): string =>
  `${RECENT_DIALS_KEY_PREFIX}:${accountId ?? 'none'}:${userId ?? 'none'}`;

const PREFIXES = [DRAFT_KEY_PREFIX, RECENT_DIALS_KEY_PREFIX];

/**
 * Remove every per-user key, including the un-keyed ones older builds
 * wrote (prefix match). Never throws: storage can be blocked.
 */
export function sweepPerUserBrowserStorage(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem'>
): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    for (const k of doomed) storage.removeItem(k);
  } catch {
    // storage blocked or full: nothing to remove
  }
}
