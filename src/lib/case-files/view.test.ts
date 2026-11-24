import { describe, expect, it } from 'vitest';

import { CASE_FILE_MIME } from './checks';
import { MAX_UPLOAD_BYTES } from './intake-file';
import {
  CASE_FILE_MAX_BYTES,
  CASE_FILE_UPLOAD_MIME,
  buildCaseFilesView,
  buildErrorKey,
  buildState,
  caseFileErrorKey,
  checkFailureKey,
  checkFailures,
  filedElsewhere,
  formatFileSize,
  isAttachableDocument,
  parseCaseBuild,
  parseCaseFiles,
  parseDownloadUrl,
  shortHash,
  uploadProblem,
  validExpiry,
  reuseBody,
  reuseFailures,
  type CaseFileView,
} from './view';

const file = (over: Record<string, unknown> = {}) => ({
  id: 'f1',
  caseId: 'c1',
  customerDocumentId: 'd1',
  docKey: 'passport',
  version: 1,
  status: 'passed',
  classifySeq: 1,
  checks: [{ name: 'mime', ok: true, detail: null }],
  pages: 2,
  expiresOn: null,
  renamedName: 'PASSPORT_v1.pdf',
  registeredAt: '2026-11-01T10:00:00.000Z',
  document: {
    originalName: 'scan.pdf',
    mime: 'application/pdf',
    sizeBytes: 2048,
    source: 'chat',
  },
  ...over,
});

const spec = (docKey: string, position: number, over = {}) => ({
  docKey,
  position,
  namePattern: null,
  required: true,
  maxMb: null,
  allowedMime: null,
  minValidDays: null,
  merged: false,
  fromSpec: true,
  ...over,
});

const view = (files: unknown[], specs: unknown[], ready = false) => {
  const data = parseCaseFiles({ files, ready, spec: specs });
  if (!data) throw new Error('unparsed');
  return buildCaseFilesView(data);
};

describe('parseCaseFiles', () => {
  it('refuses a body without a files list', () => {
    expect(parseCaseFiles(null)).toBeNull();
    expect(parseCaseFiles('x')).toBeNull();
    expect(parseCaseFiles({ files: 'nope' })).toBeNull();
    expect(parseCaseFiles([])).toBeNull();
  });

  it('drops junk rows and keeps good ones', () => {
    const data = parseCaseFiles({
      files: [
        null,
        42,
        { id: 'x' },
        file({ status: 'archived' }),
        file({ id: '' }),
        file({
          id: 'ok',
          checks: [{ name: 'size', ok: false, detail: 'too_large' }, { ok: 1 }],
          document: null,
          version: 'two',
        }),
      ],
      ready: 'yes',
      spec: [spec('b', 2), { docKey: 7 }, spec('a', 1), 'junk'],
    });
    expect(data?.ready).toBe(false);
    expect(data?.files.map((f) => f.id)).toEqual(['ok']);
    const f = data!.files[0];
    expect(f.checks).toEqual([
      { name: 'size', ok: false, detail: 'too_large' },
    ]);
    expect(f.version).toBeNull();
    expect(f.originalName).toBeNull();
    expect(f.sizeBytes).toBeNull();
    expect(data?.spec.map((s) => s.docKey)).toEqual(['a', 'b']);
  });

  it('reads ready and a missing spec list', () => {
    const data = parseCaseFiles({ files: [], ready: true });
    expect(data).toEqual({ files: [], ready: true, spec: [] });
  });
});

