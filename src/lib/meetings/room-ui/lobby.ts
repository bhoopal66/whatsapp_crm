// Pure rules for the pre-join lobby: who is already in the call, the mic
// meter and the device pickers.

import type { DeviceOption } from '@/lib/meetings/room/contract';

export interface LobbyPerson {
  userId: string;
  /** Null when the workspace roster does not name them. */
  name: string | null;
}

/**
 * Who is already in the call, from `GET /api/meetings/[id]`.
 *
 * The engine leaves `participants` empty before we join, so the lobby
 * reads the meeting's present seats itself. One person can hold a seat
 * per tab, so seats are deduped by `user_id`, and our own seats (another
 * tab) are left out: "already in the call" means other people.
 *
 * `count` is null when the answer says nothing usable (unknown, not
 * zero). Without a `participants` list a numeric `present_count` still
 * gives a count, with no faces and without our own seat removed.
 */
export function presentOthers(
  body: unknown,
  selfUserId: string | null,
  nameOf: (userId: string) => string | null
): { people: LobbyPerson[]; count: number | null } {
  const rec =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (!Array.isArray(rec.participants)) {
    const n = Number(rec.present_count);
    return {
      people: [],
      count:
        typeof rec.present_count === 'number' && Number.isFinite(n) && n >= 0
          ? Math.floor(n)
          : null,
    };
  }
  const seen = new Set<string>();
  const people: LobbyPerson[] = [];
  for (const row of rec.participants) {
    const userId =
      row && typeof row === 'object'
        ? (row as { user_id?: unknown }).user_id
        : undefined;
    if (typeof userId !== 'string' || !userId) continue;
    if (userId === selfUserId || seen.has(userId)) continue;
    seen.add(userId);
    people.push({ userId, name: nameOf(userId) || null });
  }
  // Named people by name, then the unnamed in a stable order.
  people.sort((a, b) => {
    if (a.name && b.name) return a.name.localeCompare(b.name);
    if (a.name) return -1;
    if (b.name) return 1;
    return a.userId.localeCompare(b.userId);
  });
  return { people, count: people.length };
}

/**
 * Lit bars for a mic level (0..1 RMS, as the engine reports it). Speech
 * sits around 0.05–0.3 RMS, so the scale is a square root that fills
 * every bar at 0.5, and any sound at all lights the first bar.
 */
export function meterBars(level: number, bars = 5): number {
  if (!Number.isFinite(level) || level <= 0 || bars <= 0) return 0;
  const scaled = Math.sqrt(Math.min(level, 0.5) / 0.5) * bars;
  return Math.min(bars, Math.max(1, Math.ceil(scaled - 1e-9)));
}

/**
 * The Select value for "the browser default". The engine's device lists
 * never contain Chrome's `default` alias (`deviceOptionsFrom`), so it
 * cannot collide with a real device id.
 */
export const DEFAULT_DEVICE_VALUE = 'default';

/** Select items: the default first, then each device (unlabelled until the permission is granted). */
export function deviceSelectItems(
  options: readonly DeviceOption[],
  defaultLabel: string,
  unnamed: (n: number) => string
): Record<string, string> {
  const items: Record<string, string> = {
    [DEFAULT_DEVICE_VALUE]: defaultLabel,
  };
  options.forEach((o, i) => {
    if (!o.deviceId || Object.hasOwn(items, o.deviceId)) return;
    items[o.deviceId] = o.label.trim() || unnamed(i + 1);
  });
  return items;
}

/**
 * The Select value for a stored choice. Null is the browser default, and
 * so is a stored device that is not listed (no permission yet, so no
 * ids): the trigger would otherwise show a raw device id.
 */
export function deviceSelectValue(
  selected: string | null,
  items: Record<string, string>
): string {
  return selected && Object.hasOwn(items, selected)
    ? selected
    : DEFAULT_DEVICE_VALUE;
}

/** What `selectDevice` takes for a Select value ('' = the browser default). */
export function deviceIdFromValue(value: unknown): string {
  return typeof value === 'string' && value !== DEFAULT_DEVICE_VALUE
    ? value
    : '';
}
