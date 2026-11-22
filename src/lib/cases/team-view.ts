/**
 * "My team" on the Cases inbox (Track B item 10). Pure.
 *
 * A team leader picks "My team" in the agent filter and sees the cases
 * whose agent is one of the people in the teams they lead, or themselves
 * (`useLedTeam`). It is a filter over what `case_inbox` already returns
 * to them (162 lists a leader their team agents' cases): no SQL change,
 * no new visibility. `case_inbox` takes one agent, so the screen asks
 * once per person (`teamInboxUrls`, one full page each) and merges the
 * pages here.
 *
 * The merge restates 125/162's order (k1, k2, k3, case id) from the
 * columns the page has. k2's "minutes the worst running SLA timer is
 * past due" is read from the case's own due time (`dueAt`) while its SLA
 * is overdue; when several timers run, two cases can swap places
 * against the single-agent list. Within one person's page the server's
 * order is kept as is.
 */
import {
  inboxUrl,
  type InboxFilters,
  type InboxPage,
  type InboxRow,
  type InboxSort,
} from './ui';

/** The URL parameter that turns "My team" on (`?team=1`). */
export const CASES_TEAM_PARAM = 'team';

/** 125 caps a page at 200 (INBOX_MAX_LIMIT in lib/cases/inbox.ts). */
export const TEAM_PAGE_LIMIT = 200;

/** One GET /api/cases per person, the other filters kept. */
export function teamInboxUrls(
  filters: InboxFilters,
  agentIds: readonly string[]
): string[] {
  return [...new Set(agentIds)].map((agent) =>
    inboxUrl({ ...filters, agent }, null, TEAM_PAGE_LIMIT)
  );
}

const INF = Number.POSITIVE_INFINITY;

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

type Key = [number, number, number, number, string];

function keyOf(r: InboxRow, sort: InboxSort, now: number): Key {
  const due = ms(r.dueAt);
  const k1 =
    sort === 'due_soonest'
      ? (due ?? INF)
      : sort === 'stalest'
        ? (ms(r.lastActivityAt) ?? INF)
        : -INF;
  const slaOverdueMinutes =
    r.slaState === 'overdue' && due !== null
      ? Math.max(0, Math.floor((now - due) / 60_000))
      : 0;
  const k3 = sort === 'due_soonest' ? -INF : (due ?? INF);
  return [k1, -slaOverdueMinutes, -r.openTaskOverdueCount, k3, r.caseId];
}

function compare(a: Key, b: Key): number {
  for (let i = 0; i < 4; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0;
}

export interface TeamInbox {
  rows: InboxRow[];
  /** Some person has more cases than one page holds. */
  truncated: boolean;
}

/** The people's pages as one list: one row per case, in the inbox order. */
export function mergeTeamPages(
  pages: readonly InboxPage[],
  sort: InboxSort,
  now: Date
): TeamInbox {
  const at = now.getTime();
  const seen = new Set<string>();
  const rows: InboxRow[] = [];
  for (const page of pages)
    for (const r of page.rows) {
      if (seen.has(r.caseId)) continue;
      seen.add(r.caseId);
      rows.push(r);
    }
  const keys = new Map(rows.map((r) => [r.caseId, keyOf(r, sort, at)]));
  rows.sort((a, b) => compare(keys.get(a.caseId)!, keys.get(b.caseId)!));
  return { rows, truncated: pages.some((p) => p.nextCursor !== null) };
}
