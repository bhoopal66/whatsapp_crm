/**
 * Attachments in the PRIVATE `chat-files` bucket (087). Objects live at
 * account-<ws>/channel-<ch>/<uuid>-<name>; the storage policies let a
 * poster upload and a reader read. chat_post_message re-checks the path
 * shape and that the object exists, comparing against lower-case ids.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { toPublicSupabaseUrl } from '@/lib/supabase/urls';

import { ChatError } from './errors';
import type { AttachmentInput } from './types';

export const CHAT_FILES_BUCKET = 'chat-files';
/** 25 MB: the bucket's file_size_limit and chat_post_message's cap. */
export const CHAT_FILE_MAX_BYTES = 26214400;
export const CHAT_MAX_ATTACHMENTS = 10;

/** ASCII-safe object-name part (Storage rejects many characters); the display name keeps the original. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const safe = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '');
  if (!safe) return 'file';
  if (safe.length <= 100) return safe;
  const dot = safe.lastIndexOf('.');
  const ext = dot > 0 ? safe.slice(dot, dot + 16) : '';
  return safe.slice(0, 100 - ext.length) + ext;
}

export function chatFilePath(
  accountId: string,
  channelId: string,
  fileName: string,
  id: string = crypto.randomUUID()
): string {
  return `account-${accountId.toLowerCase()}/channel-${channelId.toLowerCase()}/${id.toLowerCase()}-${sanitizeFileName(fileName)}`;
}

/** Throws ChatError INVALID (tooManyFiles / fileTooLarge) before anything is uploaded. */
export function validateChatFiles(
  files: readonly { name: string; size: number }[]
): void {
  if (files.length > CHAT_MAX_ATTACHMENTS)
    throw new ChatError(
      'INVALID',
      'tooManyFiles',
      `at most ${CHAT_MAX_ATTACHMENTS} files per message`
    );
  const big = files.find((f) => f.size > CHAT_FILE_MAX_BYTES);
  if (big)
    throw new ChatError(
      'INVALID',
      'fileTooLarge',
      `${big.name} is larger than 25 MB`
    );
}

export async function uploadChatFile(
  sb: SupabaseClient,
  i: { accountId: string; channelId: string; file: File }
): Promise<AttachmentInput> {
  validateChatFiles([i.file]);
  const path = chatFilePath(i.accountId, i.channelId, i.file.name);
  const mime = i.file.type.trim() || 'application/octet-stream';
  const { error } = await sb.storage
    .from(CHAT_FILES_BUCKET)
    .upload(path, i.file, {
      contentType: mime,
      upsert: false,
      cacheControl: '3600',
    });
  if (error) {
    const status = String((error as { statusCode?: unknown }).statusCode ?? '');
    const forbidden =
      status === '403' ||
      /row-level security|unauthori[sz]ed/i.test(error.message);
    throw new ChatError(
      forbidden ? 'FORBIDDEN' : status === '413' ? 'INVALID' : 'UNKNOWN',
      forbidden
        ? 'forbidden'
        : status === '413'
          ? 'fileTooLarge'
          : 'uploadFailed',
      error.message,
      undefined,
      { cause: error }
    );
  }
  const name = i.file.name.trim().slice(0, 255) || 'file';
  return { storage_path: path, name, mime, bytes: i.file.size };
}

/** Validates the whole batch first, then uploads in parallel; the result goes to postMessage. */
export async function uploadChatFiles(
  sb: SupabaseClient,
  i: { accountId: string; channelId: string; files: File[] }
): Promise<AttachmentInput[]> {
  validateChatFiles(i.files);
  return Promise.all(i.files.map((file) => uploadChatFile(sb, { ...i, file })));
}

/** A short-lived URL for one object, on the browser-facing origin. */
export async function signedFileUrl(
  sb: SupabaseClient,
  storagePath: string,
  expiresIn = 300
): Promise<string> {
  const { data, error } = await sb.storage
    .from(CHAT_FILES_BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data?.signedUrl)
    throw new ChatError(
      'NOT_FOUND',
      'notFound',
      error?.message ?? 'no signed URL',
      undefined,
      {
        cause: error,
      }
    );
  return toPublicSupabaseUrl(data.signedUrl);
}
