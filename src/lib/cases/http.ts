/**
 * Request / response helpers for the internal Cases routes (module 018c,
 * `/api/cases/*`): the caller's case check, body and query parsing, and
 * the mapping of case errors onto `{ error, code? }` responses.
 *
 * TENANCY: `case_role` ignores which workspace is active, so a route must
 * check the case's account against the caller's ACTIVE account before any
 * actor call. A case the caller may not read answers 404, never 403.
 */
import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { isUuid } from '@/lib/submission-groups/http';

import { canReadCase } from './access';
import { CaseInboxRefusedError, type CaseInboxFilters } from './inbox';
import { CaseRefusedError, CaseStoreError, type CaseStore } from './store';
import type { Case, CaseRole } from './types';

export { isUuid };

export const CASE_NOT_FOUND = 'Case not found';

/** A response the route answers as `{ error, ...extra }` with `status`. */
export class CaseHttpError extends Error {
  override readonly name = 'CaseHttpError';
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
  }

  get body(): Record<string, unknown> {
    return { error: this.message, ...this.extra };
  }
}

export const badRequest = (message: string) => new CaseHttpError(400, message);

/** The case, only when it exists and belongs to the caller's account; else 404. */
export function ownCase(c: Case | null, accountId: string): Case {
  if (!c || c.accountId !== accountId)
    throw new CaseHttpError(404, CASE_NOT_FOUND);
  return c;
}

/**
 * The case and the caller's live role on it. 404 for a non-uuid id, a
 * missing case, another account's case (checked BEFORE the role call) and
 * a case the caller cannot read.
 */
export async function loadCaseForCaller(
  ctx: { accountId: string; userId: string },
  id: string,
  store: Pick<CaseStore, 'get' | 'role'>
): Promise<{ case: Case; role: CaseRole }> {
  if (!isUuid(id)) throw new CaseHttpError(404, CASE_NOT_FOUND);
  const c = ownCase(await store.get(id), ctx.accountId);
  const role = await store.role(c.id, ctx.userId);
  if (role === null || !canReadCase(role))
    throw new CaseHttpError(404, CASE_NOT_FOUND);
  return { case: c, role };
}

/** case_audit_list's only readers. */
export function canSeeCaseAudit(role: CaseRole | null): boolean {
  return role === 'admin' || role === 'super_admin';
}

const REFUSAL_TEXT: Record<string, string> = {
  STAGE_NOT_CONFIGURED: 'Stage not configured for this bank',
  OUTCOME_INVALID: 'That outcome is not valid',
  OUTCOME_STAGE_MISMATCH: 'That outcome does not match the stage',
  CASE_CLOSED: 'The case is closed',
  FINAL_STAGE: 'The case is at a final stage',
  ASSIGNEE_INVALID: 'That person cannot be assigned to this case',
  LIMIT_INVALID: 'That limit is not valid',
  GROUP_NOT_FOUND: 'Group not found',
  NO_AGENT: 'The group has no agent',
  BANK_UNKNOWN: 'That bank is not set up in this workspace',
  STAGE_NOT_IN_LIST: "The case's stage is not in that bank's list",
  PRIORITY_INVALID: 'That priority is not valid',
  DUE_INVALID: 'That due date is not valid',
  FILTER_INVALID: 'That filter is not valid',
  CURSOR_INVALID: 'That page cursor is not valid',
  NOW_REQUIRED: 'A time is required',
};

function refusal(code: string): NextResponse {
  if (code === 'NOT_ALLOWED')
    return NextResponse.json({ error: 'Not allowed', code }, { status: 403 });
  if (code === 'CASE_NOT_FOUND')
    return NextResponse.json({ error: CASE_NOT_FOUND, code }, { status: 404 });
  return NextResponse.json(
    { error: REFUSAL_TEXT[code] ?? 'Request refused', code },
    { status: 422 }
  );
}

/**
 * Any error a case route can meet, as a response. Store failures and
 * unknown errors are 500 and logged by name / function / SQLSTATE only:
 * never a message, which may carry customer data.
 */
export function caseErrorResponse(err: unknown): NextResponse {
  if (err instanceof CaseHttpError)
    return NextResponse.json(err.body, { status: err.status });
  if (err instanceof CaseRefusedError || err instanceof CaseInboxRefusedError)
    return refusal(err.reason);
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError)
    return toErrorResponse(err);
  if (err instanceof CaseStoreError)
    console.error('[cases] store failure:', err.fn, err.code);
  else
    console.error(
      '[cases] unexpected failure:',
      err instanceof Error ? err.name : typeof err
    );
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}

/** A JSON body object, or null (not JSON, or not an object). */
export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  const raw: unknown = await request.json().catch(() => null);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

const AMOUNT_RE = /^\d{1,16}(\.\d{1,2})?$/;

/** An AED amount (numeric(18,2), >= 0) as a decimal string, or null when invalid. */
export function parseAmount(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return AMOUNT_RE.test(s) ? s : null;
}

/** A non-empty trimmed string up to `max`, or null when invalid. */
export function parseText(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s !== '' && s.length <= max ? s : null;
}

const TEXT_FILTERS = {
  bank: 'bank',
  stage: 'stage',
  agent: 'agent',
  priority: 'priority',
  sla_state: 'slaState',
  sort: 'sort',
} as const;
const BOOL_FILTERS = {
  customer_waiting: 'customerWaiting',
  documents_missing: 'documentsMissing',
  bank_query_open: 'bankQueryOpen',
  include_closed: 'includeClosed',
} as const;

/** A whole number when the text is one, else the text itself (the lib refuses it). */
const intOrRaw = (s: string): number | string =>
  /^-?\d{1,9}$/.test(s) ? Number(s) : s;

/**
 * GET /api/cases query -> the inbox's filters and paging. Only known
 * params are read; an empty one counts as absent. Values are NOT
 * validated here: a bad one is passed through as text, so the inbox's
 * own check refuses it (FILTER_INVALID / LIMIT_INVALID, 422) and there is
 * one validator.
 */
export function parseInboxQuery(params: URLSearchParams): {
  filters: CaseInboxFilters;
  limit?: number;
  after?: string;
} {
  const filters: Record<string, unknown> = {};
  const get = (k: string) => {
    const v = params.get(k);
    return v === null || v === '' ? undefined : v;
  };
  for (const [q, key] of Object.entries(TEXT_FILTERS)) {
    const v = get(q);
    if (v !== undefined) filters[key] = v;
  }
  for (const [q, key] of Object.entries(BOOL_FILTERS)) {
    const v = get(q);
    if (v !== undefined)
      filters[key] = v === 'true' ? true : v === 'false' ? false : v;
  }
  const days = get('no_activity_days');
  if (days !== undefined) filters.noActivityDays = intOrRaw(days);
  const out: { filters: CaseInboxFilters; limit?: number; after?: string } = {
    filters: filters as CaseInboxFilters,
  };
  const limit = get('limit');
  // A non-integer limit becomes NaN, which the inbox refuses (LIMIT_INVALID).
  if (limit !== undefined)
    out.limit = /^\d{1,9}$/.test(limit) ? Number(limit) : NaN;
  const after = get('after');
  if (after !== undefined) out.after = after;
  return out;
}
