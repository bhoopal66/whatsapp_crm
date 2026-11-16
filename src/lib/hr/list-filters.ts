/**
 * The HR inbox's tabs and filters (`/hr-inbox`, migration 200): URL
 * state, the PostgREST mapping and the client-side re-check for rows a
 * realtime patch changed. Pure, so it is tested without a database; the
 * embed's real behaviour is owed a check against 200.
 *
 * The list embeds `hr_conversations` one-to-one (its PK is the FK to
 * `conversations`). A filter on an embedded column only narrows the
 * parent rows when the embed is `!inner`, so the mapping goes inner
 * whenever a filter needs an HR row. Closed rows are hidden by default;
 * in the All tab (which also lists chats with no HR row) that needs a
 * second, filtered embed: a chat is hidden when `hr_closed` is present.
 */
import {
  HR_REPLY_STATES,
  HR_STAGES,
  HR_TOPIC_FILTERS,
  HR_TOPICS,
  type HrConversation,
  type HrCounts,
  type HrReplyState,
  type HrStage,
  type HrTopic,
  type HrTopicFilter,
} from './types';

export const HR_TABS = ['all', 'recruiter', 'dept', 'unsorted'] as const;
export type HrTab = (typeof HR_TABS)[number];

export interface HrListFilters {
  tab: HrTab;
  /** Recruitment tab only. */
  stage: HrStage | null;
  /** HR department tab only. */
  topic: HrTopic | null;
  /** HR department tab only: a chip of topics (migration 201). */
  topicGroup: HrTopicFilter | null;
  reply: HrReplyState | null;
  urgent: boolean;
  mine: boolean;
  /** Show closed HR rows too. */
  closed: boolean;
}

export const HR_LIST_DEFAULTS: HrListFilters = {
  tab: 'all',
  stage: null,
  topic: null,
  topicGroup: null,
  reply: null,
  urgent: false,
  mine: false,
  closed: false,
};

/** The columns the HR rows carry. */
export type HrListRow = Pick<
  HrConversation,
  | 'inbox'
  | 'stage_key'
  | 'topic'
  | 'urgent'
  | 'upset'
  | 'reply_state'
  | 'outcome'
  | 'closed_at'
>;

export const HR_EMBED =
  'hr:hr_conversations(inbox,stage_key,topic,urgent,upset,reply_state,outcome,closed_at)';

/** URL keys, prefixed so they never collide with the inbox's own. */
const K = {
  tab: 'hrTab',
  stage: 'hrStage',
  topic: 'hrTopic',
  topicGroup: 'hrTopicGroup',
  reply: 'hrReply',
  urgent: 'hrUrgent',
  mine: 'hrMine',
  closed: 'hrClosed',
} as const;

const oneOf = <T extends string>(
  list: readonly T[],
  v: string | null
): T | null =>
  v !== null && (list as readonly string[]).includes(v) ? (v as T) : null;

type Params = Pick<URLSearchParams, 'get'>;

/**
 * Unknown values fall back to the defaults; a stage outside Recruitment is
 * dropped. A `fixedTab` (the route's own inbox, /hr/recruiter …) wins over
 * the URL's `hrTab`.
 */
export function parseHrListParams(
  params: Params,
  fixedTab?: HrTab
): HrListFilters {
  const tab = fixedTab ?? oneOf(HR_TABS, params.get(K.tab)) ?? 'all';
  return {
    tab,
    stage: tab === 'recruiter' ? oneOf(HR_STAGES, params.get(K.stage)) : null,
    topic: tab === 'dept' ? oneOf(HR_TOPICS, params.get(K.topic)) : null,
    topicGroup:
      tab === 'dept'
        ? oneOf(
            Object.keys(HR_TOPIC_FILTERS) as HrTopicFilter[],
            params.get(K.topicGroup)
          )
        : null,
    reply:
      tab === 'unsorted' ? null : oneOf(HR_REPLY_STATES, params.get(K.reply)),
    urgent: tab !== 'unsorted' && params.get(K.urgent) === '1',
    mine: params.get(K.mine) === '1',
    closed: params.get(K.closed) === '1',
  };
}

