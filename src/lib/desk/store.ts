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

import type {
  DeskCompany,
  DeskCompanyContact,
  DeskContactRole,
} from './companies';
import { parseCoverRow, type BankCover } from './cover';
import {
  parseChecklist,
  parseCompanyOverview,
  type ApplicationChecklist,
  type CompanyOverview,
} from './shared-docs';
import {
  parseCandidates,
  type DeskSettings,
  type RouteDecision,
  type TrayItem,
  type TrayReason,
  type TrayState,
} from './tray';

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
  // 229: company contacts
  'CUSTOMER_NOT_FOUND',
  'CONTACT_INVALID',
  // 230: WhatsApp routing and the tray
  'TRAY_NOT_FOUND',
  'TRAY_NOT_OPEN',
  'CONFIRM_COMPANY',
  // 231: shared documents and reuse consent
  'FILE_NOT_FOUND',
  'CROSS_CUSTOMER',
  'CONSENT_MISSING',
  'CONSENT_NOT_FOUND',
  // 234: reminder digest
  'TEMPLATE_INVALID',
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

/** What waits for one person at the desk (migration 235). */
export interface DeskWorklist {
  tray: { count: number; oldestSeconds: number | null };
  queue: { count: number; oldestSeconds: number | null };
  mine: { count: number; oldestSeconds: number | null };
  tasks: { count: number; oldestSeconds: number | null };
}
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
  // ---------- company contacts (migration 229) ----------

  async findCompanies(
    actor: string,
    account: string,
    query: string
  ): Promise<DeskCompany[]> {
    const rows = await this.rpc('desk_customer_find', {
      p_actor: actor,
      p_account: account,
      p_query: query,
      p_limit: 20,
    });
    return rows.map((r) => ({
      customerId: String(r.customer_id),
      legalName: String(r.legal_name),
      tradeLicenceNo: String(r.trade_licence_no),
      appNumber: str(r.app_number),
      contacts: num(r.contacts) ?? 0,
      canManage: r.can_manage === true,
    }));
  }

  async companyContacts(
    actor: string,
    account: string,
    customerId: string
  ): Promise<DeskCompanyContact[]> {
    const rows = await this.rpc('desk_customer_contacts_list', {
      p_actor: actor,
      p_account: account,
      p_customer: customerId,
    });
    return rows.map((r) => ({
      contactId: String(r.contact_id),
      name: str(r.name),
      phone: str(r.phone),
      role: String(r.role) as DeskContactRole,
      authorised: r.authorised === true,
      automatic: r.automatic === true,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  /** Links (or updates) a contact; true when the link is new. */
  async setCompanyContact(
    actor: string,
    account: string,
    customerId: string,
    contactId: string,
    role: DeskContactRole,
    authorised: boolean
  ): Promise<boolean> {
    const rows = await this.rpc('desk_customer_contact_set', {
      p_actor: actor,
      p_account: account,
      p_customer: customerId,
      p_contact: contactId,
      p_role: role,
      p_authorised: authorised,
      p_now: this.now(),
    });
    return scalarTrue(rows[0]);
  }

  /** Unlinks a contact; true when a link was removed. */
  async removeCompanyContact(
    actor: string,
    account: string,
    customerId: string,
    contactId: string
  ): Promise<boolean> {
    const rows = await this.rpc('desk_customer_contact_remove', {
      p_actor: actor,
      p_account: account,
      p_customer: customerId,
      p_contact: contactId,
    });
    return scalarTrue(rows[0]);
  }
  // ---------- WhatsApp routing and the tray (migration 230) ----------

  async routeDocument(
    account: string,
    documentId: string,
    channelId: string | null
  ): Promise<RouteDecision> {
    const r = (
      await this.rpc('desk_route_customer_document', {
        p_account: account,
        p_document: documentId,
        p_channel: channelId,
        p_now: this.now(),
      })
    )[0];
    if (!r) throw new DeskStoreError('desk_route_customer_document', null);
    return {
      action: String(r.action) as RouteDecision['action'],
      caseId: str(r.case_id),
      trayId: str(r.tray_id),
      reason: str(r.reason) as TrayReason | null,
      staffUserId: str(r.staff_user_id),
    };
  }

  /** A desk upload that arrived by WhatsApp (220's intake, channel whatsapp). */
  whatsappIntake(
    actor: string,
    account: string,
    input: { itemId: string; idemKey: string; tags: ItemTags; file: ItemFile }
  ): Promise<ItemResult> {
    const { tags, file } = input;
    return this.result('desk_whatsapp_intake', {
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
      p_doc_key: tags.docKey,
      p_note: tags.note,
      p_storage_path: file.storagePath,
      p_original_name: file.originalName,
      p_mime: file.mime,
      p_size: file.sizeBytes,
      p_sha256: file.sha256,
      p_now: this.now(),
    });
  }

  async tray(
    actor: string,
    account: string,
    state: TrayState = 'open'
  ): Promise<TrayItem[]> {
    const rows = await this.rpc('desk_tray_list', {
      p_actor: actor,
      p_account: account,
      p_state: state,
      p_limit: 100,
      p_now: this.now(),
    });
    return rows.map((r) => ({
      trayId: String(r.tray_id),
      reason: String(r.reason) as TrayReason,
      candidates: parseCandidates(r.candidates),
      state: String(r.state) as TrayState,
      receivedAt: String(r.received_at),
      ageSeconds: num(r.age_seconds) ?? 0,
      escalatedAt: str(r.escalated_at),
      dutyUserId: str(r.duty_user_id),
      contactId: str(r.contact_id),
      contactName: str(r.contact_name),
      contactPhone: str(r.contact_phone),
      senderCompanies: Array.isArray(r.sender_companies)
        ? (r.sender_companies as { company: string; role: string }[])
        : [],
      documentKind: str(r.document_kind),
      mime: str(r.mime),
      originalName: str(r.original_name),
      caption: str(r.caption),
      mediaUrl: str(r.media_url),
      resolvedCaseId: str(r.resolved_case_id),
      dismissReason: str(r.dismiss_reason),
    }));
  }

  /** 'filed', or 'needs_copy' with the file to copy through the intake. */
  async trayFile(
    actor: string,
    account: string,
    trayId: string,
    caseId: string,
    confirmCompany: string | null
  ): Promise<{
    outcome: 'filed' | 'needs_copy';
    caseNumber: string | null;
    mediaUrl: string | null;
    mime: string | null;
    originalName: string | null;
  }> {
    const r = (
      await this.rpc('desk_tray_file', {
        p_actor: actor,
        p_account: account,
        p_tray: trayId,
        p_case: caseId,
        p_confirm_company: confirmCompany,
        p_now: this.now(),
      })
    )[0];
    if (!r) throw new DeskStoreError('desk_tray_file', null);
    return {
      outcome: r.outcome === 'filed' ? 'filed' : 'needs_copy',
      caseNumber: str(r.case_number),
      mediaUrl: str(r.media_url),
      mime: str(r.mime),
      originalName: str(r.original_name),
    };
  }

  async trayResolve(
    actor: string,
    account: string,
    trayId: string,
    caseId: string,
    itemId: string
  ): Promise<void> {
    await this.rpc('desk_tray_resolve', {
      p_actor: actor,
      p_account: account,
      p_tray: trayId,
      p_case: caseId,
      p_item: itemId,
      p_now: this.now(),
    });
  }

  async trayDismiss(
    actor: string,
    account: string,
    trayId: string,
    reason: string
  ): Promise<void> {
    await this.rpc('desk_tray_dismiss', {
      p_actor: actor,
      p_account: account,
      p_tray: trayId,
      p_reason: reason,
      p_now: this.now(),
    });
  }

  async settings(actor: string, account: string): Promise<DeskSettings> {
    const r = (
      await this.rpc('desk_settings_get', {
        p_actor: actor,
        p_account: account,
      })
    )[0];
    return {
      routingEnabled: r?.routing_enabled === true,
      deskChannelIds: Array.isArray(r?.desk_channel_ids)
        ? (r.desk_channel_ids as string[])
        : [],
      dutyUserId: str(r?.duty_user_id),
      escalateMinutes: num(r?.escalate_minutes) ?? 120,
      updatedAt: str(r?.updated_at),
    };
  }

  async setSettings(
    actor: string,
    account: string,
    input: {
      routingEnabled: boolean;
      deskChannelIds: string[];
      escalateMinutes: number;
    }
  ): Promise<void> {
    await this.rpc('desk_settings_set', {
      p_actor: actor,
      p_account: account,
      p_routing_enabled: input.routingEnabled,
      p_desk_channel_ids: input.deskChannelIds,
      p_escalate_minutes: input.escalateMinutes,
      p_now: this.now(),
    });
  }

  async setDuty(
    actor: string,
    account: string,
    userId: string | null
  ): Promise<void> {
    await this.rpc('desk_duty_set', {
      p_actor: actor,
      p_account: account,
      p_user: userId,
      p_now: this.now(),
    });
  }

  /** Service-role sweep: open items past their workspace's delay. */
  async dueEscalations(): Promise<
    {
      trayId: string;
      accountId: string;
      assignee: string | null;
      ageMinutes: number;
    }[]
  > {
    const rows = await this.rpc('desk_tray_due_escalation', {
      p_now: this.now(),
      p_limit: 200,
    });
    return rows.map((r) => ({
      trayId: String(r.tray_id),
      accountId: String(r.account_id),
      assignee: str(r.assignee),
      ageMinutes: num(r.age_minutes) ?? 0,
    }));
  }

  async markEscalated(trayId: string): Promise<boolean> {
    const rows = await this.rpc('desk_tray_mark_escalated', {
      p_tray: trayId,
      p_now: this.now(),
    });
    return scalarTrue(rows[0]);
  }
  // ---------- shared documents and reuse consent (migration 231) ----------

  async companyOverview(
    actor: string,
    account: string,
    customerId: string
  ): Promise<CompanyOverview> {
    const r = (
      await this.rpc('desk_company_overview', {
        p_actor: actor,
        p_account: account,
        p_customer: customerId,
      })
    )[0];
    return parseCompanyOverview(r);
  }

  async grantConsent(
    actor: string,
    account: string,
    customerId: string,
    bankCode: string,
    evidence: string
  ): Promise<void> {
    await this.rpc('desk_consent_grant', {
      p_actor: actor,
      p_account: account,
      p_customer: customerId,
      p_bank_code: bankCode,
      p_evidence: evidence,
      p_now: this.now(),
    });
  }

  async revokeConsent(
    actor: string,
    account: string,
    customerId: string,
    bankCode: string,
    reason: string
  ): Promise<void> {
    await this.rpc('desk_consent_revoke', {
      p_actor: actor,
      p_account: account,
      p_customer: customerId,
      p_bank_code: bankCode,
      p_reason: reason,
      p_now: this.now(),
    });
  }

  /** Links a file's document into another case of the company. */
  async linkDocument(
    actor: string,
    account: string,
    fileId: string,
    targetCaseId: string
  ): Promise<{ fileId: string; created: boolean }> {
    const r = (
      await this.rpc('desk_doc_link', {
        p_actor: actor,
        p_account: account,
        p_file: fileId,
        p_target: targetCaseId,
        p_now: this.now(),
      })
    )[0];
    if (!r) throw new DeskStoreError('desk_doc_link', null);
    return { fileId: String(r.file_id), created: r.created === true };
  }
  // ---------- cover and queue alerts (migration 232) ----------

  async coverList(actor: string, account: string): Promise<BankCover[]> {
    const rows = await this.rpc('desk_cover_list', {
      p_actor: actor,
      p_account: account,
      p_now: this.now(),
    });
    return rows.map(parseCoverRow);
  }

  async setBankRole(
    actor: string,
    account: string,
    bankCode: string,
    role: 'primary' | 'second',
    userId: string | null
  ): Promise<void> {
    await this.rpc('desk_bank_role_set', {
      p_actor: actor,
      p_account: account,
      p_bank: bankCode,
      p_role: role,
      p_user: userId,
      p_now: this.now(),
    });
  }

  async addLeave(
    actor: string,
    account: string,
    input: {
      userId: string;
      firstDay: string;
      lastDay: string;
      note: string | null;
    }
  ): Promise<string> {
    const rows = await this.rpc('desk_leave_add', {
      p_actor: actor,
      p_account: account,
      p_user: input.userId,
      p_first: input.firstDay,
      p_last: input.lastDay,
      p_note: input.note,
      p_now: this.now(),
    });
    const v = rows[0];
    return typeof v === 'string' ? v : String(Object.values(v ?? {})[0] ?? '');
  }

  async removeLeave(
    actor: string,
    account: string,
    leaveId: string
  ): Promise<boolean> {
    const rows = await this.rpc('desk_leave_remove', {
      p_actor: actor,
      p_account: account,
      p_leave: leaveId,
    });
    return scalarTrue(rows[0]);
  }

  /** Service-role sweep: sorting queues past 2 h / 4 h, with whom to tell. */
  async queueAlertsDue(): Promise<
    {
      accountId: string;
      bankCode: string | null;
      level: 'second' | 'lead';
      itemId: string;
      ageMinutes: number;
      waiting: number;
      assignee: string | null;
    }[]
  > {
    const rows = await this.rpc('desk_queue_alerts_due', { p_now: this.now() });
    return rows.map((r) => ({
      accountId: String(r.account_id),
      bankCode: str(r.bank_code),
      level: r.level === 'lead' ? 'lead' : 'second',
      itemId: String(r.item_id),
      ageMinutes: num(r.age_minutes) ?? 0,
      waiting: num(r.waiting) ?? 0,
      assignee: str(r.assignee),
    }));
  }
  // ---------- the application view (migration 233) ----------

  async applicationChecklist(
    actor: string,
    account: string,
    customerId: string
  ): Promise<ApplicationChecklist> {
    const r = (
      await this.rpc('desk_application_checklist', {
        p_actor: actor,
        p_account: account,
        p_customer: customerId,
      })
    )[0];
    return parseChecklist(r);
  }

  /** Service-role sweep: expiring, expired or replaced documents. */
  async docTasksDue(): Promise<
    {
      accountId: string;
      caseId: string;
      caseNumber: string | null;
      fileId: string;
      docKey: string | null;
      kind: 'expiring' | 'expired' | 'replaced';
      expiresOn: string | null;
      assignee: string | null;
    }[]
  > {
    const rows = await this.rpc('desk_doc_tasks_due', {
      p_now: this.now(),
      p_limit: 500,
    });
    return rows.map((r) => ({
      accountId: String(r.account_id),
      caseId: String(r.case_id),
      caseNumber: str(r.case_number),
      fileId: String(r.file_id),
      docKey: str(r.doc_key),
      kind: (['expiring', 'expired', 'replaced'].includes(String(r.kind))
        ? r.kind
        : 'expiring') as 'expiring' | 'expired' | 'replaced',
      expiresOn: str(r.expires_on),
      assignee: str(r.assignee),
    }));
  }
  // ---------- reminder digest (migration 234) ----------

  async digestSettings(
    actor: string,
    account: string
  ): Promise<{
    enabled: boolean;
    templateName: string | null;
    language: string;
    sendHour: number;
    gapDays: number;
  }> {
    const r = (
      await this.rpc('desk_digest_settings_get', {
        p_actor: actor,
        p_account: account,
      })
    )[0];
    return {
      enabled: r?.enabled === true,
      templateName: str(r?.template_name),
      language: str(r?.language) ?? 'en',
      sendHour: num(r?.send_hour) ?? 10,
      gapDays: num(r?.gap_days) ?? 2,
    };
  }

  async setDigestSettings(
    actor: string,
    account: string,
    input: {
      enabled: boolean;
      templateName: string | null;
      language: string;
      sendHour: number;
      gapDays: number;
    }
  ): Promise<void> {
    await this.rpc('desk_digest_settings_set', {
      p_actor: actor,
      p_account: account,
      p_enabled: input.enabled,
      p_template_name: input.templateName,
      p_language: input.language,
      p_send_hour: input.sendHour,
      p_gap_days: input.gapDays,
      p_now: this.now(),
    });
  }
  // ---------- the desk in My worklist (migration 235) ----------

  async worklist(actor: string, account: string): Promise<DeskWorklist> {
    const r = (
      await this.rpc('desk_worklist', {
        p_actor: actor,
        p_account: account,
        p_now: this.now(),
      })
    )[0];
    const o = (r && 'tray' in r ? r : (Object.values(r ?? {})[0] ?? {})) as Row;
    const part = (v: unknown) => {
      const x = (v ?? {}) as Row;
      return { count: num(x.count) ?? 0, oldestSeconds: num(x.oldest_seconds) };
    };
    return {
      tray: part(o.tray),
      queue: part(o.queue),
      mine: part(o.mine),
      tasks: part(o.tasks),
    };
  }
}

/** A scalar boolean RPC answers the value itself, not a row. */
function scalarTrue(v: unknown): boolean {
  if (v === true) return true;
  if (v && typeof v === 'object') return Object.values(v)[0] === true;
  return false;
}
