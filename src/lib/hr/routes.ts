/**
 * The HR screens' routes (migration 200): one per inbox and one per
 * tool, under `/hr`, and the mapping from the old single `/hr-inbox`
 * page's URLs onto them. Pure, so the redirect is tested here.
 */
import type { HrInbox, HrRoles } from './types';

/** The three HR inboxes a route can be: the two HR rows' and Not sorted. */
export type HrInboxRoute = HrInbox | 'unsorted';

export const HR_INBOX_PATHS: Record<HrInboxRoute, string> = {
  recruiter: '/hr/recruiter',
  dept: '/hr/department',
  unsorted: '/hr/unsorted',
};

/** The old `/hr-inbox/<page>` screens and where each lives now. */
const LEGACY_SUB_PAGES: Record<string, string> = {
  tasks: '/hr/tasks',
  setup: '/hr/rules',
  'hire-fast': '/hr/hire-fast',
  'automated-messages': '/hr/automated-messages',
};

/** `/hr-inbox/<page>` → its `/hr/…` route; null for anything else. */
export function legacyHrSubPagePath(
  segments: readonly string[]
): string | null {
  if (segments.length !== 1) return null;
  return Object.hasOwn(LEGACY_SUB_PAGES, segments[0])
    ? LEGACY_SUB_PAGES[segments[0]]
    : null;
}

/**
 * The inbox someone lands on with no chat named: Recruiter HR for an
 * admin or a recruiter, HR department for someone with only a dept
 * role, Not sorted otherwise (roles unknown).
 */
export function defaultHrInbox(roles: HrRoles | null): HrInboxRoute {
  if (roles?.admin || roles?.recruiter) return 'recruiter';
  if (roles?.dept) return 'dept';
  return 'unsorted';
}

/**
 * Where an old `/hr-inbox?…` URL goes. With `?c=<id>` the chat's own
 * inbox decides (`chatInbox`: its `hr_conversations.inbox`, null when
 * it has no HR row, which is Not sorted); without one, the old `hrTab`
 * if it named an inbox, else {@link defaultHrInbox}. Every other key
 * is kept; `hrTab` is dropped, since the route now names the inbox.
 */
export function legacyHrInboxTarget(
  search: string,
  chatInbox: HrInbox | null,
  roles: HrRoles | null
): string {
  const params = new URLSearchParams(search);
  const tab = params.get('hrTab');
  params.delete('hrTab');
  let inbox: HrInboxRoute;
  if (params.get('c')) inbox = chatInbox ?? 'unsorted';
  else if (tab === 'recruiter' || tab === 'dept' || tab === 'unsorted')
    inbox = tab;
  else inbox = defaultHrInbox(roles);
  const q = params.toString();
  return q ? `${HR_INBOX_PATHS[inbox]}?${q}` : HR_INBOX_PATHS[inbox];
}
