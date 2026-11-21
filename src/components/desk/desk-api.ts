/**
 * Browser calls of the case desk screen (`/api/desk/*`, migration 220).
 * Every call answers `{ ok: true, data }` or `{ ok: false, code, error }`
 * so the screen can show the server's wording and branch on the code.
 */
import type {
  CaseLookup,
  DeskBank,
  ItemResult,
  ItemTags,
  MyItem,
  OverviewRow,
  QueueItem,
} from '@/lib/desk/store';
import type { BankCover } from '@/lib/desk/cover';
import type {
  ApplicationChecklist,
  CompanyOverview,
} from '@/lib/desk/shared-docs';
import type { DeskSettings, TrayItem, TrayState } from '@/lib/desk/tray';
import type {
  DeskCompany,
  DeskCompanyContact,
  DeskContactRole,
} from '@/lib/desk/companies';

export interface DigestSettings {
  enabled: boolean;
  templateName: string | null;
  language: string;
  sendHour: number;
  gapDays: number;
}

export type DeskAnswer<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string | null; error: string };

async function call<T>(
  url: string,
  init: RequestInit | undefined,
  pick: (body: Record<string, unknown>) => T
): Promise<DeskAnswer<T>> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: typeof body.code === 'string' ? body.code : null,
        error:
          typeof body.error === 'string' ? body.error : 'Something went wrong',
      };
    return { ok: true, data: pick(body) };
  } catch {
    return { ok: false, status: 0, code: null, error: 'Network error' };
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const deskApi = {
  banks: () => call('/api/desk/banks', undefined, (b) => b.banks as DeskBank[]),
  setBankCode: (bankCode: string, shortCode: string) =>
    call(
      `/api/desk/banks/${encodeURIComponent(bankCode)}`,
      json('PUT', { shortCode }),
      () => true
    ),
  submit: (form: FormData) =>
    call(
      '/api/desk/intake',
      { method: 'POST', body: form },
      (b) => b.item as ItemResult
    ),
  mine: () => call('/api/desk/intake', undefined, (b) => b.items as MyItem[]),
  queue: () =>
    call('/api/desk/queue', undefined, (b) => b.items as QueueItem[]),
  overview: () =>
    call('/api/desk/overview', undefined, (b) => b.banks as OverviewRow[]),
  lookup: (ref: string) =>
    call(
      `/api/desk/lookup?ref=${encodeURIComponent(ref)}`,
      undefined,
      (b) => b.case as CaseLookup | null
    ),
  file: (
    itemId: string,
    body: {
      caseId: string;
      kind: 'pending_doc' | 'info';
      docKey: string | null;
    }
  ) =>
    call(
      `/api/desk/intake/${itemId}/file`,
      json('POST', body),
      (b) => b.item as ItemResult
    ),
  newCase: (
    itemId: string,
    body: {
      tradeLicence: string;
      legalName: string;
      bankCode: string;
      product: string;
      contactId: string;
    }
  ) =>
    call(
      `/api/desk/intake/${itemId}/new-case`,
      json('POST', body),
      (b) => b.item as ItemResult
    ),
  reject: (itemId: string, reason: string) =>
    call(
      `/api/desk/intake/${itemId}/reject`,
      json('POST', { reason }),
      (b) => b.item as ItemResult
    ),
  // Company contacts (migration 229)
  companies: (q: string) =>
    call(
      `/api/desk/companies?q=${encodeURIComponent(q)}`,
      undefined,
      (b) => b.companies as DeskCompany[]
    ),
  companyContacts: (customerId: string) =>
    call(
      `/api/desk/companies/${customerId}/contacts`,
      undefined,
      (b) => b.contacts as DeskCompanyContact[]
    ),
  setCompanyContact: (
    customerId: string,
    contactId: string,
    role: DeskContactRole,
    authorised: boolean
  ) =>
    call(
      `/api/desk/companies/${customerId}/contacts/${contactId}`,
      json('PUT', { role, authorised }),
      (b) => b.created === true
    ),
  removeCompanyContact: (customerId: string, contactId: string) =>
    call(
      `/api/desk/companies/${customerId}/contacts/${contactId}`,
      { method: 'DELETE' },
      (b) => b.removed === true
    ),
  // Reminder digest (migration 234)
  digest: () =>
    call('/api/desk/digest', undefined, (b) => b.settings as DigestSettings),
  saveDigest: (body: DigestSettings) =>
    call('/api/desk/digest', json('PUT', body), () => true),
  // Cover and leave (migration 232)
  cover: () =>
    call('/api/desk/cover', undefined, (b) => b.banks as BankCover[]),
  setBankRole: (
    bankCode: string,
    role: 'primary' | 'second',
    userId: string | null
  ) =>
    call(
      `/api/desk/cover/${encodeURIComponent(bankCode)}`,
      json('PUT', { role, userId }),
      () => true
    ),
  addLeave: (body: { userId: string; firstDay: string; lastDay: string }) =>
    call('/api/desk/leave', json('POST', body), () => true),
  removeLeave: (id: string) =>
    call(`/api/desk/leave/${id}`, { method: 'DELETE' }, () => true),
  // Shared documents and reuse consent (migration 231)
  companyOverview: (customerId: string) =>
    call(
      `/api/desk/companies/${customerId}/overview`,
      undefined,
      (b) => b.overview as CompanyOverview
    ),
  checklist: (customerId: string) =>
    call(
      `/api/desk/companies/${customerId}/checklist`,
      undefined,
      (b) => b.checklist as ApplicationChecklist
    ),
  grantConsent: (customerId: string, bankCode: string, evidence: string) =>
    call(
      `/api/desk/companies/${customerId}/consents/${encodeURIComponent(bankCode)}`,
      json('PUT', { evidence }),
      () => true
    ),
  revokeConsent: (customerId: string, bankCode: string, reason: string) =>
    call(
      `/api/desk/companies/${customerId}/consents/${encodeURIComponent(bankCode)}`,
      json('DELETE', { reason }),
      () => true
    ),
  linkDocument: (fileId: string, caseId: string) =>
    call(`/api/desk/files/${fileId}/link`, json('POST', { caseId }), (b) => ({
      created: b.created === true,
    })),
  // WhatsApp routing and the tray (migration 230)
  tray: (state: TrayState = 'open') =>
    call(
      `/api/desk/tray?state=${state}`,
      undefined,
      (b) => b.items as TrayItem[]
    ),
  trayFile: (trayId: string, caseId: string, confirmCompany: string | null) =>
    call(
      `/api/desk/tray/${trayId}/file`,
      json('POST', { caseId, confirmCompany }),
      (b) => ({ caseNumber: (b.caseNumber as string | null) ?? null })
    ),
  trayDismiss: (trayId: string, reason: string) =>
    call(
      `/api/desk/tray/${trayId}/dismiss`,
      json('POST', { reason }),
      () => true
    ),
  settings: () =>
    call('/api/desk/settings', undefined, (b) => ({
      settings: b.settings as DeskSettings,
      numbers: b.numbers as { id: string; label: string }[],
    })),
  saveSettings: (body: {
    routingEnabled: boolean;
    deskChannelIds: string[];
    escalateMinutes: number;
  }) => call('/api/desk/settings', json('PUT', body), () => true),
  setDuty: (userId: string | null) =>
    call('/api/desk/duty', json('PUT', { userId }), () => true),
  retag: (itemId: string, tags: ItemTags) =>
    call(
      `/api/desk/intake/${itemId}/retag`,
      json('POST', tags),
      (b) => b.item as ItemResult
    ),
};
