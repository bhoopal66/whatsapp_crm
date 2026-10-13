/**
 * Settings → Audit log: one newest-first list over the five append-only
 * audit tables of migrations 087-089 and 092. Each table's SELECT policy opens
 * it to owners and admins of the active account, so GET /api/audit reads
 * them with the caller's own client; these helpers shape the rows, parse
 * the filters and merge the pages, and hold no I/O.
 */

export const AUDIT_SOURCES = [
  'workspace',
  'team_chat',
  'recordings',
  'phone',
  'deal_rooms',
] as const;
export type AuditSource = (typeof AUDIT_SOURCES)[number];

export const AUDIT_PAGE_SIZE = 50;
/** Deepest page served: each source then returns at most 1,001 rows. */
export const AUDIT_MAX_PAGE = 20;

interface SourceSpec {
  table: string;
  /** The column that names the person who acted. */
  actor: string;
  columns: string;
}

export const AUDIT_TABLES: Record<AuditSource, SourceSpec> = {
  // 092: membership and workspace changes, written by triggers. A NULL
  // actor is the server (provisioning, the service role).
  workspace: {
    table: 'workspace_audit',
    actor: 'actor_id',
    columns: 'id, actor_id, action, target_user_id, detail, at',
  },
  // 087: private reads with a reason, erasures, member changes.
  team_chat: {
    table: 'chat_audit_log',
    actor: 'actor_id',
    columns: 'id, actor_id, action, channel_id, at, detail',
  },
  // 089: a recording played, downloaded or attached.
  recordings: {
    table: 'call_access_log',
    actor: 'user_id',
    columns: 'id, call_id, user_id, action, at',
  },
  // 089: do-not-contact overrides and call erasures.
  phone: {
    table: 'pbx_audit',
    actor: 'actor_id',
    columns: 'id, actor_id, action, contact_id, call_ids, reason, detail, at',
  },
  // 088: creation, invites, approvals, removals, closures.
  deal_rooms: {
    table: 'deal_room_audit',
    actor: 'actor_id',
    columns: 'id, room_id, actor_id, action, at, detail',
  },
};

export type AuditItemKind =
  'channel' | 'person' | 'call' | 'contact' | 'deal_room';

/** A countable or textual fact, translated by its key in the panel. */
export type AuditFact =
  | {
      key: 'messages' | 'files' | 'recordings' | 'calls' | 'members';
      count: number;
    }
  | { key: 'change'; from: string; to: string }
  | { key: 'rename'; from: string; to: string }
  /** A channel topic; null is none. */
  | { key: 'topic'; from: string | null; to: string | null }
  | { key: 'number'; value: string }
  /** A role id; `from` is set on a change of role. */
  | { key: 'role'; from: string | null; to: string }
  | { key: 'bank'; value: string };

export interface AuditRow {
  /** `<source>:<id>`, unique across the sources. */
  key: string;
  source: AuditSource;
  at: string;
  /** Null when the server acted (a webhook, a cron). */
  actorId: string | null;
  action: string;
  item: { kind: AuditItemKind; id: string } | null;
  /** The reason the person gave, where the source records one. */
  reason: string | null;
  facts: AuditFact[];
  /**
   * The person item's name as the row recorded it (092's detail.name):
   * someone removed from the workspace has no profile here to name
   * them by.
   */
  recordedName?: string;
}

export interface NamedAuditRow extends AuditRow {
  actorName: string | null;
  itemLabel: string | null;
}

type Raw = Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
const uuid = (v: unknown): string | null =>
  typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null;
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
const detailOf = (r: Raw): Raw =>
  r.detail && typeof r.detail === 'object' && !Array.isArray(r.detail)
    ? (r.detail as Raw)
    : {};

function countFact(
  key: 'messages' | 'files' | 'recordings' | 'calls' | 'members',
  v: unknown
): AuditFact[] {
  const n = count(v);
  return n === null ? [] : [{ key, count: n }];
}

function changeFact(from: unknown, to: unknown): AuditFact[] {
  const a = str(from);
  const b = str(to);
  return a && b ? [{ key: 'change', from: a, to: b }] : [];
}

/** A change where one side may be unset (a first bank code, a short
 *  name never set): the missing side reads as a dash. */
