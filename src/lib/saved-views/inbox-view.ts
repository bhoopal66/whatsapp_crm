import { INSIGHT_FILTERS, type InsightFilter } from '@/lib/inbox/insights';

/**
 * What a saved Inbox view holds. Free-text search is not part of a
 * view (it is a moment, not a lens). `assignee` is a user id, the
 * string 'unassigned', or null for everyone.
 */
export interface InboxViewFilters {
  unread: boolean;
  important: boolean;
  pinned: boolean;
  assignee: string | null;
  campaignId: string | null;
  chatTagIds: string[];
  insights: InsightFilter[];
  company: string | null;
}

export const EMPTY_INBOX_VIEW: InboxViewFilters = {
  unread: false,
  important: false,
  pinned: false,
  assignee: null,
  campaignId: null,
  chatTagIds: [],
  insights: [],
  company: null,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

/** Defensive read: unknown keys and malformed values fall back to "off". */
export function parseInboxView(raw: unknown): InboxViewFilters {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const assignee = str(o.assignee, 64);
  const ids = Array.isArray(o.chatTagIds) ? o.chatTagIds : [];
  const insights = Array.isArray(o.insights) ? o.insights : [];
  const campaignId = str(o.campaignId, 64);
  return {
    unread: o.unread === true,
    important: o.important === true,
    pinned: o.pinned === true,
    assignee:
      assignee && (assignee === 'unassigned' || UUID.test(assignee))
        ? assignee
        : null,
    campaignId: campaignId && UUID.test(campaignId) ? campaignId : null,
    chatTagIds: ids
      .filter((x): x is string => typeof x === 'string' && UUID.test(x))
      .slice(0, 50),
    insights: INSIGHT_FILTERS.filter((f) => insights.includes(f)),
    company: str(o.company, 200),
  };
}

export function isEmptyInboxView(f: InboxViewFilters): boolean {
  return (
    !f.unread &&
    !f.important &&
    !f.pinned &&
    f.assignee === null &&
    f.campaignId === null &&
    f.chatTagIds.length === 0 &&
    f.insights.length === 0 &&
    f.company === null
  );
}
