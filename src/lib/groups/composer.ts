/**
 * Pure helpers behind the group composer (`components/groups/
 * group-composer.tsx`): which kind a picked file is, the safe name it is
 * uploaded under, its size limit, and the `media` body the send route
 * takes (`outbound-media.ts`). No I/O.
 */

import { MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media';
import { PICKER_ACCEPT } from '@/lib/inbox/composer-ui';

import {
  GROUP_MEDIA_CAPTION_MAX,
  GROUP_MEDIA_FOLDER,
  type GroupOutboundKind,
} from './outbound-media';

/** What the composer hands its `onSendMedia`: the route's `media` body. */
export interface GroupMediaSendPayload {
  kind: GroupOutboundKind;
  url: string;
  path: string;
  caption?: string;
  filename?: string;
  mimeType?: string;
}

/** An uploaded attachment waiting in the composer. */
export interface GroupMediaDraft {
  kind: GroupOutboundKind;
  url: string;
  path: string;
  /** The name the person picked, shown and sent as the file name. */
  filename: string;
  mimeType: string;
  caption: string;
}

export type GroupPickerKind = Exclude<GroupOutboundKind, 'voice'>;

/** The picker's accept list for a kind (voice has no picker). */
export function groupPickerAccept(kind: GroupPickerKind): string {
  return PICKER_ACCEPT[kind];
}

/**
 * The kind a picked file is sent as: the menu's choice when the file's
 * type is on that picker's accept list (or the browser gave no type),
 * else the kind its type belongs to, else null (not sendable).
 */
export function groupFileKind(
  picked: GroupPickerKind,
  mimeType: string
): GroupPickerKind | null {
  const type = mimeType.trim().toLowerCase();
  if (!type) return picked;
  const kinds = [picked, 'image', 'video', 'document'] as const;
  for (const k of kinds) {
    if (PICKER_ACCEPT[k].split(',').includes(type)) return k;
  }
  return null;
}

/** The upload size limit for a kind, in bytes (a voice note is audio). */
export function groupMediaMaxBytes(kind: GroupOutboundKind): number {
  return MEDIA_MAX_BYTES_BY_KIND[kind === 'voice' ? 'audio' : kind];
}

/** Bytes as megabytes, one decimal at most, for the "too large" notice. */
export function megabytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
}

/**
 * The name a file is uploaded under. The send route accepts only one
 * name of `[A-Za-z0-9._-]`; `buildMediaPath` turns an odd extension into
 * `bin` (322 scan fix), so it is cleaned here first to keep "P D F" a
 * pdf rather than a bin.
 */
export function groupUploadName(name: string): string {
  const m = /^(.*)\.([^.]+)$/.exec(name);
  const base =
    (m ? m[1] : name).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 40) || 'file';
  const ext = m ? m[2].toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
  return `${base}.${ext.slice(0, 10) || 'bin'}`;
}

const UPLOAD_PATH = new RegExp(
  `^account-[^/]+/${GROUP_MEDIA_FOLDER}/[A-Za-z0-9_-][A-Za-z0-9._-]*$`
);

/** Whether a storage path is one the send route takes (any account). */
export function isGroupUploadPath(path: string): boolean {
  return UPLOAD_PATH.test(path);
}

/** A caption as sent: trimmed, at most the WhatsApp ceiling, or none. */
export function groupCaption(caption: string): string | undefined {
  const s = caption.trim().slice(0, GROUP_MEDIA_CAPTION_MAX).trim();
  return s || undefined;
}

/** The send route's `media` body for a draft (a voice note has no caption). */
export function groupMediaPayload(
  draft: GroupMediaDraft
): GroupMediaSendPayload {
  const caption =
    draft.kind === 'voice' ? undefined : groupCaption(draft.caption);
  return {
    kind: draft.kind,
    url: draft.url,
    path: draft.path,
    ...(caption ? { caption } : {}),
    ...(draft.filename ? { filename: draft.filename.slice(0, 255) } : {}),
    ...(draft.mimeType ? { mimeType: draft.mimeType } : {}),
  };
}