function changeFactFromNone(from: unknown, to: unknown): AuditFact[] {
  const a = str(from);
  const b = str(to);
  return a || b ? [{ key: 'change', from: a ?? '—', to: b ?? '—' }] : [];
}

function workspaceFacts(action: string, d: Raw): AuditFact[] {
  switch (action) {
    case 'member_added':
    case 'member_removed': {
      const role = str(d.role);
      const bank = str(d.bank_code);
      return [
        ...(role ? [{ key: 'role' as const, from: null, to: role }] : []),
        ...(bank ? [{ key: 'bank' as const, value: bank }] : []),
      ];
    }
    case 'role_changed': {
      const to = str(d.to);
      return to ? [{ key: 'role', from: str(d.from), to }] : [];
    }
    case 'bank_changed':
    case 'workspace_renamed':
    case 'short_name_changed':
      return changeFactFromNone(d.from, d.to);
    default:
      return [];
  }
}

function item(kind: AuditItemKind, id: unknown): AuditRow['item'] {
  const v = uuid(id);
  return v ? { kind, id: v } : null;
}

/** One raw row of `source`'s table as an audit row; null if unusable. */
export function shapeAuditRow(source: AuditSource, r: Raw): AuditRow | null {
  const id = r.id === null || r.id === undefined ? null : String(r.id);
  const at = str(r.at);
  const action = str(r.action);
  if (!id || !at || !action) return null;
  const d = detailOf(r);
  const base = {
    key: `${source}:${id}`,
    source,
    at,
    action,
    actorId: uuid(r[AUDIT_TABLES[source].actor]),
  };
  switch (source) {
    case 'workspace': {
      const name = str(d.name);
      return {
        ...base,
        // The member acted on; null for a workspace-level change.
        item: item('person', r.target_user_id),
        reason: null,
        facts: workspaceFacts(action, d),
        ...(name ? { recordedName: name } : {}),
      };
    }
    case 'team_chat': {
      if (action === 'erase_person') {
        return {
          ...base,
          item: item('person', d.user_id),
          reason: str(d.reason),
          facts: [
            ...countFact('messages', d.messages),
            ...countFact('files', d.attachments),
          ],
        };
      }
      if (action === 'set_member_role') {
        return {
          ...base,
          item: item('person', d.user_id),
          reason: null,
          facts: changeFact(d.from, d.to),
        };
      }
      // 091: the old and new name and topic (a null topic is none),
      // each shown only where it changed.
      if (action === 'update_channel') {
        const facts: AuditFact[] = [];
        const from = str(d.from);
        const to = str(d.to);
        if (from && to && from !== to) facts.push({ key: 'rename', from, to });
        const topicFrom = str(d.topic_from);
        const topicTo = str(d.topic_to);
        if (topicFrom !== topicTo)
          facts.push({ key: 'topic', from: topicFrom, to: topicTo });
        return {
          ...base,
          item: item('channel', r.channel_id),
          reason: null,
          facts,
        };
      }
      // 091: one person per row, shown like add_members (the channel
      // and how many people) rather than as the person.
      if (action === 'remove_member') {
        return {
          ...base,
          item: item('channel', r.channel_id),
          reason: null,
          facts: uuid(d.user_id) ? countFact('members', 1) : [],
        };
      }
      return {
        ...base,
        item: item('channel', r.channel_id),
        reason: str(d.reason),
        facts: Array.isArray(d.user_ids)
          ? countFact('members', d.user_ids.length)
          : [],
      };
    }
    case 'recordings':
      return {
        ...base,
        item: item('call', r.call_id),
        reason: null,
        facts: [],
      };
    case 'phone': {
      const number = str(d.number);
      return {
        ...base,
        item: item('contact', r.contact_id),
        reason: str(r.reason),
        facts: [
          ...countFact('recordings', d.recordings),
          ...(Array.isArray(r.call_ids) && r.call_ids.length > 0
            ? countFact('calls', r.call_ids.length)
            : []),
          ...(number ? [{ key: 'number' as const, value: number }] : []),
        ],
      };
    }
    case 'deal_rooms':
      return {
        ...base,
        item: item('deal_room', r.room_id),
        reason: str(d.reason),
        facts: [
          ...changeFact(d.from, d.to),
          ...(Array.isArray(d.user_ids)
            ? countFact('members', d.user_ids.length)
            : []),
        ],
      };
  }
}