describe('buildCaseFilesView', () => {
  it('shows a spec document with no file as missing', () => {
    const v = view([], [spec('passport', 1)]);
    expect(v.rows[0]).toMatchObject({
      chip: 'missing',
      current: null,
      history: [],
      failures: [],
    });
  });

  it('takes the newest non-superseded version as current', () => {
    const v = view(
      [
        file({ id: 'v1', version: 1, status: 'superseded' }),
        file({ id: 'v2', version: 2, status: 'passed' }),
      ],
      [spec('passport', 1)]
    );
    expect(v.rows[0].current?.id).toBe('v2');
    expect(v.rows[0].chip).toBe('passed');
    expect(v.rows[0].history.map((f) => f.id)).toEqual(['v1']);
  });

  it('lets a newer failed version outrank an older passed one', () => {
    const v = view(
      [
        file({ id: 'v1', version: 1, status: 'passed' }),
        file({
          id: 'v2',
          version: 2,
          status: 'failed',
          checks: [
            { name: 'mime', ok: true, detail: null },
            { name: 'resolution', ok: false, detail: 'low_resolution' },
          ],
        }),
      ],
      [spec('passport', 1)]
    );
    const row = v.rows[0];
    expect(row.current?.id).toBe('v2');
    expect(row.chip).toBe('failed');
    expect(row.failures).toEqual([
      { name: 'resolution', ok: false, detail: 'low_resolution' },
    ]);
    expect(row.history.map((f) => f.id)).toEqual(['v1']);
  });

  it('keeps a newer passed version current over an older failed one', () => {
    const v = view(
      [
        file({ id: 'v1', version: 1, status: 'failed' }),
        file({ id: 'v2', version: 2, status: 'passed' }),
      ],
      [spec('passport', 1)]
    );
    expect(v.rows[0].current?.id).toBe('v2');
    expect(v.rows[0].failures).toEqual([]);
  });

  it('shows a version still being checked as checking', () => {
    const v = view(
      [
        file({ id: 'v1', version: 1, status: 'passed' }),
        file({ id: 'p', version: null, status: 'pending_checks' }),
      ],
      [spec('passport', 1)]
    );
    expect(v.rows[0].current?.id).toBe('p');
    expect(v.rows[0].chip).toBe('checking');
  });

  it('shows only superseded files as missing', () => {
    const v = view([file({ status: 'superseded' })], [spec('passport', 1)]);
    expect(v.rows[0].chip).toBe('missing');
    expect(v.rows[0].history).toHaveLength(1);
  });

  it('lists unclassified files apart, newest first, in spec order', () => {
    const v = view(
      [
        file({ id: 'u1', docKey: null, status: 'unclassified', version: null }),
        file({
          id: 'u2',
          docKey: null,
          status: 'unclassified',
          version: null,
          registeredAt: '2026-11-02T10:00:00.000Z',
        }),
        file({ id: 'e', docKey: 'emirates_id' }),
      ],
      [spec('passport', 2), spec('emirates_id', 1, { required: false })]
    );
    expect(v.unclassified.map((f) => f.id)).toEqual(['u2', 'u1']);
    expect(v.rows.map((r) => r.spec.docKey)).toEqual([
      'emirates_id',
      'passport',
    ]);
    expect(v.rows[0].spec.required).toBe(false);
    expect(v.rows[1].chip).toBe('missing');
  });

  it('passes ready through', () => {
    expect(view([], [], true).ready).toBe(true);
  });
});

describe('check failures', () => {
  it('keeps only failed checks', () => {
    expect(checkFailures(null)).toEqual([]);
    expect(
      checkFailures([
        { name: 'mime', ok: true, detail: null },
        { name: 'size', ok: false, detail: 'too_large' },
      ])
    ).toEqual([{ name: 'size', ok: false, detail: 'too_large' }]);
  });

  it('names a failure by detail, then check, then generically', () => {
    for (const d of [
      'too_large',
      'low_resolution',
      'magic_mismatch',
      'unreadable',
      'expiring',
      'not_allowed',
    ])
      expect(checkFailureKey({ name: 'x', ok: false, detail: d })).toBe(
        `checks.detail.${d}`
      );
    expect(checkFailureKey({ name: 'expiry', ok: false, detail: 'odd' })).toBe(
      'checks.name.expiry'
    );
    expect(checkFailureKey({ name: 'novel', ok: false, detail: null })).toBe(
      'checks.other'
    );
  });
});