/**
 * Writes the filters into a copy of `params`, leaving every other key.
 * With `fixedTab` the route names the tab, so `hrTab` is not written.
 */
export function writeHrListParams(
  params: URLSearchParams,
  f: HrListFilters,
  fixedTab?: HrTab
): URLSearchParams {
  const out = new URLSearchParams(params);
  const set = (key: string, v: string | null) =>
    v === null ? out.delete(key) : out.set(key, v);
  set(K.tab, fixedTab || f.tab === 'all' ? null : f.tab);
  set(K.stage, f.stage);
  set(K.topic, f.topic);
  set(K.topicGroup, f.topicGroup);
  set(K.reply, f.reply);
  set(K.urgent, f.urgent ? '1' : null);
  set(K.mine, f.mine ? '1' : null);
  set(K.closed, f.closed ? '1' : null);
  return out;
}

/** Whether the list needs an HR row on every chat (an `!inner` embed). */
function needsRow(f: HrListFilters): boolean {
  return (
    f.tab === 'recruiter' || f.tab === 'dept' || f.reply !== null || f.urgent
  );
}

/** The embeds to append to the list's select in the HR view. */
export function hrSelectEmbeds(f: HrListFilters): string {
  if (f.tab === 'unsorted') return HR_EMBED;
  if (needsRow(f))
    return HR_EMBED.replace('hr_conversations(', 'hr_conversations!inner(');
  return f.closed
    ? HR_EMBED
    : `${HR_EMBED},hr_closed:hr_conversations(conversation_id)`;
}

export type HrQueryOp =
  | { op: 'eq'; column: string; value: string | boolean }
  | { op: 'in'; column: string; values: string[] }
  | { op: 'is'; column: string; value: null }
  | { op: 'not_is'; column: string; value: null }
  | { op: 'or'; filter: string };

/** The server-side filters, in the order to apply them. */
export function hrQueryOps(
  f: HrListFilters,
  viewerId: string | null
): HrQueryOp[] {
  const ops: HrQueryOp[] = [];
  if (f.tab === 'unsorted') {
    ops.push({ op: 'is', column: 'hr', value: null });
  } else {
    if (f.tab !== 'all')
      ops.push({ op: 'eq', column: 'hr.inbox', value: f.tab });
    if (f.stage) ops.push({ op: 'eq', column: 'hr.stage_key', value: f.stage });
    if (f.topic) ops.push({ op: 'eq', column: 'hr.topic', value: f.topic });
    if (f.topicGroup)
      ops.push({
        op: 'in',
        column: 'hr.topic',
        values: [...HR_TOPIC_FILTERS[f.topicGroup]],
      });
    if (f.reply)
      ops.push({ op: 'eq', column: 'hr.reply_state', value: f.reply });
    if (f.urgent) ops.push({ op: 'eq', column: 'hr.urgent', value: true });
    if (!f.closed) {
      if (needsRow(f))
        ops.push({ op: 'is', column: 'hr.closed_at', value: null });
      else {
        ops.push({ op: 'not_is', column: 'hr_closed.closed_at', value: null });
        ops.push({ op: 'is', column: 'hr_closed', value: null });
      }
    }
  }
  if (f.mine && viewerId) {
    ops.push({
      op: 'or',
      filter: `assigned_agent_id.eq.${viewerId},and(assigned_agent_id.is.null,user_id.eq.${viewerId})`,
    });
  }
  return ops;
}

