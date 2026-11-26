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

/** The newest retention run (privacy_retention_last_run, 282). */
export interface RetentionLastRun {
  at: string;
  mode: 'dry_run' | 'apply' | 'failed';
  code: string | null;
  more: boolean;
  rows: number;
  files: number;
}

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

  async erase(
    actor: string,
    account: string,
    contactId: string,
    input: { dryRun: boolean; confirm: string | null }
  ): Promise<EraseResult | null> {
    const data = (await this.rpc('privacy_subject_erase', {
      p_actor: actor,
      p_account: account,
      p_contact: contactId,
      p_dry_run: input.dryRun,
      p_confirm: input.confirm,
    })) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return null;
    return {
      mode: data.mode === 'erase' ? 'erase' : 'dry_run',
      blocked: data.blocked === 'legal_hold' ? 'legal_hold' : null,
      requestId: Number(data.request_id),
      counts: (data.counts as Record<string, number> | undefined) ?? {},
      objects: Array.isArray(data.objects)
        ? (data.objects as StoredObject[])
        : [],
      objectsCount: Number(data.objects_count ?? 0),
    };
  }

  async objectsDone(
    actor: string,
    account: string,
    requestId: number,
    remaining: StoredObject[]
  ): Promise<void> {
    await this.rpc('privacy_erase_objects_done', {
      p_actor: actor,
      p_account: account,
      p_request: requestId,
      p_remaining: remaining,
    });
  }

  async legalHold(
    actor: string,
    account: string,
    contactId: string,
    change?: { place: boolean; reason: string | null }
  ): Promise<LegalHold | null> {
    const data = (await (change
      ? this.rpc('privacy_legal_hold_set', {
          p_actor: actor,
          p_account: account,
          p_contact: contactId,
          p_place: change.place,
          p_reason: change.reason,
        })
      : this.rpc('privacy_legal_hold_get', {
          p_actor: actor,
          p_account: account,
          p_contact: contactId,
        }))) as Record<string, unknown> | null;
    if (!data || typeof data !== 'object') return null;
    const hold = data.hold as { reason?: string; placed_at?: string } | null;
    return {
      onHold: data.on_hold === true,
      reason: hold?.reason ?? null,
      placedAt: hold?.placed_at ?? null,
    };
  }

  async retention(
    actor: string,
    account: string,
    change?: { policy: unknown; apply: boolean }
  ): Promise<{
    policy: unknown;
    apply: boolean;
    updatedAt: string | null;
    lastRun: RetentionLastRun | null;
  }> {
    const data = (await (change
      ? this.rpc('privacy_retention_set', {
          p_actor: actor,
          p_account: account,
          p_policy: change.policy,
          p_apply: change.apply,
        })
      : this.rpc('privacy_retention_get', {
          p_actor: actor,
          p_account: account,
        }))) as Record<string, unknown>;
    return {
      policy: data.policy,
      apply: data.apply === true,
      updatedAt: (data.updated_at as string | null) ?? null,
      // Absent before 282.
      lastRun: (data.last_run as RetentionLastRun | null | undefined) ?? null,
    };
  }

  async aiTransfer(
    actor: string,
    account: string,
    change?: {
      basis: string | null;
      note: string | null;
      approvedBy: string | null;
      region: string | null;
      requireBasis: boolean;
    }
  ): Promise<unknown> {
    return change
      ? this.rpc('ai_transfer_basis_set', {
          p_actor: actor,
          p_account: account,
          p_basis: change.basis,
          p_note: change.note,
          p_approved_by: change.approvedBy,
          p_region: change.region,
          p_require: change.requireBasis,
        })
      : this.rpc('ai_transfer_basis_get', {
          p_actor: actor,
          p_account: account,
        });
  }
}

/** A stored file the erase removed the row of: by bucket and path, or a chat-media URL. */
export type StoredObject =
  { bucket: string; path: string } | { bucket: 'chat-media'; url: string };

export interface EraseResult {
  mode: 'dry_run' | 'erase';
  blocked: 'legal_hold' | null;
  requestId: number;
  counts: Record<string, number>;
  objects: StoredObject[];
  objectsCount: number;
}

export interface LegalHold {
  onHold: boolean;
  reason: string | null;
  placedAt: string | null;
}
