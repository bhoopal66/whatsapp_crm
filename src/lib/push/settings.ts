import { PUSH_KINDS, type PushKind } from './kinds';

/** GET/PUT /api/push/preferences. A kind mapped to false is off; missing is on. */
export interface PushPreferences {
  enabled: boolean;
  kinds: Partial<Record<PushKind, boolean>>;
  quietStart: string | null;
  quietEnd: string | null;
  timeZone: string | null;
}

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  enabled: true,
  kinds: {},
  quietStart: null,
  quietEnd: null,
  timeZone: null,
};

export function isKindOn(prefs: PushPreferences, kind: PushKind): boolean {
  return prefs.kinds[kind] !== false;
}

export type PushKindGroup = 'messages' | 'meetings' | 'tasksCalls' | 'team';

export const PUSH_KIND_GROUPS: readonly PushKindGroup[] = [
  'messages',
  'meetings',
  'tasksCalls',
  'team',
];

export function kindGroup(kind: string): PushKindGroup {
  if (kind === 'whatsapp_message' || kind === 'chat_message') return 'messages';
  if (
    kind.startsWith('meeting_') ||
    kind.startsWith('calendar_') ||
    kind === 'event_reminder'
  ) {
    return 'meetings';
  }
  if (
    kind.startsWith('task_') ||
    kind.startsWith('call_') ||
    kind === 'callback_requested'
  ) {
    return 'tasksCalls';
  }
  return 'team';
}

/** Every push kind under its settings heading, in PUSH_KINDS order. */
export function groupedPushKinds(): {
  group: PushKindGroup;
  kinds: PushKind[];
}[] {
  return PUSH_KIND_GROUPS.map((group) => ({
    group,
    kinds: PUSH_KINDS.filter((k) => kindGroup(k) === group),
  })).filter((g) => g.kinds.length > 0);
}

/**
 * The body to PUT, or null while the quiet-hours fields are half filled
 * (the server refuses one time without the other, equal times, and
 * times without a zone, so those are not sent at all).
 */
export function preferencesToSave(
  prefs: PushPreferences
): PushPreferences | null {
  const start = prefs.quietStart || null;
  const end = prefs.quietEnd || null;
  if ((start === null) !== (end === null)) return null;
  if (start !== null && start === end) return null;
  if (start !== null && !prefs.timeZone) return null;
  return {
    enabled: prefs.enabled,
    kinds: prefs.kinds,
    quietStart: start,
    quietEnd: end,
    timeZone: start === null ? null : prefs.timeZone,
  };
}

/** Defensive parse of the GET response. */
export function parsePushPreferences(value: unknown): PushPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_PUSH_PREFERENCES;
  const v = value as Record<string, unknown>;
  const kinds: Partial<Record<PushKind, boolean>> = {};
  if (v.kinds && typeof v.kinds === 'object') {
    for (const kind of PUSH_KINDS) {
      const on = (v.kinds as Record<string, unknown>)[kind];
      if (typeof on === 'boolean') kinds[kind] = on;
    }
  }
  const str = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return {
    enabled: v.enabled !== false,
    kinds,
    quietStart: str(v.quietStart),
    quietEnd: str(v.quietEnd),
    timeZone: str(v.timeZone),
  };
}