/** The same rules on a row in memory, for realtime-patched rows. */
export function matchesHrFilters(
  row: {
    hr?: HrListRow | null;
    assigned_agent_id?: string | null;
    user_id?: string | null;
  },
  f: HrListFilters,
  viewerId: string | null
): boolean {
  const hr = row.hr ?? null;
  if (f.mine && viewerId) {
    const mine =
      row.assigned_agent_id === viewerId ||
      (!row.assigned_agent_id && row.user_id === viewerId);
    if (!mine) return false;
  }
  if (f.tab === 'unsorted') return hr === null;
  if (hr === null) return !needsRow(f);
  if (f.tab !== 'all' && hr.inbox !== f.tab) return false;
  if (f.stage && hr.stage_key !== f.stage) return false;
  if (f.topic && hr.topic !== f.topic) return false;
  if (
    f.topicGroup &&
    !(HR_TOPIC_FILTERS[f.topicGroup] as readonly (string | null)[]).includes(
      hr.topic
    )
  )
    return false;
  if (f.reply && hr.reply_state !== f.reply) return false;
  if (f.urgent && !hr.urgent) return false;
  if (!f.closed && hr.closed_at !== null) return false;
  return true;
}

/**
 * What a realtime hr_conversations change does to the list. `hr` null is
 * a DELETE, which Realtime delivers from every workspace (it neither
 * filters nor RLS-checks DELETE), so a delete of a chat the list does
 * not hold is ignored.
 */
export function hrChangeAction(
  held: boolean,
  hr: HrListRow | null,
  f: HrListFilters,
  viewerId: string | null
): 'patch' | 'reload' | 'ignore' {
  if (held) return 'patch';
  if (hr === null) return 'ignore';
  // Owner unknown here, so "mine" is not asked.
  return matchesHrFilters({ hr }, { ...f, mine: false }, viewerId)
    ? 'reload'
    : 'ignore';
}

/** The PostgREST builder methods the HR ops use. */
export interface HrFilterableQuery<Q> {
  eq(column: string, value: string | boolean): Q;
  in(column: string, values: string[]): Q;
  is(column: string, value: null): Q;
  not(column: string, operator: string, value: null): Q;
}

/**
 * Applies the column ops to a PostgREST query. The `or` ops come back as
 * groups instead of `.or()` calls, so the caller folds them into its
 * single `or=` parameter (combineOrGroups in lib/inbox/pagination.ts).
 */
export function applyHrQueryOps<Q extends HrFilterableQuery<Q>>(
  query: Q,
  ops: readonly HrQueryOp[]
): { query: Q; orGroups: string[] } {
  let q = query;
  const orGroups: string[] = [];
  for (const op of ops) {
    if (op.op === 'eq') q = q.eq(op.column, op.value);
    else if (op.op === 'in') q = q.in(op.column, op.values);
    else if (op.op === 'is') q = q.is(op.column, null);
    else if (op.op === 'not_is') q = q.not(op.column, 'is', null);
    else orGroups.push(op.filter);
  }
  return { query: q, orGroups };
}

/**
 * The filter bar's tab numbers from `hr_counts()`: All is both inboxes
 * plus the chats not sorted into one yet.
 */
export function hrTabCounts(c: HrCounts): Record<HrTab, number> {
  return {
    all: c.recruiter.all + c.dept.all + c.unsorted,
    recruiter: c.recruiter.all,
    dept: c.dept.all,
    unsorted: c.unsorted,
  };
}

/**
 * Moving to `tab` clears the stage, topic and topic chip (each belongs to one
 * tab), and on Not sorted the reply state and Urgent too, which need an
 * HR row; the result is what {@link parseHrListParams} would read back.
 */
export function switchHrTab(f: HrListFilters, tab: HrTab): HrListFilters {
  const unsorted = tab === 'unsorted';
  return {
    ...f,
    tab,
    stage: null,
    topic: null,
    topicGroup: null,
    reply: unsorted ? null : f.reply,
    urgent: unsorted ? false : f.urgent,
  };
}

/**
 * The inbox's URL for opening (`c`) or closing (null) a chat in the HR
 * view: `basePath` with the HR filter keys of `search` kept and every
 * other key dropped, as the other views drop them. `fixedTab`: the route
 * is one inbox (/hr/recruiter …), so `hrTab` is ignored and not written.
 */
