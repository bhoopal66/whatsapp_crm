import { describe, expect, it, vi } from 'vitest';

import { UnauthorizedError } from '@/lib/auth/account';
import { CaseHttpError } from '@/lib/cases/http';
import { CustomerDocumentRecordError } from '@/lib/customer-docs/record';

import {
  CASE_FILES_REFUSAL_HTTP,
  MAX_UPLOAD_REQUEST_BYTES,
  caseFilesErrorResponse,
  declaredTooLarge,
  parseAttachBody,
  parseClassifyBody,
  parseUploadForm,
  requireFileId,
} from './http';
import type { Check } from './checks';
import {
  CASE_FILES_REFUSALS,
  CaseFilesRefusedError,
  CaseFilesStoreError,
  type CaseFilesRefusal,
} from './store';

const DOC = '22222222-2222-4222-8222-222222222222';

const EXPECTED: Record<CaseFilesRefusal, number> = {
  NOT_ALLOWED: 403,
  CASE_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  CASE_CLOSED: 409,
  CHECK_MISMATCH: 409,
  FILE_STATE: 409,
  NO_CONTACT: 409,
  FILE_NOT_READY: 409,
  BUILD_INVALID: 409,
  BUILD_STALE: 409,
  BUILD_TOO_LARGE: 422,
  FORM_NOT_FLATTENED: 422,
  DOC_NOT_REQUIRED: 422,
  SPEC_INVALID: 422,
  SPEC_CHANGED: 409,
  DOCS_INVALID: 422,
  CHECKS_INVALID: 422,
  FILE_INVALID: 422,
  BANK_UNKNOWN: 422,
  SETTING_INVALID: 422,
  VALIDATION_FAILED: 422,
  MIME_NOT_ALLOWED: 422,
  FILE_TOO_LARGE: 413,
  STORAGE_UNAVAILABLE: 503,
  ALREADY_FILED_AS: 409,
  REUSE_WOULD_FAIL: 409,
};

function thrown(f: () => unknown): CaseHttpError {
  try {
    f();
  } catch (e) {
    if (e instanceof CaseHttpError) return e;
    throw e;
  }
  throw new Error('did not throw');
}

describe('refusal table', () => {
  it('covers every 181 hint and intake refusal', () => {
    for (const hint of CASE_FILES_REFUSALS)
      expect(CASE_FILES_REFUSAL_HTTP[hint]).toBeDefined();
    expect(Object.keys(CASE_FILES_REFUSAL_HTTP).sort()).toEqual(
      Object.keys(EXPECTED).sort()
    );
  });

  it.each(Object.entries(EXPECTED))(
    '%s answers %i with { error, code }',
    async (code, status) => {
      const res = caseFilesErrorResponse(
        new CaseFilesRefusedError(code as CaseFilesRefusal),
        't'
      );
      expect(res.status).toBe(status);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(typeof body.error).toBe('string');
    }
  );
});

describe('caseFilesErrorResponse', () => {
  it('names the document a file is already filed as, on that refusal only', async () => {
    const res = caseFilesErrorResponse(
      new CaseFilesRefusedError('ALREADY_FILED_AS', 'trade_licence'),
      't'
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'The file is already filed as another document',
      code: 'ALREADY_FILED_AS',
      filedAs: 'trade_licence',
    });
    const failedChecks: Check[] = [
      { name: 'expiry', ok: false, detail: 'expiring' },
    ];
    const reuse = caseFilesErrorResponse(
      new CaseFilesRefusedError('REUSE_WOULD_FAIL', undefined, failedChecks),
      't'
    );
    expect(await reuse.json()).toMatchObject({
      code: 'REUSE_WOULD_FAIL',
      failedChecks,
    });
    const other = caseFilesErrorResponse(
      new CaseFilesRefusedError('CASE_CLOSED'),
      't'
    );
    expect(await other.json()).not.toHaveProperty('filedAs');
  });

  it('answers 500 for a store failure, logging fn and SQLSTATE only', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = caseFilesErrorResponse(
      new CaseFilesStoreError('case_file_ready', '42P01'),
      't'
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Something went wrong' });
    expect(log).toHaveBeenCalledWith(
      '[cases] t store failure:',
      'case_file_ready',
      '42P01'
    );
    log.mockRestore();
  });

  it('maps the record step: INVALID 422, NOT_FOUND 409, other 500 without its text', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r1 = caseFilesErrorResponse(
      new CustomerDocumentRecordError('db text', 'INVALID', '22023'),
      't'
    );
    expect(r1.status).toBe(422);
    expect((await r1.json()).code).toBe('DOCUMENT_INVALID');
    const r2 = caseFilesErrorResponse(
      new CustomerDocumentRecordError('db text', 'NOT_FOUND', 'P0002'),
      't'
    );
    expect(r2.status).toBe(409);
    expect((await r2.json()).code).toBe('DOCUMENT_NOT_RECORDED');
    const r3 = caseFilesErrorResponse(
      new CustomerDocumentRecordError('secret db text', null, '57014'),
      't'
    );
    expect(r3.status).toBe(500);
    expect(JSON.stringify(await r3.json())).not.toContain('secret');
    log.mockRestore();
  });

  it('answers 401 for an unauthenticated caller and 500 for anything else', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(caseFilesErrorResponse(new UnauthorizedError(), 't').status).toBe(
      401
    );
    const res = caseFilesErrorResponse(new Error('db says x'), 't');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('db says');
    log.mockRestore();
  });
});

