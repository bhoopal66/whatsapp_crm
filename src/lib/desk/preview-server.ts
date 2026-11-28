/**
 * File preview while sorting (U5, migration 248): the server part.
 *
 * Order (182's audit contract): the SQL function checks access and writes
 * the `desk_file_previews` row in the same call, and only then does the
 * route sign a URL here. A signed URL is never logged, stored or put in
 * an error: a signing failure is a DeskStoreError naming the function.
 *
 * TENANCY: the routes pass the caller's ACTIVE account; both functions
 * confine themselves to it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { chatMediaObjectPath } from '@/lib/case-files/bytes';
import type { CaseFilesSigner } from '@/lib/case-files/download';
import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import { isIntakeObjectPath, PREVIEW_URL_TTL_SECONDS } from './preview';
import {
  DESK_REFUSALS,
  DeskRefusedError,
  DeskStoreError,
  type DeskRefusal,
} from './store';

const CASE_FILES_BUCKET = 'case-files';
const REFUSALS: ReadonlySet<string> = new Set(DESK_REFUSALS);

export interface IntakePreviewFile {
  storagePath: string;
  mime: string | null;
  originalName: string | null;
}

export interface TrayPreviewFile {
  storageBucket: string | null;
  storagePath: string | null;
  mediaUrl: string | null;
  mime: string | null;
  originalName: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export class DeskPreviewStore {
  constructor(private readonly db: SupabaseClient) {}

  private async one(fn: string, args: Record<string, unknown>): Promise<Row> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) {
      const e = error as { code?: string; hint?: string | null };
      if (typeof e.hint === 'string' && REFUSALS.has(e.hint))
        throw new DeskRefusedError(e.hint as DeskRefusal);
      throw new DeskStoreError(fn, e.code ?? null);
    }
    const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
    if (!row) throw new DeskStoreError(fn, null);
    return row;
  }

  /** The intake item's file; writes the audit row (220's scope or uploader). */
  async intake(
    actor: string,
    account: string,
    itemId: string,
    now: Date
  ): Promise<IntakePreviewFile> {
    const r = await this.one('intake_file_for_preview', {
      p_actor: actor,
      p_account: account,
      p_item: itemId,
      p_now: now.toISOString(),
    });
    const storagePath = str(r.storage_path);
    if (!storagePath) throw new DeskRefusedError('FILE_NOT_FOUND');
    return {
      storagePath,
      mime: str(r.mime),
      originalName: str(r.original_name),
    };
  }

  /** The open tray item's document; writes the audit row (sorters only). */
  async tray(
    actor: string,
    account: string,
    trayId: string,
    now: Date
  ): Promise<TrayPreviewFile> {
    const r = await this.one('desk_tray_file_for_preview', {
      p_actor: actor,
      p_account: account,
      p_tray: trayId,
      p_now: now.toISOString(),
    });
    return {
      storageBucket: str(r.storage_bucket),
      storagePath: str(r.storage_path),
      mediaUrl: str(r.media_url),
      mime: str(r.mime),
      originalName: str(r.original_name),
    };
  }
}

/** Every preview answer: never cached by the browser or a proxy. */
export function noStore<T extends Response>(res: T): T {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/** 501: this install cannot sign storage URLs. */
export function notConfigured(): Response {
  return noStore(
    Response.json(
      { error: 'File previews are not configured', code: 'NOT_CONFIGURED' },
      { status: 501 }
    )
  );
}

export interface SignedPreview {
  url: string;
  expiresAt: string | null;
}

/** A relative path inside the bucket, with no '..' segment. */
function safeObjectPath(path: string | null): path is string {
  return !!path && !path.startsWith('/') && !path.split('/').includes('..');
}

async function signCaseFiles(
  signer: CaseFilesSigner,
  objectPath: string,
  now: Date,
  bucket: string = CASE_FILES_BUCKET
): Promise<SignedPreview> {
  let signed: { data: { signedUrl: string } | null; error: unknown };
  try {
    signed = await signer
      .from(bucket)
      .createSignedUrl(objectPath, PREVIEW_URL_TTL_SECONDS);
  } catch {
    throw new DeskStoreError('storage.createSignedUrl', null);
  }
  if (signed.error || !signed.data?.signedUrl)
    throw new DeskStoreError('storage.createSignedUrl', null);
  return {
    url: toPublicSupabaseUrl(signed.data.signedUrl),
    expiresAt: new Date(
      now.getTime() + PREVIEW_URL_TTL_SECONDS * 1000
    ).toISOString(),
  };
}

/** A 300 s URL for an intake object of this item, else null. */
export async function intakePreviewUrl(
  itemId: string,
  file: IntakePreviewFile,
  signer: CaseFilesSigner,
  now: Date
): Promise<SignedPreview | null> {
  if (!isIntakeObjectPath(file.storagePath, itemId)) return null;
  return signCaseFiles(signer, file.storagePath, now);
}

/**
 * A tray document's URL: a 'case-files' object, and a chat-media object
 * (private since migration 321), are signed for 300 s; anything else has
 * no preview (null), so the server never hands out an arbitrary link.
 */
export async function trayPreviewUrl(
  file: TrayPreviewFile,
  signer: CaseFilesSigner,
  now: Date
): Promise<SignedPreview | null> {
  if (file.storageBucket === CASE_FILES_BUCKET) {
    if (!safeObjectPath(file.storagePath)) return null;
    return signCaseFiles(signer, file.storagePath, now);
  }
  if (file.storageBucket) return null;
  const chatPath = file.mediaUrl ? chatMediaObjectPath(file.mediaUrl) : null;
  if (!chatPath) return null;
  return signCaseFiles(signer, chatPath, now, 'chat-media');
}
