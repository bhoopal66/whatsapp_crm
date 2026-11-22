/**
 * The browser tab's title: "(N) <page> — Taamul Connect", where N is
 * the unread chat count the sidebar's Inbox entry shows and <page> the
 * name the top bar shows (`pageTitleKey`). No count when nothing is
 * unread; a blank page name leaves just the app name.
 *
 * The " — Taamul Connect" suffix matches the root layout's metadata
 * title template, so the tab never shows two shapes of the same title.
 */

export const APP_NAME = 'Taamul Connect';

/** Above this the count reads "99+": a tab is narrow. */
export const MAX_TITLE_COUNT = 99;

export function formatTabTitle(unread: number, pageName: string): string {
  const name = pageName.trim();
  const base = name ? `${name} — ${APP_NAME}` : APP_NAME;
  const n = Number.isFinite(unread) ? Math.floor(unread) : 0;
  if (n <= 0) return base;
  const count = n > MAX_TITLE_COUNT ? `${MAX_TITLE_COUNT}+` : String(n);
  return `(${count}) ${base}`;
}
