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
  retag: (itemId: string, tags: ItemTags) =>
    call(
      `/api/desk/intake/${itemId}/retag`,
      json('POST', tags),
      (b) => b.item as ItemResult
    ),
};