describe('sizes and uploads', () => {
  it('formats sizes', () => {
    expect(formatFileSize(null)).toBeNull();
    expect(formatFileSize(-1)).toBeNull();
    expect(formatFileSize(Number.NaN)).toBeNull();
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(2048)).toBe('2.0 KB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB');
  });

  it('matches the server mime list and ceiling', () => {
    expect([...CASE_FILE_UPLOAD_MIME]).toEqual([...CASE_FILE_MIME]);
    expect(CASE_FILE_MAX_BYTES).toBe(MAX_UPLOAD_BYTES);
  });

  it('flags a wrong type or an oversize file before sending', () => {
    expect(uploadProblem({ type: 'application/pdf', size: 10 })).toBeNull();
    expect(uploadProblem({ type: 'IMAGE/PNG', size: 10 })).toBeNull();
    expect(uploadProblem({ type: 'image/gif', size: 10 })).toBe('mime');
    expect(uploadProblem({ type: '', size: 10 })).toBe('mime');
    expect(
      uploadProblem({ type: 'image/jpeg', size: CASE_FILE_MAX_BYTES + 1 })
    ).toBe('size');
    expect(
      uploadProblem({ type: 'image/jpeg', size: CASE_FILE_MAX_BYTES })
    ).toBeNull();
  });

  it('offers PDFs and images with stored bytes for attach', () => {
    expect(
      isAttachableDocument({ mime: 'application/pdf', status: 'stored' })
    ).toBe(true);
    expect(
      isAttachableDocument({ mime: 'image/jpeg', status: 'pending' })
    ).toBe(true);
    expect(isAttachableDocument({ mime: 'image/png', status: 'failed' })).toBe(
      false
    );
    expect(isAttachableDocument({ mime: 'audio/ogg', status: 'stored' })).toBe(
      false
    );
    expect(isAttachableDocument({ mime: null, status: 'stored' })).toBe(false);
  });

  it('validates the optional expiry date', () => {
    expect(validExpiry('')).toBe(true);
    expect(validExpiry('2027-02-28')).toBe(true);
    expect(validExpiry('2027-02-30')).toBe(false);
    expect(validExpiry('28/02/2027')).toBe(false);
  });
});

describe('caseFileErrorKey', () => {
  it('maps known codes, then status, then generic', () => {
    expect(caseFileErrorKey(409, 'CASE_CLOSED')).toBe('errors.CASE_CLOSED');
    expect(caseFileErrorKey(422, 'MIME_NOT_ALLOWED')).toBe(
      'errors.MIME_NOT_ALLOWED'
    );
    expect(caseFileErrorKey(403, undefined)).toBe('errors.NOT_ALLOWED');
    expect(caseFileErrorKey(413, null)).toBe('errors.FILE_TOO_LARGE');
    expect(caseFileErrorKey(500, 'SOMETHING')).toBe('errors.generic');
    expect(caseFileErrorKey(0, undefined)).toBe('errors.generic');
  });
});

describe('filedElsewhere', () => {
  const body = { error: 'x', code: 'ALREADY_FILED_AS', filedAs: 'passport' };
  it('is the document named by the ALREADY_FILED_AS refusal', () => {
    expect(filedElsewhere(409, body)).toBe('passport');
  });
  it.each([
    [200, body],
    [409, { ...body, code: 'FILE_STATE' }],
    [409, { ...body, filedAs: undefined }],
    [409, { ...body, filedAs: 7 }],
    [0, null],
  ])('is null for any other answer (%s)', (status, json) => {
    expect(filedElsewhere(status, json)).toBeNull();
  });
  it('a refusal that names none is the generic toast', () => {
    expect(caseFileErrorKey(409, 'ALREADY_FILED_AS')).toBe(
      'errors.ALREADY_FILED_AS'
    );
  });
});

