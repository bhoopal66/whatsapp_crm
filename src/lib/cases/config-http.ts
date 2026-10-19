/**
 * Request helpers for the Settings -> Cases routes (`/api/cases/config/*`,
 * module 018c): the account's banks, their stage lists, task templates,
 * required documents and SLA timers. Reads are agent and up, writes owner
 * / admin; the SQL functions re-check the writer (NOT_ALLOWED).
 *
 * The account is always the caller's ACTIVE one (`ctx.accountId`), never
 * a path or body value. Bank existence is read through the caller's RLS
 * client (case_banks is readable by the active account's members).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import { badRequest, CaseHttpError, caseErrorResponse } from './http';
import { CaseStoreError } from './store';

/** 122's case_banks_code_check. */
const BANK_CODE_RE = /^[A-Z0-9_]{2,32}$/;
/** Postgres `integer`. */
const INT_MAX = 2147483647;

export const BANK_NOT_FOUND = 'Bank not found';

/** A bank code from the path, or a 404. */
export function bankCodeParam(code: string): string {
  if (!BANK_CODE_RE.test(code)) throw new CaseHttpError(404, BANK_NOT_FOUND);
  return code;
}

/** A bank code from a body, or a 400. */
export function requiredBankCode(value: unknown): string {
  if (typeof value !== 'string' || !BANK_CODE_RE.test(value))
    throw badRequest(
      'code must be 2-32 capital letters, digits or underscores'
    );
  return value;
}

/** A whole number in 1..max (default: a Postgres integer), or a 400. */
export function positiveInt(value: unknown, field: string, max = INT_MAX) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    throw badRequest(`${field} must be a whole number from 1 to ${max}`);
  return value;
}

/** Absent / null -> null; else as positiveInt. */
export function optionalPositiveInt(
  value: unknown,
  field: string,
  max = INT_MAX
): number | null {
  if (value === undefined || value === null) return null;
  return positiveInt(value, field, max);
}

/** A query parameter, '' when absent. */
export function queryParam(request: Request, name: string): string {
  return new URL(request.url).searchParams.get(name) ?? '';
}

type Read = PromiseLike<{
  data: unknown;
  error: { code?: string } | null;
}>;

/** The rows of an RLS read; a failed read is a CaseStoreError (500). */
export async function readRows(
  query: Read,
  table: string
): Promise<Record<string, unknown>[]> {
  const { data, error } = await query;
  if (error) throw new CaseStoreError(table, error.code ?? null);
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/** The bank of the caller's active account, or a 404. */
export async function requireBank(
  supabase: SupabaseClient,
  accountId: string,
  code: string
): Promise<{ code: string; name: string }> {
  const [bank] = await readRows(
    supabase
      .from('case_banks')
      .select('code, name')
      .eq('account_id', accountId)
      .eq('code', code)
      .limit(1),
    'case_banks'
  );
  if (!bank) throw new CaseHttpError(404, BANK_NOT_FOUND);
  return { code: String(bank.code), name: String(bank.name) };
}

/**
 * caseErrorResponse, plus the two constraint failures a config write can
 * meet without a refusal hint: a CHECK violation (23514) is 422 INVALID,
 * and a unique violation (23505) is 422 STAGE_DUPLICATE — the other
 * config writes are ON CONFLICT upserts, so only case_bank_stages_set
 * (the same stage twice in one list) raises one.
 */
export function configErrorResponse(
  err: unknown,
  route?: string
): NextResponse {
  if (err instanceof CaseStoreError && err.code === '23514')
    return NextResponse.json(
      { error: 'That value is not allowed', code: 'INVALID' },
      { status: 422 }
    );
  if (err instanceof CaseStoreError && err.code === '23505')
    return NextResponse.json(
      { error: 'A stage appears twice in the list', code: 'STAGE_DUPLICATE' },
      { status: 422 }
    );
  return caseErrorResponse(err, route);
}
