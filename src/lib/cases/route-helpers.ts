/**
 * Shared helpers of the internal case tool routes
 * (`/api/cases/[id]/{tasks,documents,notes,bank-contacts,sla,outcome-reason}`):
 * loading the case for the caller, body parsing, and mapping store errors
 * onto `{ error, code? }` responses. No I/O of its own; the route passes
 * the store.
 *
 * ACTIVE WORKSPACE: `case_role` ignores which workspace is the caller's
 * active one (store.ts), so the loader refuses a case of any other
 * account as not found before it asks for a role.
 */
import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { isUuid } from '@/lib/submission-groups/http';

import { canReadCase, canWriteCase } from './access';
import { BankDashboardRefusedError } from './dashboard';
import { CaseRefusedError, CaseStoreError, type CaseStore } from './store';
import type { Case, CaseRole } from './types';

export { isUuid };

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

export const CASE_NOT_FOUND = 'Case not found';
export const NOT_ALLOWED = "You can't change this case";

/**
 * The case and the caller's role on it. 404 for a non-uuid id, a missing
 * case, a case of another account, or no role; 403 when `write` and the
 * role may not write.
 */
export async function loadCaseForCaller(
  store: Pick<CaseStore, 'get' | 'role'>,
  ctx: { accountId: string; userId: string },
  id: string,
  { write }: { write: boolean }
): Promise<{ case: Case; role: CaseRole }> {
  if (!isUuid(id)) throw new CaseHttpError(404, CASE_NOT_FOUND);
  const c = await store.get(id);
  if (!c || c.accountId !== ctx.accountId)
    throw new CaseHttpError(404, CASE_NOT_FOUND);
  const role = await store.role(id, ctx.userId);
  if (!canReadCase(role)) throw new CaseHttpError(404, CASE_NOT_FOUND);
  if (write && !canWriteCase(role)) throw new CaseHttpError(403, NOT_ALLOWED);
  return { case: c, role: role! };
}

/** A JSON object body, or a 400. */
export async function readObject(
  request: Request
): Promise<Record<string, unknown>> {
  const raw: unknown = await request.json().catch(() => null);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new CaseHttpError(400, 'Body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** A trimmed, non-empty string of at most `max` characters, or a 400. */
export function requiredText(value: unknown, field: string, max: number) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new CaseHttpError(400, `${field} is required`);
  if (text.length > max)
    throw new CaseHttpError(400, `${field} must be at most ${max} characters`);
  return text;
}

/** Absent / null / blank → null; else as requiredText. */
export function optionalText(value: unknown, field: string, max: number) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return requiredText(value, field, max);
}

/** Absent / null → null; else a parseable date string, or a 400. */
export function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null) return null;
  return requiredDate(value, field);
}

export function requiredDate(value: unknown, field: string): Date {
  const d = typeof value === 'string' ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime()))
    throw new CaseHttpError(400, `${field} must be a date`);
  return d;
}

/** 123's template_key / doc_key rule. */
const KEY_RE = /^[a-z0-9_]{1,64}$/;

export function requiredKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !KEY_RE.test(value))
    throw new CaseHttpError(400, `${field} is not a valid key`);
  return value;
}

/** 123's case_documents_file_ref_check: an id of the stored file. */
const FILE_REF_RE = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]{0,127}$/;

/** Absent / null → null; else a file_ref matching 123's rule, or a 400. */
export function optionalFileRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !FILE_REF_RE.test(value))
    throw new CaseHttpError(400, 'file_ref is not a valid file reference');
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
  throw new CaseHttpError(400, `${field} must be one of ${allowed.join(', ')}`);
}

const REFUSED = 'The request was refused';

function refusal(reason: string): CaseHttpError {
  if (reason === 'NOT_ALLOWED') return new CaseHttpError(403, NOT_ALLOWED);
  if (reason === 'CASE_NOT_FOUND')
    return new CaseHttpError(404, CASE_NOT_FOUND);
  if (reason === 'TASK_NOT_FOUND')
    return new CaseHttpError(404, 'Task not found');
  return new CaseHttpError(422, REFUSED, { code: reason });
}

/**
 * The response for an error thrown by a case route. Auth errors keep
 * their status; anything unclassified is a 500, logged with the error's
 * name (and a store error's function and SQLSTATE) only: never its
 * message, which could carry customer data or note text.
 */
export function caseErrorResponse(err: unknown, route: string): NextResponse {
  let mapped: CaseHttpError | null = null;
  if (err instanceof CaseHttpError) mapped = err;
  else if (err instanceof CaseRefusedError) mapped = refusal(err.reason);
  else if (err instanceof BankDashboardRefusedError)
    mapped = refusal(err.reason);
  if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError)
    return toErrorResponse(err);
  if (err instanceof CaseStoreError)
    console.error(`[cases] ${route} failed`, err.name, err.fn, err.code);
  else
    console.error(
      `[cases] ${route} failed`,
      err instanceof Error ? err.name : typeof err
    );
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}
