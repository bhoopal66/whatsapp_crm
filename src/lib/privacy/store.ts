/**
 * PDPL requests (migrations 221-223) on the service role, with the
 * caller's auth user id and ACTIVE account. The SQL decides every
 * permission; a refusal comes back as its HINT (PrivacyRefusedError),
 * anything else as PrivacyStoreError (no database text).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const PRIVACY_REFUSALS = [
  'NOT_ALLOWED',
  'NOT_FOUND',
  'INVALID',
  'CONFIRM_REQUIRED',
  'REASON_REQUIRED',
  'LEGAL_HOLD',
] as const;
export type PrivacyRefusal = (typeof PRIVACY_REFUSALS)[number];
const REFUSALS: ReadonlySet<string> = new Set(PRIVACY_REFUSALS);

export class PrivacyRefusedError extends Error {
  override readonly name = 'PrivacyRefusedError';
  constructor(readonly reason: PrivacyRefusal) {
    super(`privacy refused: ${reason}`);
  }
}

export class PrivacyStoreError extends Error {
  override readonly name = 'PrivacyStoreError';
  constructor(
    readonly fn: string,
    readonly code: string | null
  ) {
    super(`privacy: ${fn} failed`);
  }
}

type DbError = { code?: string; hint?: string | null };

export class PrivacyStore {
  constructor(private readonly db: SupabaseClient) {}

  protected async rpc(
    fn: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      const e = error as DbError;
      if (typeof e.hint === 'string' && REFUSALS.has(e.hint))
        throw new PrivacyRefusedError(e.hint as PrivacyRefusal);
      throw new PrivacyStoreError(fn, e.code ?? null);
    }
    return data;
  }

  /** The customer's data as one document, or null when the contact is not the account's. */
  async exportSubject(
    actor: string,
    account: string,
    contactId: string
  ): Promise<Record<string, unknown> | null> {
    const data = await this.rpc('privacy_subject_export', {
      p_actor: actor,
      p_account: account,
      p_contact: contactId,
    });
    return data && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : null;
  }
}
