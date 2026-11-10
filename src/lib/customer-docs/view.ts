/**
 * Customer documents (migration 178) as the screens see them: the
 * customer page's Documents card and the inbox contact panel's row.
 * Pure, so the shaping is unit-tested; the route reads with the
 * caller's RLS client and hands the rows here.
 */
import { formatBytes } from '@/lib/chat/view';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import type { CustomerDocumentKind } from './record';

export type CustomerDocumentStatus =
  'pending' | 'stored' | 'duplicate' | 'failed';
export type CustomerDocumentSource = 'chat' | 'submission_group';

/** Newest first, at most this many per customer. */
export const DOCUMENTS_LIST_MAX = 200;
/** The card shows this many before "Show all". */
export const DOCUMENTS_SHOWN_FIRST = 10;

export const FOLDER_COLUMNS = 'ref, created_at, nas_created_at';
export const DOCUMENT_COLUMNS =
  'id, kind, mime, original_name, caption, nas_name, media_url, received_at, status, source, size_bytes';

export interface CustomerDocFolderView {
  ref: string;
  createdAt: string;
  /** The worker has made the NAS folder. */
  onNas: boolean;
}

export interface CustomerDocumentView {
  id: string;
  kind: CustomerDocumentKind;
  name: string | null;
  mime: string | null;
  sizeBytes: number | null;
  receivedAt: string;
  status: CustomerDocumentStatus;
  source: CustomerDocumentSource;
  url: string | null;
}

const STATUSES: readonly CustomerDocumentStatus[] = [
  'pending',
  'stored',
  'duplicate',
  'failed',
];

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v : null;

/** The NAS folder a reference lives in, as staff see it on the share. */
export const nasFolderPath = (ref: string) => `Customer Documents/${ref}`;

/** The file's name: the NAS name once stored, else what the customer sent. */
export function documentName(row: {
  nas_name?: unknown;
  original_name?: unknown;
  caption?: unknown;
}): string | null {
  return str(row.nas_name) ?? str(row.original_name) ?? str(row.caption);
}

/**
 * A link only for a file in Supabase Storage (the mirrored copy), made
 * browser-facing. A gateway link expires and may need the token, so it
 * is not offered.
 */
export function documentUrl(mediaUrl: unknown): string | null {
  const url = str(mediaUrl);
  if (!url || !url.includes('/storage/v1/object/')) return null;
  return toPublicSupabaseUrl(url);
}

export function folderView(row: unknown): CustomerDocFolderView | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const ref = str(r.ref);
  const createdAt = str(r.created_at);
  if (!ref || !createdAt) return null;
  return { ref, createdAt, onNas: str(r.nas_created_at) !== null };
}

/** A row as the card shows it, or null when a required column is off. */
export function documentView(row: unknown): CustomerDocumentView | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = str(r.id);
  const receivedAt = str(r.received_at);
  const kind = r.kind === 'image' || r.kind === 'document' ? r.kind : null;
  const status = STATUSES.includes(r.status as CustomerDocumentStatus)
    ? (r.status as CustomerDocumentStatus)
    : null;
  if (!id || !receivedAt || !kind || !status) return null;
  const size = Number(r.size_bytes);
  return {
    id,
    kind,
    name: documentName(r),
    mime: str(r.mime),
    sizeBytes:
      r.size_bytes !== null && r.size_bytes !== undefined && size >= 0
        ? size
        : null,
    receivedAt,
    status,
    source: r.source === 'submission_group' ? 'submission_group' : 'chat',
    url: documentUrl(r.media_url),
  };
}

export function documentsView(rows: unknown): CustomerDocumentView[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(documentView)
    .filter((d): d is CustomerDocumentView => d !== null);
}

/** The catalogue key and tone of a status chip. */
export function documentStatusView(status: CustomerDocumentStatus): {
  key: 'saved' | 'saving' | 'duplicate' | 'failed';
  tone: string;
} {
  switch (status) {
    case 'stored':
      return { key: 'saved', tone: 'bg-success-soft text-success' };
    case 'pending':
      return { key: 'saving', tone: 'bg-muted text-muted-foreground' };
    case 'duplicate':
      return { key: 'duplicate', tone: 'bg-info-soft text-info' };
    case 'failed':
      return {
        key: 'failed',
        tone: 'bg-destructive-soft text-destructive',
      };
    default: {
      const never: never = status;
      return never;
    }
  }
}

/** A human-readable size, or null when it is not known yet. */
export function formatDocumentSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  return formatBytes(bytes);
}

/** GET /api/contacts/[id]/documents, read in the browser. */
export function parseDocumentsResponse(json: unknown): {
  folder: CustomerDocFolderView | null;
  documents: CustomerDocumentView[];
} | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  if (!Array.isArray(j.documents)) return null;
  return {
    folder: parseFolder(j.folder),
    documents: j.documents.filter(isDocumentView),
  };
}

/** GET …/documents?summary=1, read in the browser. */
export function parseDocumentsSummary(json: unknown): {
  folder: CustomerDocFolderView | null;
  count: number;
} | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as Record<string, unknown>;
  const count = typeof j.count === 'number' && j.count >= 0 ? j.count : 0;
  return { folder: parseFolder(j.folder), count };
}

function parseFolder(v: unknown): CustomerDocFolderView | null {
  if (!v || typeof v !== 'object') return null;
  const f = v as Record<string, unknown>;
  return typeof f.ref === 'string' && typeof f.createdAt === 'string'
    ? { ref: f.ref, createdAt: f.createdAt, onNas: f.onNas === true }
    : null;
}

function isDocumentView(v: unknown): v is CustomerDocumentView {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.receivedAt === 'string' &&
    (d.kind === 'document' || d.kind === 'image') &&
    STATUSES.includes(d.status as CustomerDocumentStatus)
  );
}
