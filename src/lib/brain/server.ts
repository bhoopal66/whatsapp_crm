/**
 * Server-only wiring for the second brain's HTTP surface (package 022b,
 * migration 194). Routes resolve the caller (active account, sales
 * access), then `requireBrain`, then act through these service-role
 * ports. The account and the actor always come from the session, never
 * from a request body. Brain text (queries, remembered text) is never
 * logged.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  UnauthorizedError,
  toErrorResponse,
} from '@/lib/auth/account';
import { CaseHttpError, badRequest, isUuid } from '@/lib/cases/http';
import { supabaseAdmin } from '@/lib/submission-groups/server';

import { HashingEmbedder } from './embed';
import type { IngestDeps } from './ingest';
import { SupabaseBrainPageStore } from './pages';
import type { SearchDeps } from './search';
import { BrainError, SupabaseBrainStore, SupabaseCosineIndex } from './store';
import { AuthUnavailableError } from '@/lib/auth/auth-unavailable';

export function brainDeps(): IngestDeps & SearchDeps {
  const admin = supabaseAdmin();
  return {
    store: new SupabaseBrainStore(admin),
    index: new SupabaseCosineIndex(admin),
    embedder: new HashingEmbedder(),
  };
}

/** The 022c page store on the service role. */
export function brainPages(): SupabaseBrainPageStore {
  return new SupabaseBrainPageStore(supabaseAdmin());
}

/** `case_account_settings.brain_enabled`; no row means off. A failed read throws (500), never "on". */
export async function brainEnabled(accountId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('case_account_settings')
    .select('brain_enabled')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw new Error('brain switch read failed');
  return (data as { brain_enabled?: unknown } | null)?.brain_enabled === true;
}

/** 403 `{ error: 'brain_disabled' }` while the account's switch is off. */
export async function requireBrain(ctx: { accountId: string }): Promise<void> {
  if (!(await brainEnabled(ctx.accountId)))
    throw new ForbiddenError('brain_disabled');
}

/** A response the route answers as `{ error }` with `status`. */
export class BrainHttpError extends Error {
  override readonly name = 'BrainHttpError';
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** `{ error: contact_not_found }` (404) unless the caller's RLS client can read the contact. */
export async function requireVisibleContact(
  ctx: { supabase: SupabaseClient },
  contactId: string
): Promise<void> {
  const { data, error } = await ctx.supabase
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw new Error('contact read failed');
  if (!data) throw new BrainHttpError(404, 'contact_not_found');
}

/** Absent / null -> null; a uuid string -> it; anything else -> 400. */
export function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isUuid(value))
    throw badRequest(`${field} must be a uuid`);
  return value;
}

const NOT_FOUND = new Set(['CASE_NOT_FOUND', 'ITEM_NOT_FOUND']);

/**
 * One catch for every brain route. Logs the route and the failing RPC
 * name / code only: never a message, a query or remembered text.
 */
export function brainErrorResponse(err: unknown, route: string): NextResponse {
  const tag = `[brain] ${route}`;
  if (err instanceof BrainHttpError || err instanceof CaseHttpError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  if (
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof AuthUnavailableError
  )
    return toErrorResponse(err);
  if (err instanceof BrainError && err.reason !== null) {
    const status =
      err.reason === 'NOT_ALLOWED'
        ? 403
        : NOT_FOUND.has(err.reason)
          ? 404
          : 422;
    return NextResponse.json({ error: err.reason }, { status });
  }
  if (err instanceof BrainError)
    console.error(`${tag} store failure:`, err.fn, err.code);
  else
    console.error(
      `${tag} unexpected failure:`,
      err instanceof Error ? err.name : typeof err
    );
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}
