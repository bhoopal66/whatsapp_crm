/**
 * The top bar's title for a dashboard path: a key in the `Header`
 * message namespace.
 *
 * Matched on whole path segments, longest route first, so /team-inbox
 * is never "Inbox", /calls is never the dashboard and /contacts/<id>
 * (the customer page) is not the contacts list. A path no route claims
 * falls back to the dashboard's title.
 */
const ROUTE_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['/dashboard', 'dashboard'],
  ['/notifications', 'notifications'],
  ['/inbox', 'inbox'],
  ['/team-inbox', 'teamInbox'],
  ['/calls', 'calls'],
  ['/groups', 'whatsappGroups'],
  // /groups/<id>: one group's page.
  ['/groups/*', 'whatsappGroup'],
  ['/submission-groups', 'submissionGroups'],
  // /submission-groups/<id>: one submission's group.
  ['/submission-groups/*', 'submissionGroup'],
  ['/cases', 'cases'],
  ['/banks', 'banks'],
  // /banks/<id>: one bank's internal space.
  ['/banks/*', 'bank'],
  ['/chat', 'chat'],
  ['/meetings', 'meetings'],
  ['/calendar', 'calendar'],
  ['/contacts', 'contacts'],
  // /contacts/<id>: one customer's page.
  ['/contacts/*', 'customer'],
  ['/team-contacts', 'teamContacts'],
  ['/pipelines', 'pipelines'],
  ['/journeys', 'journeys'],
  ['/team-activity', 'teamActivity'],
  ['/broadcasts', 'broadcasts'],
  ['/automations', 'automations'],
  ['/flows', 'flows'],
  ['/compass', 'compass'],
  ['/settings', 'settings'],
  // AI agents moved into Settings; /agents only redirects there.
  ['/agents', 'settings'],
];

/** Every `Header` key `pageTitleKey` can return (for the catalogue test). */
export const PAGE_TITLE_KEYS: readonly string[] = [
  ...new Set(ROUTE_TITLES.map(([, key]) => key)),
];

function segments(path: string): string[] {
  return path.split(/[?#]/)[0].split('/').filter(Boolean);
}

/** Does `route` (a `*` segment matches any one segment) cover `path`? */
function covers(route: string[], path: string[]): boolean {
  return (
    route.length <= path.length &&
    route.every((seg, i) => seg === '*' || seg === path[i])
  );
}

export function pageTitleKey(pathname: string | null | undefined): string {
  const path = segments(pathname ?? '');
  let best: { key: string; depth: number } | null = null;
  for (const [route, key] of ROUTE_TITLES) {
    const r = segments(route);
    if (covers(r, path) && (!best || r.length > best.depth))
      best = { key, depth: r.length };
  }
  return best?.key ?? 'dashboard';
}
