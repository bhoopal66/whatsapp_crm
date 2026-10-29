import { isUuid } from '@/lib/chat/mentions';

import { UNASSIGNED, type AssigneeFilter } from './conversations';
import { parseInsightFilters, type InsightFilter } from './insights';

/**
 * The Inbox's deep-link filters, as team chat's WHATSAPP INBOX rows link
 * them: `?assignee=unassigned|me|<user id>` and `?tag=<chat tag id>`,
 * plus `?filter=unread` (the Unread filter), `?insight=hot,upset,attention` (the Smart insights filters, which
 * the list applies only while the workspace has signals on).
 * They only seed the list's own filter state on mount, so the controls
 * show them and clear them as usual; anything unrecognised is ignored.
 */
export function parseInboxFilterParams(
  params: { get(key: string): string | null },
  userId: string | null
): {
  assignee: AssigneeFilter;
  chatTagIds: string[];
  insightFilters: InsightFilter[];
  unread: boolean;
} {
  const a = params.get('assignee');
  const assignee: AssigneeFilter =
    a === UNASSIGNED
      ? UNASSIGNED
      : a === 'me'
        ? userId
        : isUuid(a)
          ? a.toLowerCase()
          : null;
  const tag = params.get('tag');
  return {
    assignee,
    chatTagIds: isUuid(tag) ? [tag.toLowerCase()] : [],
    insightFilters: parseInsightFilters(params.get('insight')),
    unread: params.get('filter') === 'unread',
  };
}
