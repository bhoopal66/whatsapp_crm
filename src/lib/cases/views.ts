/**
 * Saved inbox views, snooze and the mentions inbox for the coordinator
 * Cases inbox (module 020c part 1, migration 185). Every method is ONE
 * call of a SECURITY DEFINER function on a service-role client; the actor
 * is the signed-in auth user id, and Postgres resolves the role.
 *
 *   views    - the actor's own views plus the shared views of their ACTIVE
 *              workspace (185 reads the active live profile, so no account
 *              is passed). Sharing needs owner/admin. Another person's
 *              private view, or another workspace's, is VIEW_NOT_FOUND.
 *              Filters are the inbox's camelCase keys, mapped through the
 *              inbox's one table (inbox.ts); `sort` is the view's own field,
 *              never a filter.
 *   snooze   - `case_role` ignores the active workspace, so a route checks
 *              the case's account and the caller's read right FIRST
 *              (lib/cases/http.ts loadCaseForCaller); 185 then decides the
 *              role (coordinator, team lead, admin, owner), CASE_CLOSED and
 *              SNOOZE_INVALID (until in (now, now + 30 days]).
 *   mentions - notes of the active workspace mentioning the actor, newest
 *              first, keyset-paged. A cursor carries its clock: the next
 *              page passes the cursor's own `now` text verbatim (185 refuses
 *              a cursor from another clock, and a Date round trip would drop
 *              microseconds).
 *
 * Refusals (an `error.hint` in the list) throw CaseViewsRefusedError; any
 * other database error throws CaseStoreError (function name and SQLSTATE
 * only, never the database text).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  CaseInboxRefusedError,
  inboxFiltersFromSql,
  inboxSqlFilters,
  INBOX_SORTS,
  type CaseInboxFilters,
  type CaseInboxSort,
} from './inbox';
import { CaseStoreError, date, rows, str } from './store';

export type CaseViewsRefusal =
  | 'NOT_ALLOWED'
  | 'NAME_INVALID'
  | 'FILTER_INVALID'
  | 'VIEW_NOT_FOUND'
  | 'CASE_NOT_FOUND'
  | 'CASE_CLOSED'
  | 'SNOOZE_INVALID'
  | 'NOW_REQUIRED'
  | 'LIMIT_INVALID'
  | 'CURSOR_INVALID';
const REFUSALS = new Set<string>([
  'NOT_ALLOWED',
  'NAME_INVALID',
  'FILTER_INVALID',
  'VIEW_NOT_FOUND',
  'CASE_NOT_FOUND',
  'CASE_CLOSED',
  'SNOOZE_INVALID',
  'NOW_REQUIRED',
  'LIMIT_INVALID',
  'CURSOR_INVALID',
]);

export class CaseViewsRefusedError extends Error {
  override readonly name = 'CaseViewsRefusedError';
  constructor(readonly reason: CaseViewsRefusal) {
    super(`case views refused: ${reason}`);
  }
}

/** A saved view's filters: the inbox's, without `sort` (its own column). */
export type CaseViewFilters = Omit<CaseInboxFilters, 'sort'>;

export interface CaseSavedView {
  viewId: string;
  ownerUserId: string;
  name: string;
  filters: CaseViewFilters;
  /** NULL: the inbox default. */
  sort: CaseInboxSort | null;
  shared: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CaseViewInput {
  /** Absent / null creates; else replaces the actor's own view. */
  viewId?: string | null;
  name: unknown;
  filters?: unknown;
  sort?: unknown;
  shared?: boolean;
}

export interface CaseMention {
  noteId: string;
  caseId: string;
  stage: string;
  /** NULL for a system-authored note (179). */
  authorId: string | null;
  systemAuthor: string | null;
  createdAt: Date;
  body: string;
}

export interface CaseMentionPage {
  items: CaseMention[];
  /** Opaque; pass back as `after`. NULL on the last page. */
  next: string | null;
}

/** 185 caps a mentions page here. */
export const MENTIONS_MAX_LIMIT = 200;
export const MENTIONS_DEFAULT_LIMIT = 50;

type Row = Record<string, unknown>;

/** Camel filters -> 185's SQL object; a `sort` key or a bad value is FILTER_INVALID. */
export function viewSqlFilters(filters: unknown): Record<string, unknown> {
  if (filters === undefined || filters === null) return {};
  if (typeof filters !== 'object' || Array.isArray(filters))
    throw new CaseViewsRefusedError('FILTER_INVALID');
  if ((filters as Record<string, unknown>).sort !== undefined)
    throw new CaseViewsRefusedError('FILTER_INVALID');
  try {
    return inboxSqlFilters(filters as CaseInboxFilters);
  } catch (err) {
    if (err instanceof CaseInboxRefusedError)
      throw new CaseViewsRefusedError('FILTER_INVALID');
    throw err;
  }
}

function toView(r: Row): CaseSavedView {
  const filters =
    r.filters !== null && typeof r.filters === 'object'
      ? (r.filters as Record<string, unknown>)
      : {};
  return {
    viewId: String(r.view_id),
    ownerUserId: String(r.owner_user_id),
    name: String(r.name),
    filters: inboxFiltersFromSql(filters) as CaseViewFilters,
    sort: str(r.sort) as CaseInboxSort | null,
    shared: r.shared === true,
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
  };
}

function toMention(r: Row): CaseMention {
  return {
    noteId: String(r.note_id),
    caseId: String(r.case_id),
    stage: String(r.stage),
    authorId: str(r.author_id),
    systemAuthor: str(r.system_author),
    createdAt: date(r.created_at)!,
    body: String(r.body ?? ''),
  };
}

/** The clock text a mentions cursor carries, or CURSOR_INVALID. */
function cursorNow(after: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(after);
  } catch {
    throw new CaseViewsRefusedError('CURSOR_INVALID');
  }
  const n =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).now
      : undefined;
  if (typeof n !== 'string' || Number.isNaN(new Date(n).getTime()))
    throw new CaseViewsRefusedError('CURSOR_INVALID');
  return n;
}

