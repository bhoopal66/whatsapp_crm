/**
 * One voice recording at a time across every team-chat composer on the
 * page (the channel's and the thread panel's). A second microphone take
 * would fight the first for the device, and the person could not tell
 * which composer is listening, so a start while another composer holds
 * the guard is refused rather than stopping the other one: stopping it
 * would stage a take the person never chose to end.
 */
export interface RecorderGuard {
  /** Takes the guard for `owner`; false while another owner holds it. */
  claim(owner: object): boolean;
  /** Frees the guard if `owner` holds it; anyone else's claim stays. */
  release(owner: object): void;
  /** Whether anyone holds it. */
  held(): boolean;
}

export function createRecorderGuard(): RecorderGuard {
  let holder: object | null = null;
  return {
    claim(owner) {
      if (holder !== null && holder !== owner) return false;
      holder = owner;
      return true;
    },
    release(owner) {
      if (holder === owner) holder = null;
    },
    held: () => holder !== null,
  };
}

/** The page's guard, shared by every mounted composer. */
export const chatRecorderGuard: RecorderGuard = createRecorderGuard();
