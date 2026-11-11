/**
 * Department inboxes (migration 192): a chat owned by or assigned to a
 * person in a department other than sales carries that department in
 * `conversations.inbox_department` (kept by the database). The main
 * Inbox and Team inbox leave those chats out, except the viewer's own
 * (owner or assignee), so a department member works their chats as
 * usual; owners and admins read each department's chats in its own
 * inbox (/hr-inbox).
 */

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
  { department: InboxDepartment } | { mainFor: string | null };

/** Is this chat in the main inbox for `userId`? */
export function inMainInbox(
  row: DepartmentChatRow,
  userId: string | null
): boolean {
  if (!row.inbox_department) return true;
  if (!userId) return false;
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
    : inMainInbox(row, view.mainFor);
}

/**
 * The list query's `or` group for the main inboxes:
 * {@link inMainInbox} as a PostgREST filter.
 */
export function mainInboxGroup(userId: string): string {
  return `inbox_department.is.null,user_id.eq.${userId},assigned_agent_id.eq.${userId}`;
}