describe('case file build', () => {
  const build = (over: Record<string, unknown> = {}) => ({
    buildId: 'b1',
    version: 2,
    merged: true,
    manifest: [
      {
        position: 2,
        docKey: 'b',
        fileId: 'f2',
        renamedName: 'B.pdf',
        pages: 3,
        sha256: 'ab',
      },
      {
        position: 1,
        docKey: 'a',
        fileId: 'f1',
        renamedName: null,
        pages: null,
        sha256: 'cd',
      },
      { position: 3, docKey: '', fileId: 'f3' },
    ],
    sha256: 'x'.repeat(64),
    status: 'ready',
    builtAt: '2026-11-10T10:00:00Z',
    ...over,
  });

  it('parses a build, ordering and dropping bad manifest rows', () => {
    const r = parseCaseBuild({ build: build() });
    expect(r?.build?.manifest.map((m) => m.docKey)).toEqual(['a', 'b']);
    expect(r?.build?.merged).toBe(true);
  });

  it('tells none from unreadable', () => {
    expect(parseCaseBuild({ build: null })).toEqual({ build: null });
    expect(parseCaseBuild({})).toBeNull();
    expect(parseCaseBuild(null)).toBeNull();
    expect(parseCaseBuild({ build: build({ status: 'weird' }) })).toBeNull();
    expect(parseCaseBuild({ build: build({ version: 'x' }) })).toBeNull();
  });

  it('derives the state', () => {
    const ready = { status: 'ready' as const };
    expect(buildState(true, null)).toBe('none');
    expect(buildState(false, null)).toBe('none');
    expect(buildState(true, ready)).toBe('current');
    expect(buildState(false, ready)).toBe('stale');
    expect(buildState(true, { status: 'superseded' })).toBe('stale');
  });

  it('shortens a hash and maps refusals', () => {
    expect(shortHash('0123456789abcdef')).toBe('0123456789ab');
    expect(buildErrorKey(409, 'FILE_NOT_READY')).toBe(
      'buildErrors.FILE_NOT_READY'
    );
    expect(buildErrorKey(422, 'BUILD_TOO_LARGE')).toBe(
      'buildErrors.BUILD_TOO_LARGE'
    );
    expect(buildErrorKey(403, undefined)).toBe('buildErrors.NOT_ALLOWED');
    expect(buildErrorKey(501, 'NOT_CONFIGURED')).toBe(
      'buildErrors.NOT_CONFIGURED'
    );
    expect(buildErrorKey(500, 'NOPE')).toBe('buildErrors.generic');
  });

  it('accepts only http(s) download urls', () => {
    expect(parseDownloadUrl({ url: 'https://x.test/a?s=1' })).toBe(
      'https://x.test/a?s=1'
    );
    expect(parseDownloadUrl({ url: 'javascript:alert(1)' })).toBeNull();
    expect(parseDownloadUrl({ url: 'nope' })).toBeNull();
    expect(parseDownloadUrl(null)).toBeNull();
  });
});

describe('reuseBody (270)', () => {
  const file = (over: Partial<CaseFileView> = {}): CaseFileView => ({
    id: 'f1',
    customerDocumentId: 'd1',
    docKey: 'passport',
    version: 1,
    status: 'superseded',
    classifySeq: 1,
    checks: null,
    pages: null,
    expiresOn: null,
    renamedName: null,
    registeredAt: '2026-11-10T08:00:00Z',
    originalName: null,
    mime: null,
    sizeBytes: null,
    ...over,
  });
  it('is the file’s own type and expiry, for a replaced version only', () => {
    expect(reuseBody(file())).toEqual({ docKey: 'passport', reuse: true });
    expect(reuseBody(file({ expiresOn: '2030-01-01' }))).toEqual({
      docKey: 'passport',
      reuse: true,
      expiresOn: '2030-01-01',
    });
    for (const status of ['passed', 'failed', 'pending_checks'] as const)
      expect(reuseBody(file({ status }))).toBeNull();
    expect(reuseBody(file({ docKey: null }))).toBeNull();
  });
});

describe('reuseFailures', () => {
  const body = {
    code: 'REUSE_WOULD_FAIL',
    failedChecks: [{ name: 'expiry', ok: false, detail: 'expiring' }, 7],
  };
  it('is the failed checks in plain words, for that refusal only', () => {
    expect(reuseFailures(409, body)).toEqual([
      'checks.detail.expiring',
      'checks.other',
    ]);
    expect(reuseFailures(409, { ...body, code: 'FILE_STATE' })).toEqual([]);
    expect(reuseFailures(200, body)).toEqual([]);
    expect(reuseFailures(0, null)).toEqual([]);
  });
  it('and a store that did not answer have a message', () => {
    expect(caseFileErrorKey(503, 'STORAGE_UNAVAILABLE')).toBe(
      'errors.STORAGE_UNAVAILABLE'
    );
  });
});
