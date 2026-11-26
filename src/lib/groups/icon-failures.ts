/**
 * Group pictures that did not load, so an avatar shown again (opening a
 * group mounts two) does not ask the gateway again. Memory only, and for
 * ten minutes, as long as the icon route lets a browser keep "no picture".
 */
const TTL_MS = 10 * 60_000;

const failedAt = new Map<string, number>();

const keyOf = (groupId: string, version: number) => `${groupId}:${version}`;

export const groupIconUrl = (groupId: string, version: number) =>
  `/api/whatsapp/groups/${groupId}/icon?v=${version}`;

export function markIconFailed(groupId: string, version: number): void {
  failedAt.set(keyOf(groupId, version), Date.now());
}

export function iconFailed(groupId: string, version: number): boolean {
  // A change is always tried: its number may have been used before.
  if (version !== 0) return false;
  const at = failedAt.get(keyOf(groupId, version));
  return at !== undefined && Date.now() - at < TTL_MS;
}

/**
 * The picture was changed on this screen. `version` starts at 0 again on
 * the next visit, so what is remembered for 0 goes: here, and in the
 * browser, which may hold "no picture" for ten minutes. (The route lets only
 * version 0 be cached, so later versions need nothing.)
 */
export function iconChanged(
  groupId: string,
  version: number,
  fetchImpl: typeof fetch = fetch
): void {
  if (version === 0) return;
  failedAt.delete(keyOf(groupId, 0));
  void fetchImpl(groupIconUrl(groupId, 0), { cache: 'reload' }).catch(() => {});
}
