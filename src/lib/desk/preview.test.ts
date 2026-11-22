import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PREVIEW_URL_TTL_SECONDS,
  intakeObjectPath,
  isIntakeObjectPath,
  msUntilExpiry,
  parsePreviewLink,
  previewErrorKey,
  previewKind,
  previewRoute,
} from './preview';

const ITEM = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(64);

describe('previewKind', () => {
  it('shows PDFs in a frame and common images inline', () => {
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('Application/PDF; charset=binary')).toBe('pdf');
    for (const m of ['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
      expect(previewKind(m)).toBe('image');
  });

  it('falls back to the extension only for a missing or generic type', () => {
    expect(previewKind(null, 'scan.PDF')).toBe('pdf');
    expect(previewKind('application/octet-stream', 'id.jpeg')).toBe('image');
    expect(previewKind('', 'photo.png')).toBe('image');
    // A declared type wins over a misleading name.
    expect(previewKind('application/msword', 'cv.pdf')).toBe('other');
  });

  it('offers only a link for what a browser cannot show inline', () => {
    expect(previewKind('image/heic', 'a.heic')).toBe('other');
    expect(previewKind('text/html', 'x.html')).toBe('other');
    expect(previewKind(null, null)).toBe('other');
    expect(previewKind(null, 'notes')).toBe('other');
  });
});

describe('intake object paths (220)', () => {
  it("builds 'intake/<item>/<sha256>.<ext>' for 220's three types", () => {
    expect(intakeObjectPath(ITEM, SHA, 'application/pdf')).toBe(
      `intake/${ITEM}/${SHA}.pdf`
    );
    expect(intakeObjectPath(ITEM, SHA, 'image/jpeg')).toBe(
      `intake/${ITEM}/${SHA}.jpg`
    );
    expect(intakeObjectPath(ITEM, SHA, 'image/png')).toBe(
      `intake/${ITEM}/${SHA}.png`
    );
    expect(intakeObjectPath(ITEM, SHA, 'image/gif')).toBeNull();
  });

  it("accepts only this item's object", () => {
    expect(isIntakeObjectPath(`intake/${ITEM}/${SHA}.pdf`, ITEM)).toBe(true);
    expect(
      isIntakeObjectPath(
        `intake/${ITEM}/${SHA}.pdf`,
        '22222222-2222-4222-8222-222222222222'
      )
    ).toBe(false);
    for (const bad of [
      `intake/${ITEM}/../cases/x.pdf`,
      `/intake/${ITEM}/${SHA}.pdf`,
      `intake/${ITEM}/${SHA}.exe`,
      `intake/${ITEM}/${SHA.slice(1)}.pdf`,
      `cases/${ITEM}/${SHA}.pdf`,
      null,
      42,
    ])
      expect(isIntakeObjectPath(bad, ITEM)).toBe(false);
  });

  it("matches 220's storage_path CHECK", () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/220_case_desk.sql'),
      'utf8'
    );
    expect(sql).toContain(
      "storage_path = 'intake/' || id::text || '/' || sha256 || '.'"
    );
    expect(sql).toContain(
      "CASE mime WHEN 'application/pdf' THEN 'pdf' WHEN 'image/jpeg' THEN 'jpg' ELSE 'png' END"
    );
  });
});

describe('the preview routes and their answers', () => {
  it('names the route of each target, encoded', () => {
    expect(previewRoute({ type: 'intake', id: ITEM })).toBe(
      `/api/desk/intake/${ITEM}/preview`
    );
    expect(previewRoute({ type: 'tray', id: 'a/b' })).toBe(
      '/api/desk/tray/a%2Fb/preview'
    );
  });

  it('reads a link and works out its kind', () => {
    expect(
      parsePreviewLink({
        url: 'https://pub.example/storage/v1/object/sign/case-files/x?token=t',
        expiresAt: '2026-11-22T10:05:00.000Z',
        mime: 'application/pdf',
        name: 'licence.pdf',
      })
    ).toEqual({
      url: 'https://pub.example/storage/v1/object/sign/case-files/x?token=t',
      expiresAt: '2026-11-22T10:05:00.000Z',
      mime: 'application/pdf',
      name: 'licence.pdf',
      kind: 'pdf',
    });
  });

  it('refuses anything that is not an http(s) link', () => {
    for (const body of [
      null,
      'x',
      {},
      { url: 'javascript:alert(1)' },
      { url: 'data:text/html,x' },
      { url: 42 },
    ])
      expect(parsePreviewLink(body)).toBeNull();
  });

  it('maps failures to a plain message', () => {
    expect(previewErrorKey(501, 'NOT_CONFIGURED')).toBe('notConfigured');
    expect(previewErrorKey(404, 'ITEM_NOT_FOUND')).toBe('notFound');
    expect(previewErrorKey(404, 'TRAY_NOT_FOUND')).toBe('notFound');
    expect(previewErrorKey(404, 'FILE_NOT_FOUND')).toBe('notFound');
    expect(previewErrorKey(403, null)).toBe('notAllowed');
    expect(previewErrorKey(401, null)).toBe('notAllowed');
    expect(previewErrorKey(500, null)).toBe('generic');
    expect(previewErrorKey(null, null)).toBe('generic');
  });

  it('times a link out at its expiry, never for a public one', () => {
    const now = Date.parse('2026-11-22T10:00:00.000Z');
    expect(
      msUntilExpiry(
        new Date(now + PREVIEW_URL_TTL_SECONDS * 1000).toISOString(),
        now
      )
    ).toBe(300_000);
    expect(msUntilExpiry('2026-11-22T09:00:00.000Z', now)).toBe(0);
    expect(msUntilExpiry(null, now)).toBeNull();
    expect(msUntilExpiry('soon', now)).toBeNull();
  });
});