describe('declaredTooLarge', () => {
  const req = (len?: string) =>
    new Request('http://x', {
      method: 'POST',
      headers: len === undefined ? {} : { 'content-length': len },
    });
  it('is true only above 15 MiB', () => {
    expect(declaredTooLarge(req(String(MAX_UPLOAD_REQUEST_BYTES + 1)))).toBe(
      true
    );
    expect(declaredTooLarge(req(String(MAX_UPLOAD_REQUEST_BYTES)))).toBe(false);
    expect(declaredTooLarge(req())).toBe(false);
    expect(declaredTooLarge(req('abc'))).toBe(false);
  });
});

describe('parseAttachBody', () => {
  it('accepts a valid body', () => {
    expect(
      parseAttachBody({
        customerDocumentId: DOC,
        docKey: 'passport',
        expiresOn: '2027-02-28',
      })
    ).toEqual({
      customerDocumentId: DOC,
      docKey: 'passport',
      expiresOn: '2027-02-28',
    });
    expect(
      parseAttachBody({ customerDocumentId: DOC, docKey: 'x' }).expiresOn
    ).toBeNull();
  });

  it.each([
    [{ customerDocumentId: 'nope', docKey: 'x' }],
    [{ customerDocumentId: DOC }],
    [{ customerDocumentId: DOC, docKey: '   ' }],
    [{ customerDocumentId: DOC, docKey: 'x'.repeat(65) }],
    [{ customerDocumentId: DOC, docKey: 7 }],
    [{ customerDocumentId: DOC, docKey: 'x', expiresOn: '2026-02-30' }],
    [{ customerDocumentId: DOC, docKey: 'x', expiresOn: '30/01/2026' }],
  ])('refuses %o as 422 VALIDATION_FAILED', (body) => {
    const e = thrown(() => parseAttachBody(body));
    expect(e.status).toBe(422);
    expect(e.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('parseClassifyBody', () => {
  it('needs a docKey and a real date when given', () => {
    expect(parseClassifyBody({ docKey: 'salary' })).toEqual({
      docKey: 'salary',
      expiresOn: null,
    });
    expect(thrown(() => parseClassifyBody({})).status).toBe(422);
    expect(
      thrown(() => parseClassifyBody({ docKey: 'a', expiresOn: '2026-13-01' }))
        .status
    ).toBe(422);
  });
});

describe('parseUploadForm', () => {
  const file = () => new File([new Uint8Array([1])], 'a.pdf');
  it('reads the file and the optional fields', () => {
    const f = new FormData();
    f.set('file', file());
    expect(parseUploadForm(f)).toMatchObject({ docKey: null, expiresOn: null });
    f.set('docKey', 'passport');
    f.set('expiresOn', '2030-01-01');
    expect(parseUploadForm(f)).toMatchObject({
      docKey: 'passport',
      expiresOn: '2030-01-01',
    });
  });

  it('is 400 without a form or a file part, 422 for a bad field', () => {
    expect(thrown(() => parseUploadForm(null)).status).toBe(400);
    const f = new FormData();
    f.set('file', 'text, not a file');
    expect(thrown(() => parseUploadForm(f)).status).toBe(400);
    f.set('file', file());
    f.set('expiresOn', 'tomorrow');
    expect(thrown(() => parseUploadForm(f)).status).toBe(422);
  });
});

describe('moveFrom', () => {
  it.each(['passport', '', null, undefined])(
    'is the document named, or absent (%s)',
    (moveFrom) => {
      const expected = moveFrom ? { moveFrom } : {};
      const common = { docKey: 'x', expiresOn: null, ...expected };
      const body = { customerDocumentId: DOC, docKey: 'x', moveFrom };
      expect(parseClassifyBody(body)).toEqual(common);
      expect(parseAttachBody(body)).toEqual({
        customerDocumentId: DOC,
        ...common,
      });
      const f = new FormData();
      f.set('file', new File([new Uint8Array([1])], 'a.pdf'));
      if (typeof moveFrom === 'string') f.set('moveFrom', moveFrom);
      expect(parseUploadForm(f).moveFrom).toBe(moveFrom || undefined);
    }
  );

  it('is refused when it is not a document key', () => {
    expect(() => parseClassifyBody({ docKey: 'x', moveFrom: true })).toThrow();
  });
});

describe('reuse', () => {
  it('is there only when true, and refused when it is not a boolean', () => {
    const base = { docKey: 'x', expiresOn: null };
    expect(parseClassifyBody({ docKey: 'x', reuse: true })).toEqual({
      ...base,
      reuse: true,
    });
    for (const reuse of [undefined, null, false])
      expect(parseClassifyBody({ docKey: 'x', reuse })).toStrictEqual(base);
    const bad = () => parseClassifyBody({ docKey: 'x', reuse: 'true' });
    expect(thrown(bad).status).toBe(422);
  });
});

describe('requireFileId', () => {
  it('404s a non-uuid file id', () => {
    expect(requireFileId(DOC)).toBe(DOC);
    const e = thrown(() => requireFileId('../x'));
    expect(e.status).toBe(404);
    expect(e.body.code).toBe('FILE_NOT_FOUND');
  });
});