export function shapeAuditRows(source: AuditSource, rows: Raw[]): AuditRow[] {
  return rows.flatMap((r) => shapeAuditRow(source, r) ?? []);
}

/** Newest first; equal times in a stable order (source, then id). */
export function newestFirst(a: AuditRow, b: AuditRow): number {
  const diff = Date.parse(b.at) - Date.parse(a.at);
  if (diff !== 0 && !Number.isNaN(diff)) return diff;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Rows each source must return for `page` to be exact. A page of the
 * merged list draws only on each source's newest `page × size` rows;
 * one more says whether anything follows.
 */
export function perSourceLimit(page: number, size = AUDIT_PAGE_SIZE): number {
  return page * size + 1;
}

/** Page `page` (1-based) of the merged lists, newest first. */
export function mergeAuditPage(
  lists: AuditRow[][],
  page: number,
  size = AUDIT_PAGE_SIZE
): { rows: AuditRow[]; hasMore: boolean } {
  const all = lists.flat().sort(newestFirst);
  const start = (page - 1) * size;
  return {
    rows: all.slice(start, start + size),
    hasMore: all.length > start + size,
  };
}

export interface AuditQuery {
  sources: AuditSource[];
  /** Inclusive lower bound, ISO. */
  from: string | null;
  /** Exclusive upper bound, ISO. */
  to: string | null;
  actorId: string | null;
  page: number;
}

function instant(raw: string | null): string | null | undefined {
  if (raw === null || raw.trim() === '') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** GET /api/audit's query string; a string is the 400 to answer. */
export function parseAuditQuery(params: {
  get(name: string): string | null;
}): AuditQuery | string {
  const source = params.get('source');
  let sources: AuditSource[] = [...AUDIT_SOURCES];
  if (source !== null && source !== '' && source !== 'all') {
    if (!(AUDIT_SOURCES as readonly string[]).includes(source))
      return `source must be one of ${AUDIT_SOURCES.join(', ')}`;
    sources = [source as AuditSource];
  }
  const from = instant(params.get('from'));
  const to = instant(params.get('to'));
  if (from === undefined || to === undefined)
    return 'from and to must be dates';
  if (from && to && from >= to) return 'from must be before to';
  const actor = params.get('actor');
  const actorId = actor ? uuid(actor) : null;
  if (actor && !actorId) return 'actor must be a user id';
  const rawPage = params.get('page');
  const page = rawPage ? Number(rawPage) : 1;
  if (!Number.isInteger(page) || page < 1 || page > AUDIT_MAX_PAGE)
    return `page must be 1 to ${AUDIT_MAX_PAGE}`;
  return { sources, from, to, actorId, page };
}

/** The ids each lookup table must resolve for these rows. */
export function idsToName(rows: AuditRow[]): {
  people: string[];
  byKind: Record<AuditItemKind, string[]>;
} {
  const people = new Set<string>();
  const byKind: Record<AuditItemKind, Set<string>> = {
    channel: new Set(),
    person: new Set(),
    call: new Set(),
    contact: new Set(),
    deal_room: new Set(),
  };
  for (const r of rows) {
    if (r.actorId) people.add(r.actorId);
    if (r.item) byKind[r.item.kind].add(r.item.id);
  }
  for (const p of byKind.person) people.add(p);
  return {
    people: [...people],
    byKind: Object.fromEntries(
      Object.entries(byKind).map(([k, v]) => [k, [...v]])
    ) as Record<AuditItemKind, string[]>,
  };
}

/**
 * Attach the people's and items' names; a missing one stays null.
 * `people` holds the profiles of this workspace, so a person with none
 * (removed since) falls back to the name the row recorded, also when
 * they are the actor (someone who left of their own accord).
 */
export function nameAuditRows(
  rows: AuditRow[],
  people: ReadonlyMap<string, string>,
  items: ReadonlyMap<string, string>
): NamedAuditRow[] {
  return rows.map((r) => {
    const target = r.item?.kind === 'person' ? r.item.id : null;
    const personName = (id: string): string | null =>
      people.get(id) ?? (id === target ? r.recordedName?.trim() || null : null);
    return {
      ...r,
      actorName: r.actorId ? personName(r.actorId) : null,
      itemLabel: r.item
        ? r.item.kind === 'person'
          ? personName(r.item.id)
          : (items.get(`${r.item.kind}:${r.item.id}`) ?? null)
        : null,
    };
  });
}
