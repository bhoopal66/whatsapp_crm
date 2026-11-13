/**
 * Department inboxes (migration 192): a chat owned by or assigned to a
 * person in a department other than sales carries that department in
 * `conversations.inbox_department` (kept by the database). The main
 * Inbox and Team inbox leave those chats out, except the viewer's own
 * (owner or assignee) and, below admin, those of the viewer's own
 * department: an HR team leader's Team inbox lists her HR team's chats
 * (RLS still decides which rows she gets). Owners and admins read each
 * department's chats in its own inbox (/hr-inbox).
 */

import { hasMinRole, type AccountRole } from '@/lib/auth/roles';

/** The departments with an inbox of their own (sales is the main one). */
export const INBOX_DEPARTMENTS = ['hr', 'it', 'accounts'] as const;
export type InboxDepartment = (typeof INBOX_DEPARTMENTS)[number];

/** What the department rules read of a conversation row. */
export type DepartmentChatRow = {
  inbox_department?: string | null;
  user_id?: string | null;
  assigned_agent_id?: string | null;
};

/**
 * Which slice a list shows: one department's chats, or the main inbox
 * as `mainFor` sees it (their own department chats included). A null
 * viewer fails closed: no department chat counts as theirs.
 */
export type DepartmentView =
  | { department: InboxDepartment }
  | { mainFor: string | null; ownDepartment?: InboxDepartment | null };

function isInboxDepartment(value: unknown): value is InboxDepartment {
  return (
    typeof value === 'string' &&
    (INBOX_DEPARTMENTS as readonly string[]).includes(value)
  );
}

/**
 * The department whose chats stay in this viewer's main inboxes: their
 * own, below admin (owners and admins have the department inbox
 * instead). Null for sales, an unknown value or a missing role.
 */
export function viewerInboxDepartment(
  role: AccountRole | null,
  department: string | null | undefined
): InboxDepartment | null {
  if (!role || hasMinRole(role, 'admin')) return null;
  return isInboxDepartment(department) ? department : null;
}

/**
 * Is this chat in the main inbox for `userId`? `ownDepartment` is
 * {@link viewerInboxDepartment}: that department's chats stay in.
 */
export function inMainInbox(
  row: DepartmentChatRow,
  userId: string | null,
  ownDepartment: InboxDepartment | null = null
): boolean {
  if (!row.inbox_department) return true;
  if (!userId) return false;
  if (ownDepartment && row.inbox_department === ownDepartment) return true;
  return row.user_id === userId || row.assigned_agent_id === userId;
}

/** Is this chat in `department`'s inbox? */
export function inDepartmentInbox(
  row: DepartmentChatRow,
  department: InboxDepartment
): boolean {
  return row.inbox_department === department;
}

/** Whether a row belongs in the list `view` describes. */
export function inDepartmentView(
  row: DepartmentChatRow,
  view: DepartmentView
): boolean {
  return 'department' in view
    ? inDepartmentInbox(row, view.department)
    : inMainInbox(row, view.mainFor, view.ownDepartment ?? null);
}

/**
 * The list query's `or` group for the main inboxes:
 * {@link inMainInbox} as a PostgREST filter.
 */
export function mainInboxGroup(
  userId: string,
  ownDepartment: InboxDepartment | null = null
): string {
  const own = ownDepartment ? `,inbox_department.eq.${ownDepartment}` : '';
  return `inbox_department.is.null,user_id.eq.${userId},assigned_agent_id.eq.${userId}${own}`;
}
