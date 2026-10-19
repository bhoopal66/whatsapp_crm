/**
 * Shared pieces of the /api/vault routes (Settings -> Vault, module 019c). Every answer carries
 * `Cache-Control: no-store` (a revealed value must never sit in a cache), and nothing here logs a token, a value, a
 * reason or a request body: an unexpected failure logs its error name only, a VaultStoreError its function and
 * SQLSTATE (its message names only the function).
 */
import { NextResponse } from 'next/server';

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { vaultStore } from './server';
import { VaultStoreError, type VaultStore } from './store';

/** migration 121's token CHECK. */
export const VAULT_TOKEN_RE = /^vlt_[ghjkmnpqrstvwxyz]{26}$/;
/** vault_reason_problem's REASON_TOO_LONG bound (char_length: code points). */
export const MAX_VAULT_REASON_CHARS = 500;

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export class VaultHttpError extends Error {
  override readonly name = 'VaultHttpError';
  constructor(
    readonly status: number,
    readonly body: { error: string; code?: string }
  ) {
    super(body.error);
  }
}

export const vaultBadRequest = (error: string) =>
  new VaultHttpError(400, { error });

export function vaultJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function vaultErrorResponse(err: unknown): NextResponse {
  if (err instanceof VaultHttpError) return vaultJson(err.body, err.status);
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError)
    return vaultJson({ error: err.message }, err.status);
  if (err instanceof VaultStoreError)
    console.error('[vault] store failure:', err.message, err.code);
  else
    console.error(
      '[vault] unexpected failure:',
      err instanceof Error ? err.name : typeof err
    );
  return vaultJson({ error: 'Something went wrong' }, 500);
}

/** The configured store, else a 503 VAULT_NOT_CONFIGURED (the fixed reason stays server-side). */
export function requireVaultStore(): VaultStore {
  const v = vaultStore();
  if (!v.ok)
    throw new VaultHttpError(503, {
      error: 'The vault is not configured',
      code: 'VAULT_NOT_CONFIGURED',
    });
  return v.store;
}

/** The JSON body as an object, else null. A parse error is swallowed: its message can quote the body. */
export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  const raw: unknown = await request.json().catch(() => null);
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

/** `{ token, reason }` for reveal / erase: a well-formed token and a non-blank reason of at most 500 characters. */
export async function readTokenAndReason(
  request: Request
): Promise<{ token: string; reason: string }> {
  const body = await readJsonObject(request);
  const token = body?.token;
  const reason = body?.reason;
  if (typeof token !== 'string' || !VAULT_TOKEN_RE.test(token))
    throw vaultBadRequest('token is not valid');
  if (
    typeof reason !== 'string' ||
    reason.trim() === '' ||
    [...reason].length > MAX_VAULT_REASON_CHARS
  )
    throw vaultBadRequest(
      `reason is required (at most ${MAX_VAULT_REASON_CHARS} characters)`
    );
  return { token, reason };
}
