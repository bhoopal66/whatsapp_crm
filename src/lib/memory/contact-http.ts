/**
 * Shared pieces of the /api/contacts/[id]/memory routes (019b, the Memory panel on the customer page). The contact is
 * loaded with the CALLER's RLS client first, so a contact the caller cannot see (or another account's) is a 404 before
 * any memory_* call; the memory_* functions then decide who reads.
 */
import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  UnauthorizedError,
  type AccountContext,
} from '@/lib/auth/account';
import { MemoryStoreError, type MemoryScope } from './store';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && UUID_RE.test(v);

export class MemoryHttpError extends Error {
  override readonly name = 'MemoryHttpError';
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export const memoryBadRequest = (message: string) =>
  new MemoryHttpError(400, message);

export function memoryErrorResponse(err: unknown): NextResponse {
  if (err instanceof MemoryHttpError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof MemoryStoreError)
    console.error('[memory] store failure:', err.fn, err.code);
  else
    console.error(
      '[memory] unexpected failure:',
      err instanceof Error ? err.name : typeof err
    );
  return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
}

/** The JSON body as an object, else null (a parse error's message can quote the body, so it is swallowed). */
export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  const raw: unknown = await request.json().catch(() => null);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** The contact's memory scope, or a 404 when the caller's RLS client cannot see it in their active account. */
export async function loadContactScope(
  ctx: Pick<AccountContext, 'supabase' | 'accountId'>,
  id: string
): Promise<MemoryScope> {
  const notFound = new MemoryHttpError(404, 'Contact not found');
  if (!isUuid(id)) throw notFound;
  const { data, error } = await ctx.supabase
    .from('contacts')
    .select('id, account_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new MemoryStoreError('contacts', error.code ?? null);
  if (!data || data.account_id !== ctx.accountId) throw notFound;
  return { type: 'contact', id: String(data.id) };
}
