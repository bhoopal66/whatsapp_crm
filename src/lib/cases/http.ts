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
import {
  isOverSendLimit,
  isUuid,
  sendErrorFor,
  sendWindowStart,
} from '@/lib/submission-groups/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';
import {
  SubmissionGroupSendBlockedError,
  SubmissionGroupSendRefusedError,
  SubmissionGroupSentNotRecordedError,
} from '@/lib/submission-groups/service';

import { canReadCase, canWriteCase } from './access';
import { BankDashboardRefusedError } from './dashboard';
import { CaseInboxRefusedError, type CaseInboxFilters } from './inbox';
import { CaseRefusedError, CaseStoreError, type CaseStore } from './store';
import type { Case, CaseRole } from './types';

export { isUuid };

export const CASE_NOT_FOUND = 'Case not found';
export const NOT_ALLOWED = "You can't change this case";

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
 * a case the caller cannot read. With `{ write: true }`, 403 when the role
 * may read but not write.
 */
export async function loadCaseForCaller(
  ctx: { accountId: string; userId: string },
  id: string,
  store: Pick<CaseStore, 'get' | 'role'>,
  { write = false }: { write?: boolean } = {}
): Promise<{ case: Case; role: CaseRole }> {
  if (!isUuid(id)) throw new CaseHttpError(404, CASE_NOT_FOUND);
  const c = ownCase(await store.get(id), ctx.accountId);
  const role = await store.role(c.id, ctx.userId);
  if (role === null || !canReadCase(role))
    throw new CaseHttpError(404, CASE_NOT_FOUND);
  if (write && !canWriteCase(role)) throw new CaseHttpError(403, NOT_ALLOWED);
  return { case: c, role };
}

export const NO_GROUP = 'This lead has no WhatsApp group yet';

/**
 * The case's submission group id, or 422 NO_GROUP for a lead (130): a
 * lead has no conversation, so nothing can be sent to it. Call before
 * any send-limit count or send.
 */
export function requireCaseGroup(c: Pick<Case, 'groupId'>): string {
  if (!c.groupId) throw new CaseHttpError(422, NO_GROUP, { code: 'NO_GROUP' });
  return c.groupId;
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
  LEAD_INVALID:
    'A lead needs a customer you can see, a product and a valid amount',
  PRESUB_REENTRY: 'A submitted case cannot go back to a pre-submission stage',
  SUBMISSION_REQUIRED: 'That stage needs a submission',
  PRESUB_STAGES_REQUIRED:
    'The list must start with Interested, Data collection, Review',
};

/** 130: one open lead / case per customer and bank. */
const CONFLICT_TEXT: Record<string, string> = {
  LEAD_EXISTS: 'An open lead already exists for this customer and bank',
  CASE_EXISTS: 'An open case already exists for this customer and bank',
};

function refusal(code: string): NextResponse {
  if (code === 'TASK_NOT_FOUND')
    return NextResponse.json(
      { error: 'Task not found', code },
      { status: 404 }
    );
  if (code === 'NOT_ALLOWED')
    return NextResponse.json({ error: 'Not allowed', code }, { status: 403 });
  if (code === 'CASE_NOT_FOUND')
    return NextResponse.json({ error: CASE_NOT_FOUND, code }, { status: 404 });
  if (CONFLICT_TEXT[code])
    return NextResponse.json(
      { error: CONFLICT_TEXT[code], code },
      { status: 409 }
    );
  return NextResponse.json(
    { error: REFUSAL_TEXT[code] ?? 'Request refused', code },
    { status: 422 }
  );
}

/**
 * Any error a case route can meet, as a response. Store failures and
 * unknown errors are 500 and logged by name / function / SQLSTATE only:
 * never a message, which may carry customer data. `route` only labels the
 * log line.
 */
