/** Session-cache question (`lib/session-cache.ts`) for /chat's people. */
export const CHAT_PEOPLE_QUESTION = 'chat:people';

/**
 * The waits before each retry of a failed read of the people list. All
 * of them fit inside the 60 s refresh, so retries never overlap it.
 */
export const PEOPLE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000] as const;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read the people list, retrying a failure. Every name in team chat
 * comes from this list, so a tab whose first read failed used to show
 * everyone as "Unknown" until the next refresh a minute later (one 503
 * from the gateway was enough). Rethrows once the retries are spent.
 */
export async function loadPeopleWithRetries<T>(
  read: () => Promise<T>,
  wait: (ms: number) => Promise<void> = sleep
): Promise<T> {
  for (const delay of PEOPLE_RETRY_DELAYS_MS) {
    try {
      return await read();
    } catch {
      await wait(delay);
    }
  }
  return read();
}

/**
 * The name for a person the list does not have. Blank while the list is
 * still on its way, or every author would flash "Unknown" on each page
 * load; the word is only true once the list has answered or given up.
 */
export function unknownPersonName(
  list: { loaded: boolean; failed: boolean },
  word: string
): string {
  return list.loaded || list.failed ? word : '';
}