export class CaseViews {
  constructor(
    private readonly db: SupabaseClient,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private async rpc(fn: string, args: Record<string, unknown>) {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      if (typeof error.hint === 'string' && REFUSALS.has(error.hint))
        throw new CaseViewsRefusedError(error.hint as CaseViewsRefusal);
      throw new CaseStoreError(fn, error.code ?? null);
    }
    return data as unknown;
  }

  /** Own views + the shared views of the actor's active workspace. */
  async list(actor: string): Promise<CaseSavedView[]> {
    return rows(await this.rpc('case_view_list', { p_actor: actor })).map(
      toView
    );
  }

  /** Creates (no viewId) or replaces the actor's own view. */
  async save(actor: string, input: CaseViewInput): Promise<CaseSavedView> {
    if (typeof input.name !== 'string')
      throw new CaseViewsRefusedError('NAME_INVALID');
    const filters = viewSqlFilters(input.filters);
    const sort = input.sort ?? null;
    if (sort !== null && !(INBOX_SORTS as readonly unknown[]).includes(sort))
      throw new CaseViewsRefusedError('FILTER_INVALID');
    const row = rows(
      await this.rpc('case_view_save', {
        p_actor: actor,
        p_view_id: input.viewId ?? null,
        p_name: input.name,
        p_filters: filters,
        p_sort: sort,
        p_shared: input.shared ?? false,
      })
    )[0];
    if (!row) throw new CaseStoreError('case_view_save', null);
    return toView(row);
  }

  async delete(actor: string, viewId: string): Promise<void> {
    await this.rpc('case_view_delete', { p_actor: actor, p_view_id: viewId });
  }

  /** The snooze's end as stored. The route has checked tenancy first. */
  async snooze(
    actor: string,
    caseId: string,
    until: Date,
    reason: string | null = null
  ): Promise<Date> {
    const data = await this.rpc('case_snooze', {
      p_actor: actor,
      p_case: caseId,
      p_until: until.toISOString(),
      p_reason: reason,
      p_now: this.clock().toISOString(),
    });
    // A scalar function answers its value as is (PostgREST).
    if (typeof data !== 'string') throw new CaseStoreError('case_snooze', null);
    return date(data)!;
  }

  async unsnooze(actor: string, caseId: string): Promise<void> {
    await this.rpc('case_unsnooze', {
      p_actor: actor,
      p_case: caseId,
      p_now: this.clock().toISOString(),
    });
  }

  /** First page at the server clock; a later page at its cursor's clock. */
  async mentions(
    actor: string,
    opts: { limit?: number; after?: string | null } = {}
  ): Promise<CaseMentionPage> {
    const limit = opts.limit ?? MENTIONS_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1)
      throw new CaseViewsRefusedError('LIMIT_INVALID');
    const after = opts.after ?? null;
    const now = after !== null ? cursorNow(after) : this.clock().toISOString();
    const raw = rows(
      await this.rpc('case_mentions', {
        p_actor: actor,
        p_now: now,
        p_limit: limit,
        p_after: after,
      })
    );
    const full =
      raw.length > 0 && raw.length === Math.min(limit, MENTIONS_MAX_LIMIT);
    return {
      items: raw.map(toMention),
      next: full ? str(raw[raw.length - 1].cursor) : null,
    };
  }
}
