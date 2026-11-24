// Somebody pressed "Sign out" in this browser just now (here or in
// another tab), so /login carries no `next`: the next person to sign in
// must not land on the last one's page. A session that merely ended keeps it.

const CHANNEL = 'taamul-connect:sign-out';
const VALID_MS = 30_000;

let markedAt: number | null = null;

/** Called before the sign-out; tells the browser's other tabs. */
export function markExplicitSignOut(): void {
  markedAt = Date.now();
  if (typeof window === 'undefined') return;
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(null);
    channel.close();
  } catch {
    // The other tabs keep their `next`.
  }
}

/** Hear the other tabs. Returns the cleanup. */
export function listenForExplicitSignOut(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => {
    markedAt = Date.now();
  };
  return () => channel.close();
}

export function wasExplicitSignOut(now = Date.now()): boolean {
  return markedAt !== null && now - markedAt < VALID_MS;
}
