import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  CHAT_FILE_MAX_BYTES,
  chatFilePath,
  sanitizeFileName,
  signedFileUrl,
  uploadChatFile,
  uploadChatFiles,
  validateChatFiles,
} from '../uploads';

const WS = 'AAAAAAAA-0000-4000-8000-000000000001';
const CH = 'BBBBBBBB-0000-4000-8000-000000000002';
// chat_post_message's own check, with the lower-case prefix it builds.
const PATH_RE =
  /^account-aaaaaaaa-0000-4000-8000-000000000001\/channel-bbbbbbbb-0000-4000-8000-000000000002\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]+$/;

function fakeStorage(error: unknown = null) {
  const uploads: { bucket: string; path: string; opts: unknown }[] = [];
  const sb = {
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _f: unknown, opts: unknown) => {
          uploads.push({ bucket, path, opts });
          return { data: error ? null : { path }, error };
        },
        createSignedUrl: async (path: string, expiresIn: number) => ({
          data: {
            signedUrl: `https://sb.test/storage/v1/object/sign/${bucket}/${path}?e=${expiresIn}`,
          },
          error: null,
        }),
      }),
    },
  };
  return { sb: sb as unknown as SupabaseClient, uploads };
}

const file = (name: string, size = 3, type = 'text/plain') => {
  const f = new File(['abc'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('paths', () => {
  it('build the 087 shape with lower-case ids and an ASCII-safe name', () => {
    const p = chatFilePath(WS, CH, 'تقرير Q3 (final).pdf');
    expect(p).toMatch(PATH_RE);
    expect(p.endsWith('-Q3_final_.pdf')).toBe(true);
  });

  it('sanitise names', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('.env')).toBe('env');
    expect(sanitizeFileName('عربي')).toBe('file');
    const long = sanitizeFileName(`${'a'.repeat(300)}.xlsx`);
    expect(long).toHaveLength(100);
    expect(long.endsWith('.xlsx')).toBe(true);
  });
});

describe('validation', () => {
  it('rejects more than 10 files or one over 25 MB before uploading', async () => {
    expect(() =>
      validateChatFiles(
        Array.from({ length: 11 }, () => ({ name: 'a', size: 1 }))
      )
    ).toThrow(
      expect.objectContaining({ code: 'INVALID', key: 'tooManyFiles' })
    );
    const { sb, uploads } = fakeStorage();
    await expect(
      uploadChatFiles(sb, {
        accountId: WS,
        channelId: CH,
        files: [file('a.txt'), file('big.bin', CHAT_FILE_MAX_BYTES + 1)],
      })
    ).rejects.toMatchObject({ code: 'INVALID', key: 'fileTooLarge' });
    expect(uploads).toEqual([]);
    expect(() =>
      validateChatFiles([{ name: 'ok', size: CHAT_FILE_MAX_BYTES }])
    ).not.toThrow();
  });
});

describe('upload / signed URL', () => {
  it('uploads to chat-files and returns the p_attachments element', async () => {
    const { sb, uploads } = fakeStorage();
    const att = await uploadChatFile(sb, {
      accountId: WS,
      channelId: CH,
      file: file('  تقرير.pdf ', 42, ''),
    });
    expect(uploads[0].bucket).toBe('chat-files');
    expect(uploads[0].opts).toMatchObject({
      upsert: false,
      contentType: 'application/octet-stream',
    });
    expect(att).toEqual({
      storage_path: uploads[0].path,
      name: 'تقرير.pdf',
      mime: 'application/octet-stream',
      bytes: 42,
    });
    expect(att.storage_path).toMatch(PATH_RE);
  });

  it('maps a storage RLS refusal to FORBIDDEN', async () => {
    const { sb } = fakeStorage({
      message: 'new row violates row-level security policy',
      statusCode: '403',
    });
    await expect(
      uploadChatFile(sb, { accountId: WS, channelId: CH, file: file('a.txt') })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('signs for 300 s by default', async () => {
    const { sb } = fakeStorage();
    expect(await signedFileUrl(sb, 'account-x/channel-y/z-a.txt')).toMatch(
      /e=300$/
    );
  });
});
