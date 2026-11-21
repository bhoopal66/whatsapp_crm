/**
 * The case desk store (migration 220): one SECURITY DEFINER RPC per call,
 * on the service role, with the caller's auth user id as the actor and
 * their ACTIVE account. The SQL decides every permission; a refusal comes
 * back as its HINT and is thrown as DeskRefusedError, anything else as
 * DeskStoreError (no database text).
 *
 * TENANCY: the routes pass `ctx.accountId` (the caller's active account)
 * and every function confines itself to it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export const DESK_REFUSALS = [
  'INVALID',
  'NOT_ALLOWED',
  'BANK_UNKNOWN',
  'BANK_CODE_MISSING',
  'CODE_TAKEN',
  'SEQ_EXHAUSTED',
  'SUFFIX_EXHAUSTED',
  'CASE_CONFLICT',
  'NO_CONTACT',
  'FILE_INVALID',
  'ITEM_NOT_FOUND',
  'ITEM_NOT_OPEN',
  'BANK_SCOPE',
  'CASE_NOT_FOUND',
  'CASE_CLOSED',
  'NO_FILE',
  'REASON_REQUIRED',
  'LEAD_INVALID',
  'LEAD_EXISTS',
  'CASE_EXISTS',
  'ASSIGNEE_INVALID',
] as const;
export type DeskRefusal = (typeof DESK_REFUSALS)[number];
const REFUSALS: ReadonlySet<string> = new Set(DESK_REFUSALS);

export class DeskRefusedError extends Error {
  override readonly name = 'DeskRefusedError';
  constructor(readonly reason: DeskRefusal) {
    super(`desk refused: ${reason}`);
  }
}

export class DeskStoreError extends Error {
  override readonly name = 'DeskStoreError';
  constructor(
    readonly fn: string,
    readonly code: string | null
  ) {
    super(`desk: ${fn} failed`);
  }
}

export type ItemState = 'untagged' | 'filed' | 'rejected' | 'duplicate';
export type ItemKind = 'new_case' | 'pending_doc' | 'info';

export interface ItemResult {
  itemId: string;
  state: ItemState;
  caseId: string | null;
  caseNumber: string | null;
  captionCode: string | null;
  fileId: string | null;
  duplicateOfItem: string | null;
  queueBankCode: string | null;
  queueReason: string | null;
  replayed: boolean;
}

export interface ItemTags {
  kind: ItemKind | null;
  bankCode: string | null;
  caseRef: string | null;
  companyName: string | null;
  tradeLicence: string | null;
  product: string | null;
  contactId: string | null;
  docKey: string | null;
  note: string | null;
}

export interface ItemFile {
  storagePath: string;
  originalName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
}

export interface QueueItem extends ItemTags {
  itemId: string;
  uploadedBy: string;
  receivedAt: string;
  ageSeconds: number;
  originalName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  hasFile: boolean;
  queueBankCode: string | null;
  queueReason: string | null;
}

export interface MyItem extends ItemTags {
  itemId: string;
  receivedAt: string;
  state: ItemState;
  caseId: string | null;
  caseNumber: string | null;
  originalName: string | null;
  fileId: string | null;
  queueBankCode: string | null;
  queueReason: string | null;
  rejectReason: string | null;
  duplicateOfItem: string | null;
  duplicateOfUploader: string | null;
}

export interface DeskBank {
  bankCode: string;
  bankName: string;
  shortCode: string | null;
}

export interface OverviewRow {
  bankCode: string | null;
  bankName: string | null;
  shortCode: string | null;
  holders: number;
  toSort: number;
  oldestAgeSeconds: number | null;
  alert: 'none' | 'second' | 'lead' | 'no_coordinator';
}

export interface CaseLookup {
  caseId: string;
  caseNumber: string | null;
  bankCode: string | null;
  companyName: string | null;
  contactId: string | null;
  product: string | null;
  stage: string;
}

type Row = Record<string, unknown>;
type DbError = { code?: string; hint?: string | null };

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : v === null || v === undefined ? null : String(v);
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

function tagsOf(r: Row): ItemTags {
  return {
    kind: str(r.kind) as ItemKind | null,
    bankCode: str(r.bank_code),
    caseRef: str(r.case_ref),
    companyName: str(r.company_name),
    tradeLicence: str(r.trade_licence_no),
    product: str(r.product),
    contactId: str(r.contact_id),
    docKey: str(r.doc_key),
    note: str(r.note),
  };
}

export function toItemResult(r: Row): ItemResult {
  return {
    itemId: String(r.item_id),
    state: String(r.state) as ItemState,
    caseId: str(r.case_id),
    caseNumber: str(r.case_number),
    captionCode: str(r.caption_code),
    fileId: str(r.file_id),
    duplicateOfItem: str(r.duplicate_of_item),
    queueBankCode: str(r.queue_bank_code),
    queueReason: str(r.queue_reason),
    replayed: r.replayed === true,
  };
}

export class DeskStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly clock: () => Date = () => new Date()
  ) {}

  private async rpc(fn: string, args: Record<string, unknown>): Promise<Row[]> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      const e = error as DbError;
      if (typeof e.hint === 'string' && REFUSALS.has(e.hint))
        throw new DeskRefusedError(e.hint as DeskRefusal);
      throw new DeskStoreError(fn, e.code ?? null);
    }
    if (Array.isArray(data)) return data as Row[];
    return data === null || data === undefined ? [] : [data as Row];
  }

  private async result(fn: string, args: Record<string, unknown>) {
    const row = (await this.rpc(fn, args))[0];
    if (!row) throw new DeskStoreError(fn, null);
    return toItemResult(row);
  }

  private now() {
    return this.clock().toISOString();
  }

  submit(
    actor: string,
    account: string,
    input: {
      itemId: string;
      idemKey: string;
      tags: ItemTags;
      file: ItemFile | null;
    }
  ): Promise<ItemResult> {
    const { tags, file } = input;
    return this.result('intake_submit', {
      p_actor: actor,
      p_account: account,
      p_item: input.itemId,
      p_idem_key: input.idemKey,
      p_kind: tags.kind,
      p_bank_code: tags.bankCode,
      p_case_ref: tags.caseRef,
      p_company_name: tags.companyName,
      p_trade_licence: tags.tradeLicence,
      p_product: tags.product,
      p_contact: tags.contactId,
      p_doc_key: tags.docKey,
      p_note: tags.note,
      p_storage_path: file?.storagePath ?? null,
      p_original_name: file?.originalName ?? null,
      p_mime: file?.mime ?? null,
      p_size: file?.sizeBytes ?? null,
      p_sha256: file?.sha256 ?? null,
      p_now: this.now(),
    });
  }

  file(
    actor: string,
    account: string,
    itemId: string,
    input: {
      caseId: string;
      kind: 'pending_doc' | 'info';
      docKey: string | null;
    }
  ): Promise<ItemResult> {
    return this.result('intake_file', {
      p_actor: actor,
      p_account: account,
      p_item: itemId,
      p_case: input.caseId,
      p_kind: input.kind,
      p_doc_key: input.docKey,
      p_now: this.now(),
    });
  }

  fileNewCase(
    actor: string,
    account: string,
    itemId: string,
    input: {
      tradeLicence: string;
      legalName: string;
      bankCode: string;
      product: string;
      contactId: string;
    }
  ): Promise<ItemResult> {
    return this.result('intake_file_new_case', {
      p_actor: actor,
      p_account: account,
      p_item: itemId,
      p_trade_licence: input.tradeLicence,
      p_legal_name: input.legalName,
      p_bank_code: input.bankCode,
      p_product: input.product,
      p_contact: input.contactId,
      p_now: this.now(),
    });
  }

  reject(
    actor: string,
    account: string,
    itemId: string,
    reason: string
  ): Promise<ItemResult> {
    return this.result('intake_reject', {
      p_actor: actor,
      p_account: account,
      p_item: itemId,
      p_reason: reason,
      p_now: this.now(),
    });
  }

  retag(
    actor: string,
    account: string,
    itemId: string,
    tags: ItemTags
  ): Promise<ItemResult> {
    return this.result('intake_retag', {
      p_actor: actor,
      p_account: account,
      p_item: itemId,
      p_kind: tags.kind,
      p_bank_code: tags.bankCode,
      p_case_ref: tags.caseRef,
      p_company_name: tags.companyName,
      p_trade_licence: tags.tradeLicence,
      p_product: tags.product,
      p_contact: tags.contactId,
      p_doc_key: tags.docKey,
      p_note: tags.note,
      p_now: this.now(),
    });
  }

  async queue(
    actor: string,
    account: string,
    bankCode: string | null
  ): Promise<QueueItem[]> {
    const rows = await this.rpc('intake_queue_list', {
      p_actor: actor,
      p_account: account,
      p_bank_code: bankCode,
    });
    return rows.map((r) => ({
      ...tagsOf(r),
      itemId: String(r.item_id),
      uploadedBy: String(r.uploaded_by),
      receivedAt: String(r.received_at),
      ageSeconds: num(r.age_seconds) ?? 0,
      originalName: str(r.original_name),
      mime: str(r.mime),
      sizeBytes: num(r.size_bytes),
      hasFile: r.has_file === true,
      queueBankCode: str(r.queue_bank_code),
      queueReason: str(r.queue_reason),
    }));
  }

  async mine(actor: string, account: string, limit = 100): Promise<MyItem[]> {
    const rows = await this.rpc('intake_my_list', {
      p_actor: actor,
      p_account: account,
      p_limit: limit,
    });
    return rows.map((r) => ({
      ...tagsOf(r),
      itemId: String(r.item_id),
      receivedAt: String(r.received_at),
      state: String(r.state) as ItemState,
      caseId: str(r.case_id),
      caseNumber: str(r.case_number),
      originalName: str(r.original_name),
      fileId: str(r.file_id),
      queueBankCode: str(r.queue_bank_code),
      queueReason: str(r.queue_reason),
      rejectReason: str(r.reject_reason),
      duplicateOfItem: str(r.duplicate_of_item),
      duplicateOfUploader: str(r.duplicate_of_uploader),
    }));
  }

  async banks(actor: string, account: string): Promise<DeskBank[]> {
    const rows = await this.rpc('desk_bank_list', {
      p_actor: actor,
      p_account: account,
    });
    return rows.map((r) => ({
      bankCode: String(r.bank_code),
      bankName: String(r.bank_name),
      shortCode: str(r.short_code),
    }));
  }

  async setBankCode(
    actor: string,
    account: string,
    bankCode: string,
    shortCode: string
  ): Promise<void> {
    await this.rpc('desk_bank_code_set', {
      p_actor: actor,
      p_account: account,
      p_bank_code: bankCode,
      p_short: shortCode,
    });
  }

  async bankByShortCode(
    account: string,
    shortCode: string
  ): Promise<string | null> {
    const rows = await this.rpc('desk_bank_by_short', {
      p_account: account,
      p_short: shortCode,
    });
    const v = rows[0];
    if (v === undefined) return null;
    // A scalar RPC answers the value itself, not a row.
    return typeof v === 'string' ? v : str(Object.values(v)[0]);
  }

  async overview(actor: string, account: string): Promise<OverviewRow[]> {
    const rows = await this.rpc('intake_desk_overview', {
      p_actor: actor,
      p_account: account,
      p_now: this.now(),
    });
    return rows.map((r) => ({
      bankCode: str(r.bank_code),
      bankName: str(r.bank_name),
      shortCode: str(r.short_code),
      holders: num(r.holders) ?? 0,
      toSort: num(r.to_sort) ?? 0,
      oldestAgeSeconds: num(r.oldest_age_seconds),
      alert: String(r.alert) as OverviewRow['alert'],
    }));
  }

  async lookup(
    actor: string,
    account: string,
    ref: string
  ): Promise<CaseLookup | null> {
    const rows = await this.rpc('intake_case_lookup', {
      p_actor: actor,
      p_account: account,
      p_ref: ref,
    });
    const r = rows[0];
    if (!r) return null;
    return {
      caseId: String(r.case_id),
      caseNumber: str(r.case_number),
      bankCode: str(r.bank_code),
      companyName: str(r.company_name),
      contactId: str(r.contact_id),
      product: str(r.product),
      stage: String(r.stage),
    };
  }
}
