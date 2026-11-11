// ============================================================
// Settings → Profile: "My WhatsApp" (migration 190).
//
// Which face the card shows, decided from `GET /api/whatsapp/personal`.
// Pure, so the card only renders it.
// ============================================================

export interface PersonalNumber {
  id: string;
  label: string | null;
  status: string;
  phone: string | null;
  connected_at: string | null;
  created_at: string;
}

export type ImportStatus =
  'queued' | 'listing' | 'running' | 'paused' | 'done' | 'failed';

const IMPORT_STATUSES: readonly string[] = [
  'queued',
  'listing',
  'running',
  'paused',
  'done',
  'failed',
];

/** Progress of the one-time chat history import (`personal_history_imports`). */
export interface PersonalImportProgress {
  status: ImportStatus;
  chats_done: number;
  chats_total: number;
  messages_imported: number;
  last_error: string | null;
  finished_at: string | null;
}

export interface PersonalNumberInfo {
  allowed: boolean;
  configured: boolean;
  number: PersonalNumber | null;
  import: PersonalImportProgress | null;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function parseImport(v: unknown): PersonalImportProgress | null {
  if (typeof v !== 'object' || v === null) return null;
  const i = v as Record<string, unknown>;
  if (typeof i.status !== 'string' || !IMPORT_STATUSES.includes(i.status)) {
    return null;
  }
  return {
    status: i.status as ImportStatus,
    chats_done: count(i.chats_done),
    chats_total: count(i.chats_total),
    messages_imported: count(i.messages_imported),
    last_error: typeof i.last_error === 'string' ? i.last_error : null,
    finished_at: typeof i.finished_at === 'string' ? i.finished_at : null,
  };
}

/** The card re-reads this often while the import is still moving. */
export const IMPORT_POLL_MS = 10_000;

export function isImportActive(p: PersonalImportProgress | null): boolean {
  return (
    p !== null &&
    (p.status === 'queued' || p.status === 'listing' || p.status === 'running')
  );
}

export type ImportLine =
  | { key: 'preparing' }
  | { key: 'running'; done: number; total: number; messages: number }
  | { key: 'paused' }
  | { key: 'done'; total: number; messages: number }
  | { key: 'failed'; error: string };

/** Which progress line to show, as a translation key plus its values. */
export function importLine(
  p: PersonalImportProgress | null
): ImportLine | null {
  if (!p) return null;
  switch (p.status) {
    case 'queued':
    case 'listing':
      return { key: 'preparing' };
    case 'running':
      return {
        key: 'running',
        done: p.chats_done,
        total: p.chats_total,
        messages: p.messages_imported,
      };
    case 'paused':
      return { key: 'paused' };
    case 'done':
      return {
        key: 'done',
        total: p.chats_total,
        messages: p.messages_imported,
      };
    case 'failed':
      return {
        key: 'failed',
        error: (p.last_error ?? '').trim().slice(0, 120) || 'unknown error',
      };
  }
}

export type MyWhatsAppView =
  | { kind: 'hidden' }
  | { kind: 'notConfigured' }
  | { kind: 'connect' }
  | { kind: 'connected'; number: PersonalNumber };

/**
 * `info` is null when the read failed or was refused (a bank guest's
 * 403): the card stays hidden rather than offer something that cannot
 * work. A number is always shown, even after the admin withdrew the
 * permission, so its owner can still disconnect it.
 */
export function myWhatsAppView(
  info: PersonalNumberInfo | null
): MyWhatsAppView {
  if (!info) return { kind: 'hidden' };
  if (info.number) return { kind: 'connected', number: info.number };
  if (!info.allowed) return { kind: 'hidden' };
  if (!info.configured) return { kind: 'notConfigured' };
  return { kind: 'connect' };
}

/** Reads the route's body defensively; null on any other shape. */
export function parsePersonalNumberInfo(
  body: unknown
): PersonalNumberInfo | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.allowed !== 'boolean' || typeof b.configured !== 'boolean') {
    return null;
  }
  const n = b.number as Record<string, unknown> | null | undefined;
  const number =
    n && typeof n === 'object' && typeof n.id === 'string'
      ? {
          id: n.id,
          label: typeof n.label === 'string' ? n.label : null,
          status: typeof n.status === 'string' ? n.status : 'disconnected',
          phone: typeof n.phone === 'string' ? n.phone : null,
          connected_at:
            typeof n.connected_at === 'string' ? n.connected_at : null,
          created_at: typeof n.created_at === 'string' ? n.created_at : '',
        }
      : null;
  return {
    allowed: b.allowed,
    configured: b.configured,
    number,
    import: number ? parseImport(b.import) : null,
  };
}

/** `send-message.ts`'s refusal of a send from someone else's own number. */
export function isPersonalNumberRefusal(
  status: number,
  payload: unknown
): boolean {
  return (
    status === 409 &&
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { code?: unknown }).code === 'personal_number'
  );
}

/** Numbers a route may point at: a person's own is never one. */
export function routableNumbers<T extends { is_personal?: boolean }>(
  numbers: readonly T[]
): T[] {
  return numbers.filter((n) => !n.is_personal);
}
