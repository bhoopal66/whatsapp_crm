import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_STORED_MIME,
  SAFE_STORED_MIME_TYPES,
  SAFE_STORED_MIME_WILDCARDS,
  safeStoredMime,
} from './safe-mime';

describe('safeStoredMime', () => {
  it.each([
    'text/html',
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/xml',
    'application/xml',
    'text/javascript',
    'application/javascript',
    'application/x-msdownload',
    'audio/',
    'audio/x webm',
    'nonsense',
    '',
    '   ',
    null,
    undefined,
  ])('stores %j as octet-stream', (mime) => {
    expect(safeStoredMime(mime)).toBe(FALLBACK_STORED_MIME);
  });

  it.each([
    ['image/png', 'image/png'],
    ['IMAGE/JPEG', 'image/jpeg'],
    ['  application/pdf  ', 'application/pdf'],
    ['audio/webm;codecs=opus', 'audio/webm'],
    ['audio/ogg; codecs=opus', 'audio/ogg'],
    ['audio/x-gsm', 'audio/x-gsm'],
    ['video/mp4', 'video/mp4'],
    ['text/plain; charset=utf-8', 'text/plain'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  ])('keeps %j as %j', (mime, want) => {
    expect(safeStoredMime(mime)).toBe(want);
  });

  it('never lists a type a browser renders as a page', () => {
    for (const t of SAFE_STORED_MIME_TYPES) {
      expect(t).not.toMatch(/html|svg|javascript|ecmascript|(^|\/|\+)xml$/);
      expect(safeStoredMime(t)).toBe(t);
    }
  });
});

describe('migration 164', () => {
  const sql = readFileSync(
    join(process.cwd(), 'supabase/migrations/164_storage_safe_mime.sql'),
    'utf8'
  );

  it('sets exactly the TS allowlist on the three private buckets', () => {
    const body = sql.match(/ARRAY\[([\s\S]*?)\]::text\[\]/);
    expect(body).not.toBeNull();
    const listed = [...body![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(listed.sort()).toEqual(
      [
        ...SAFE_STORED_MIME_WILDCARDS.map((w) => `${w}/*`),
        ...SAFE_STORED_MIME_TYPES,
      ].sort()
    );
    expect(sql).toMatch(
      /WHERE id IN \('chat-files', 'deal-files', 'call-recordings'\)/
    );
  });
});
