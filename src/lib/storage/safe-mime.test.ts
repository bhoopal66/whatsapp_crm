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
    'audio/x, text/html',
    'AUDIO/WEBM, TEXT/HTML',
    'audio/webm,text/html',
    'application/pdf;x=a,text/html',
    'application/pdf\n',
    'audio/webm\u0000',
    '\tapplication/pdf',
    'image/png\u007f',
    'video/mp4\u0085',
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

  const arrays = [...sql.matchAll(/ARRAY\[\n([\s\S]*?)\]::text\[\]/g)].map(
    (m) => [...m[1].matchAll(/'([^']+)'/g)].map((q) => q[1])
  );

  it('sets exactly the TS allowlist on the three private buckets', () => {
    expect(arrays).toHaveLength(2);
    const listed = [...arrays[0]];
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

  it('refuses in its trigger exactly what safeStoredMime would rewrite', () => {
    expect([...arrays[1]].sort()).toEqual([...SAFE_STORED_MIME_TYPES].sort());
    expect(sql).toContain(
      `v_bare ~ '^(${SAFE_STORED_MIME_WILDCARDS.join('|')})/[a-z0-9.+-]+$'`
    );
    expect(sql).toContain("strpos(v_type, ',') > 0");
    expect(sql).toContain("v_type ~ '[[:cntrl:]]'");
    expect(sql).toMatch(
      /BEFORE INSERT OR UPDATE ON storage\.objects\s+FOR EACH ROW\s+WHEN \(NEW\.bucket_id IN \('chat-files', 'deal-files', 'call-recordings'\)\)/
    );
  });
});