export function hrInboxUrl(
  basePath: string,
  search: string,
  c: string | null,
  fixedTab?: HrTab
): string {
  const out = writeHrListParams(
    new URLSearchParams(),
    parseHrListParams(new URLSearchParams(search), fixedTab),
    fixedTab
  );
  if (c) out.set('c', c);
  const q = out.toString();
  return q ? `${basePath}?${q}` : basePath;
}

/**
 * The list header's quick filters (package 023d-1): All / Unread / Mine /
 * Urgent, one at a time. Unread means a reply is due (`reply_state =
 * 'reply_due'`, as `hr_counts().unread` counts it), so it is the reply
 * filter's `reply_due` value, not a separate flag. Not sorted has no HR
 * row, so only All and Mine apply there.
 */
export const HR_QUICK_FILTERS = ['all', 'unread', 'mine', 'urgent'] as const;
export type HrQuickFilter = (typeof HR_QUICK_FILTERS)[number];

/** The quick filters the tab offers. */
export function hrQuickFilters(tab: HrTab): readonly HrQuickFilter[] {
  return tab === 'unsorted' ? ['all', 'mine'] : HR_QUICK_FILTERS;
}

/** Which quick filter is lit; the first that holds wins. */
export function activeHrQuick(f: HrListFilters): HrQuickFilter {
  if (f.urgent) return 'urgent';
  if (f.mine) return 'mine';
  if (f.reply === 'reply_due') return 'unread';
  return 'all';
}

/**
 * Picks quick filter `q`: it owns Urgent, Mine and the reply state
 * `reply_due`, so it sets its own and clears the others (All clears all
 * three); another reply state from the dropdown stays unless Unread
 * replaces it. Stage, topic and Closed are left alone.
 */
export function applyHrQuick(
  f: HrListFilters,
  q: HrQuickFilter
): HrListFilters {
  const unsorted = f.tab === 'unsorted';
  return {
    ...f,
    urgent: q === 'urgent' && !unsorted,
    mine: q === 'mine',
    reply: unsorted
      ? null
      : q === 'unread'
        ? 'reply_due'
        : f.reply === 'reply_due'
          ? null
          : f.reply,
  };
}

/**
 * The quick filters' numbers from `hr_counts()`, by tab; a filter with
 * no figure (Mine on Not sorted, or no answer yet) is missing.
 */
export function hrQuickCounts(
  c: HrCounts | null,
  tab: HrTab
): Partial<Record<HrQuickFilter, number>> {
  if (!c) return {};
  if (tab === 'unsorted') return { all: c.unsorted };
  if (tab === 'all')
    return {
      all: c.recruiter.all + c.dept.all + c.unsorted,
      unread: c.recruiter.unread + c.dept.unread,
      urgent: c.recruiter.urgent + c.dept.urgent,
    };
  return { ...c[tab] };
}

/** One removable chip under the header, for a filter that is on. */
export type HrActiveChip =
  | { key: 'stage'; value: HrStage }
  | { key: 'topic'; value: HrTopic }
  | { key: 'topicGroup'; value: HrTopicFilter }
  | { key: 'reply'; value: HrReplyState }
  | { key: 'urgent' }
  | { key: 'mine' }
  | { key: 'closed' };

/** The filters that are on, in the header's order. */
export function hrActiveChips(f: HrListFilters): HrActiveChip[] {
  const out: HrActiveChip[] = [];
  if (f.mine) out.push({ key: 'mine' });
  if (f.urgent) out.push({ key: 'urgent' });
  if (f.topicGroup) out.push({ key: 'topicGroup', value: f.topicGroup });
  if (f.stage) out.push({ key: 'stage', value: f.stage });
  if (f.topic) out.push({ key: 'topic', value: f.topic });
  if (f.reply) out.push({ key: 'reply', value: f.reply });
  if (f.closed) out.push({ key: 'closed' });
  return out;
}

/** Turns off the one filter a chip's × names. */
export function clearHrChip(
  f: HrListFilters,
  key: HrActiveChip['key']
): HrListFilters {
  switch (key) {
    case 'urgent':
    case 'mine':
    case 'closed':
      return { ...f, [key]: false };
    default:
      return { ...f, [key]: null };
  }
}
