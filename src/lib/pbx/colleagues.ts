// ============================================================
// The Calls screen's Colleagues tab (?tab=colleagues): the phone
// directory Linkus used to be. Pure, no I/O; see
// __tests__/colleagues.test.ts.
//
// Rows are the workspace's extensions (pbx_extensions, every member may
// read them), on the caller's own connection when they have one. A row
// with a person whose name is known is listed by name, people first,
// sorted by name; any other extension is listed by its number only,
// after them, sorted by number.
//
// The dot is the PHONE's state, not the app's: this is the directory a
// person dials from. It is shown only for an extension whose presence
// is monitored (only those have pbx_presence rows), and only when the
// person's freshest phone row is this extension's (a person can hold an
// extension on another connection). A monitored extension with no row
// yet reads as available, as presenceView reads a row with no status.
// An extension with no person has no dot: usePhonePresence keys by
// person and keeps no row without one.
// ============================================================

import type { PersonPresence } from '@/lib/person-presence';
import type { PresenceView, UserPresence } from './presence';

/** A pbx_extensions row as the tab reads it. */
export interface ExtensionRow {
  extension: string;
  user_id: string | null;
  presence_monitor: boolean | null;
  /** 'registered' / 'unregistered' (event 30007, extension sync); null unknown. */
  registration_state: string | null;
}

export interface ColleagueRow {
  extension: string;
  userId: string | null;
  /** The person's name; null lists the extension by number only. */
  name: string | null;
  /** The phone's state, or null when it is not known. */
  presence: PersonPresence | null;
  /** No phone or app is signed in to the extension. */
  unregistered: boolean;
  /** The caller's own extension: no Call button. */
  mine: boolean;
}

/** The phone's view as a dot: the phone's available is a green dot. */
export const phoneDot = (view: PresenceView): PersonPresence =>
  view === 'available' ? 'online' : view;

const byText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** People by name, then extensions with no name by number. */
export function compareColleagues(a: ColleagueRow, b: ColleagueRow): number {
  if (a.name !== null && b.name !== null)
    return byText(a.name, b.name) || byText(a.extension, b.extension);
  if (a.name !== null) return -1;
  if (b.name !== null) return 1;
  return byText(a.extension, b.extension);
}

export function colleagueRows(input: {
  extensions: readonly ExtensionRow[];
  /** User id → name (profiles of the active workspace). */
  names: Readonly<Record<string, string>>;
  /** usePhonePresence: by lower-cased user id. */
  phone: Readonly<Record<string, UserPresence>>;
  /** The caller's auth user id. */
  myUserId: string | null;
  /** The caller's extension, when they have one. */
  myExtension?: string | null;
}): ColleagueRow[] {
  const { extensions, names, phone, myUserId, myExtension } = input;
  const me = myUserId?.toLowerCase() ?? null;
  return extensions
    .map((x): ColleagueRow => {
      const user = x.user_id?.toLowerCase() ?? null;
      const name = x.user_id ? names[x.user_id]?.trim() || null : null;
      const live = user ? phone[user] : undefined;
      const presence =
        !user || !x.presence_monitor
          ? null
          : live
            ? live.extension === x.extension
              ? phoneDot(live.state)
              : null
            : 'online';
      return {
        extension: x.extension,
        userId: x.user_id,
        name,
        presence,
        unregistered:
          x.registration_state !== null &&
          x.registration_state !== 'registered',
        mine:
          (myExtension != null && x.extension === myExtension) ||
          (me !== null && user === me),
      };
    })
    .sort(compareColleagues);
}

/** The search box: a part of the name or of the extension, any case. */
export function filterColleagues(
  rows: readonly ColleagueRow[],
  query: string
): ColleagueRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (r) =>
      r.extension.toLowerCase().includes(q) ||
      (r.name !== null && r.name.toLowerCase().includes(q))
  );
}
