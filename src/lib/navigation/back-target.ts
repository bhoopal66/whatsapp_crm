/**
 * Where an in-page "Back" link should go.
 *
 * A detail page (a customer, a case, a group …) is reached from many
 * screens, so a hard-wired "Back to Contacts" sent someone who opened a
 * customer from Calls to the contacts list. This module keeps an
 * in-memory stack of the in-app locations (pathname + search) this
 * document has shown, mirroring the tab's history as well as the
 * router lets us: a normal navigation pushes, a `popstate` navigation
 * (browser back/forward, `router.back()`) pops when it lands on the
 * entry below the top and otherwise pushes. When there is an in-app
 * entry before the current one, Back is `router.back()`; when there is
 * none (a fresh tab, a reload, a link from outside) Back is a plain
 * link to the page's own fallback.
 *
 * It is module state on purpose: it lives exactly as long as the
 * document, which is the lifetime of the history `router.back()` walks.
 * It is never written on the server (only the tracker's effects and
 * listeners write it), so a server render always plans a link.
 *
 * Known limit: a cross-path `router.replace` is recorded as a push, so
 * the label may name the replaced page while `router.back()` goes one
 * further. A same-path change (filters, tabs in the query) replaces the
 * top entry instead, because those are usually `router.replace` and
 * the place is the same either way.
 */

/** Keys in the `BackNav` message namespace. */
export type BackLabelKey =
  | 'back'
  | 'dashboard'
  | 'notifications'
  | 'inbox'
  | 'teamInbox'
  | 'calls'
  | 'callReport'
  | 'groups'
  | 'group'
  | 'submissionGroups'
  | 'submissionGroup'
  | 'cases'
  | 'case'
  | 'banks'
  | 'bank'
  | 'chat'
  | 'meetings'
  | 'meeting'
  | 'calendar'
  | 'contacts'
  | 'customer'
  | 'teamContacts'
  | 'pipelines'
  | 'journeys'
  | 'teamActivity'
  | 'broadcasts'
  | 'automations'
  | 'flows'
  | 'flow'
  | 'compass'
  | 'opendesk'
  | 'settings';

// Whole path segments, longest route wins; `*` matches one segment.
// Only detail pages that are themselves a likely Back target get their
// own label; /broadcasts/new and the like fall through to their list.
const ROUTE_LABELS: ReadonlyArray<readonly [string, BackLabelKey]> = [
  ['/dashboard', 'dashboard'],
  ['/notifications', 'notifications'],
  ['/inbox', 'inbox'],
  ['/team-inbox', 'teamInbox'],
  ['/calls', 'calls'],
  ['/calls/report', 'callReport'],
  ['/groups', 'groups'],
  ['/groups/*', 'group'],
  ['/submission-groups', 'submissionGroups'],
  ['/submission-groups/*', 'submissionGroup'],
  ['/cases', 'cases'],
  ['/cases/*', 'case'],
  ['/banks', 'banks'],
  ['/banks/*', 'bank'],
  ['/chat', 'chat'],
  ['/meetings', 'meetings'],
  ['/meetings/*', 'meeting'],
  ['/calendar', 'calendar'],
  ['/contacts', 'contacts'],
  ['/contacts/*', 'customer'],
  ['/team-contacts', 'teamContacts'],
  ['/pipelines', 'pipelines'],
  ['/journeys', 'journeys'],
  ['/team-activity', 'teamActivity'],
  ['/broadcasts', 'broadcasts'],
  ['/automations', 'automations'],
  ['/flows', 'flows'],
  ['/flows/*', 'flow'],
  ['/compass', 'compass'],
  ['/opendesk', 'opendesk'],
  ['/settings', 'settings'],
];

/** Every key `backLabelKey` can return (for the catalogue test). */
export const BACK_LABEL_KEYS: readonly BackLabelKey[] = [
  'back',
  ...new Set(ROUTE_LABELS.map(([, key]) => key)),
];

/** Entries kept; older ones fall off (a Back that far is the browser's). */
export const MAX_ENTRIES = 50;

function segments(path: string): string[] {
  return path.split(/[?#]/)[0].split('/').filter(Boolean);
}

function pathOf(location: string): string {
  return location.split(/[?#]/)[0];
}

/** The label for going to `location`: a key in `BackNav`. */
export function backLabelKey(
  location: string | null | undefined
): BackLabelKey {
  const path = segments(location ?? '');
  let best: { key: BackLabelKey; depth: number } | null = null;
  for (const [route, key] of ROUTE_LABELS) {
    const r = segments(route);
    const covers =
      r.length <= path.length && r.every((s, i) => s === '*' || s === path[i]);
    if (covers && (!best || r.length > best.depth))
      best = { key, depth: r.length };
  }
  return best?.key ?? 'back';
}

let stack: string[] = [];
let pendingPop: string | null = null;

/** The stack after recording `location`, without touching module state. */
function applied(
  from: readonly string[],
  location: string,
  popstate: boolean
): string[] {
  const top = from[from.length - 1];
  if (top === location) return [...from];
  if (popstate && from.length >= 2 && from[from.length - 2] === location)
    return from.slice(0, -1);
  if (top !== undefined && pathOf(top) === pathOf(location))
    return [...from.slice(0, -1), location];
  const next = [...from, location];
  return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
}

/** Record that this document now shows `location` (pathname + search). */
export function recordNavigation(
  location: string,
  { popstate = false }: { popstate?: boolean } = {}
): void {
  stack = applied(stack, location, popstate);
}

/**
 * Note a `popstate` landing on `location`, at event time. The page it
 * lands on renders before the tracker records it, so `backPlan` uses
 * this to tell a Back-button return from a link to the same page.
 */
export function notePopstate(location: string): void {
  pendingPop = location;
}

/** Was the navigation to `location` a noted `popstate`? Clears the note. */
export function consumePopstate(location: string): boolean {
  const was = pendingPop === location;
  pendingPop = null;
  return was;
}

/**
 * The stack as it will be once the page at `currentPathname` is
 * recorded. A page renders before the tracker's effect runs, so during
 * that render the top is still the page being left.
 */
function projected(currentPathname: string | undefined): string[] {
  const top = stack[stack.length - 1];
  if (currentPathname === undefined || top === undefined) return stack;
  if (pathOf(top) === currentPathname) return stack;
  const pop =
    pendingPop !== null && pathOf(pendingPop) === currentPathname
      ? pendingPop
      : null;
  return applied(stack, pop ?? currentPathname, pop !== null);
}

/** The in-app location before the current one in this document, if any. */
export function previousLocation(currentPathname?: string): string | null {
  const s = projected(currentPathname);
  return s.length >= 2 ? s[s.length - 2] : null;
}

export type BackPlan =
  | { mode: 'history'; label: BackLabelKey }
  | { mode: 'link'; href: string; label: BackLabelKey };

/**
 * `history` (call `router.back()`) when this document has an in-app
 * entry before the current page, else a `link` to `fallbackHref`.
 * Pass the page's pathname so a plan made while the page first renders
 * already counts the page itself.
 */
export function backPlan(
  fallbackHref: string,
  currentPathname?: string
): BackPlan {
  const previous = previousLocation(currentPathname);
  if (previous !== null)
    return { mode: 'history', label: backLabelKey(previous) };
  return {
    mode: 'link',
    href: fallbackHref,
    label: backLabelKey(fallbackHref),
  };
}

/** Test seam: forget everything this document recorded. */
export function resetBackTarget(): void {
  stack = [];
  pendingPop = null;
}