export function caseErrorResponse(err: unknown, route?: string): NextResponse {
  const tag = route ? `[cases] ${route}` : '[cases]';
  if (err instanceof CaseHttpError)
    return NextResponse.json(err.body, { status: err.status });
  if (
    err instanceof CaseRefusedError ||
    err instanceof CaseInboxRefusedError ||
    err instanceof BankDashboardRefusedError
  )
    return refusal(err.reason);
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError)
    return toErrorResponse(err);
  if (err instanceof CaseStoreError)
    console.error(`${tag} store failure:`, err.fn, err.code);
  else
    console.error(
      `${tag} unexpected failure:`,
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

/** A JSON object body, or a 400. */
export async function readObject(
  request: Request
): Promise<Record<string, unknown>> {
  const body = await readJsonObject(request);
  if (body === null) throw badRequest('Body must be a JSON object');
  return body;
}

/** A trimmed, non-empty string of at most `max` characters, or a 400. */
export function requiredText(value: unknown, field: string, max: number) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw badRequest(`${field} is required`);
  if (text.length > max)
    throw badRequest(`${field} must be at most ${max} characters`);
  return text;
}

/** Absent / null / blank -> null; else as requiredText. */
export function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requiredText(value, field, max);
}

export function requiredDate(value: unknown, field: string): Date {
  const d = typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime()))
    throw badRequest(`${field} must be a date`);
  return d;
}

/** Absent / null -> null; else a parseable date string, or a 400. */
export function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  return requiredDate(value, field);
}

/** 123's template_key / doc_key rule. */
const KEY_RE = /^[a-z0-9_]{1,64}$/;

export function requiredKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !KEY_RE.test(value))
    throw badRequest(`${field} is not a valid key`);
  return value;
}

/** 123's case_documents_file_ref_check: an id of the stored file. */
const FILE_REF_RE = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$/;

/** Absent / null -> null; else a file_ref matching 123's rule, or a 400. */
export function optionalFileRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !FILE_REF_RE.test(value))
    throw badRequest('file_ref is not a valid file reference');
  return value;
}

/** One of `allowed`, or a 400. */
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): T {
  if (
    typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  throw badRequest(`${field} must be one of ${allowed.join(', ')}`);
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

/**
 * What a failed case send (the conversation reply, the take-over) answers,
 * or null for an error caseErrorResponse owns. 115's send refusals and
 * consent blocks are 409 with a code (its wording, from sendErrorFor). A
 * message WhatsApp accepted but whose row was not recorded is a 200
 * `{ sent: true, recorded: false }`: the text is gone, so nobody resends it.
 */
export function caseSendErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SubmissionGroupSentNotRecordedError) {
    console.error('[cases] sent but not recorded:', err.messageId);
    return NextResponse.json({ sent: true, recorded: false });
  }
  if (err instanceof SubmissionGroupSendRefusedError)
    return NextResponse.json(
      { error: sendErrorFor(err).message, code: err.reason },
      { status: 409 }
    );
  if (err instanceof SubmissionGroupSendBlockedError)
    return NextResponse.json(
      {
        error: sendErrorFor(err).message,
        code: 'SEND_BLOCKED',
        reason: err.reason,
      },
      { status: 409 }
    );
  return null;
}

/**
 * The per-person anti-ban send limit of the Submission Group send route
 * (src/app/api/submission-groups/[id]/messages), for the case routes that
 * send into the same group: the caller's `out` rows in the group within
 * the window, failed ones included. 429 SEND_RATE_LIMITED when over; a
 * count error is 503 (fail closed, as there). Call after the case load and
 * role check and BEFORE any send or log write.
 */
export async function assertUnderGroupSendLimit(
  accountId: string,
  groupId: string,
  userId: string
): Promise<void> {
  const { count, error } = await supabaseAdmin()
    .from('submission_group_messages')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('group_id', groupId)
    .eq('direction', 'out')
    .eq('sender_user_id', userId)
    .gte('created_at', sendWindowStart());
  if (error) {
    console.error('[cases] send count failed', error);
    throw new CaseHttpError(503, 'Could not check the send limit');
  }
  if (isOverSendLimit(count ?? 0))
    throw new CaseHttpError(
      429,
      'You are sending to this group too fast; wait a minute',
      { code: 'SEND_RATE_LIMITED' }
    );
}
