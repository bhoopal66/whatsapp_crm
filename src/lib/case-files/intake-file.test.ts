import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { readDocument, readDocumentBytes } from './bytes';
import {
  attachCustomerDocument,
  classifyAndCheck,
  uploadStaffFile,
} from './intake-file';
import {
  CaseFilesRefusedError,
  CaseFilesStore,
  CaseFilesStoreError,
} from './store';
import { fakeAdmin, fakeStorage, ok, refuse } from './test-fakes';

const CASE = 'c0000000-0000-4000-8000-000000000001';
const FILE = 'f0000000-0000-4000-8000-000000000001';
const DOC = 'd0000000-0000-4000-8000-000000000001';
const ACTOR = 'a0000000-0000-4000-8000-000000000001';
const clock = () => new Date('2026-11-10T08:00:00Z');

async function pdfBytes() {
  const d = await PDFDocument.create();
  d.addPage();
  return new Uint8Array(await d.save());
}

const fileRow = {
  id: FILE,
  case_id: CASE,
  customer_document_id: DOC,
  doc_key: 'passport',
  version: 1,
  status: 'passed',
  classify_seq: 1,
  checks: [],
  pages: 1,
  expires_on: null,
  renamed_name: 'x.pdf',
  registered_at: '2026-11-10T08:00:00Z',
  customer_documents: {
    original_name: 'p.pdf',
    mime: 'application/pdf',
    size_bytes: 10,
    source: 'chat',
  },
};
const docRow = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  contact_id: 'k1',
  source: 'chat',
  kind: 'document',
  mime: 'application/pdf',
  original_name: 'p.pdf',
  media_url:
    'https://crm.example/supabase/storage/v1/object/public/chat-media/account-1/inbound/p.pdf',
  storage_bucket: null,
  storage_path: null,
  sha256: null,
  size_bytes: 10,
  status: 'filed',
  ...over,
});
const specRow = {
  doc_key: 'passport',
  position: 1,
  name_pattern: '{{doc}}',
  required: true,
  max_mb: 10,
  allowed_mime: ['application/pdf'],
  min_valid_days: null,
  merged: false,
  from_spec: true,
};
const cls = ok([{ classify_seq: 7, version: 1, renamed_name: 'passport.pdf' }]);

describe('store hint mapping', () => {
  it('maps a known hint to CaseFilesRefusedError and keeps SQLSTATE otherwise', async () => {
    const s1 = new CaseFilesStore(
      fakeAdmin({ case_file_ready: refuse('CASE_NOT_FOUND') }).admin
    );
    await expect(s1.fileReady(CASE)).rejects.toMatchObject({
      name: 'CaseFilesRefusedError',
      reason: 'CASE_NOT_FOUND',
    });
    const s2 = new CaseFilesStore(
      fakeAdmin({ case_file_ready: refuse('SOMETHING_ELSE', '40P01') }).admin
    );
    const err = await s2.fileReady(CASE).catch((e) => e);
    expect(err).toBeInstanceOf(CaseFilesStoreError);
    expect(err.code).toBe('40P01');
  });
});

describe('readDocumentBytes', () => {
  it('reads a prefixed public chat-media URL from the internal base', async () => {
    const f = vi.fn<typeof fetch>(
      async () => new Response(new Uint8Array([1, 2, 3]))
    );
    const out = await readDocumentBytes(
      { mediaUrl: docRow().media_url, storageBucket: null, storagePath: null },
      {
        storage: fakeStorage({}).storage,
        fetch: f as unknown as typeof fetch,
        internalBaseUrl: 'http://localhost:8000/',
      }
    );
    expect(Array.from(out!)).toEqual([1, 2, 3]);
    expect(f.mock.calls[0][0]).toBe(
      'http://localhost:8000/storage/v1/object/public/chat-media/account-1/inbound/p.pdf'
    );
  });
  it('reads a case-files storage pair through the storage client', async () => {
    const st = fakeStorage({
      objects: { 'case-files/cases/x.pdf': new Uint8Array([9]) },
    });
    const out = await readDocumentBytes(
      {
        mediaUrl: null,
        storageBucket: 'case-files',
        storagePath: 'cases/x.pdf',
      },
      { storage: st.storage }
    );
    expect(Array.from(out!)).toEqual([9]);
  });
  it('never fetches an arbitrary URL', async () => {
    const f = vi.fn();
    const out = await readDocumentBytes(
      {
        mediaUrl: 'https://evil.example/file.pdf',
        storageBucket: null,
        storagePath: null,
      },
      {
        storage: fakeStorage({}).storage,
        fetch: f as unknown as typeof fetch,
        internalBaseUrl: 'http://i',
      }
    );
    expect(out).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe('readDocument', () => {
  const chat = {
    mediaUrl:
      'https://crm.example/supabase/storage/v1/object/public/chat-media/a/p.pdf',
    storageBucket: null,
    storagePath: null,
  };
  const kept = {
    mediaUrl: null,
    storageBucket: 'case-files',
    storagePath: 'cases/c/x.pdf',
  };
  const viaFetch = (f: () => Promise<Response>) =>
    readDocument(chat, {
      storage: fakeStorage({}).storage,
      fetch: f as unknown as typeof fetch,
      internalBaseUrl: 'http://i',
    });
  const viaStorage = (downloadError: unknown) =>
    readDocument(kept, { storage: fakeStorage({ downloadError }).storage });

  it.each([400, 403, 404])('HTTP %i is unreadable', async (status) => {
    expect(await viaFetch(async () => new Response('x', { status }))).toEqual({
      kind: 'unreadable',
    });
  });
  it.each([408, 429, 500, 502, 503])(
    'HTTP %i is unavailable',
    async (status) => {
      expect(await viaFetch(async () => new Response('x', { status }))).toEqual(
        { kind: 'unavailable' }
      );
    }
  );
  it('a timeout or a dead connection is unavailable', async () => {
    expect(
      await viaFetch(async () => {
        throw new DOMException('timed out', 'TimeoutError');
      })
    ).toEqual({ kind: 'unavailable' });
  });
  it.each([
    ['a missing object', { status: 400, statusCode: '404' }, 'unreadable'],
    ['a gateway error', { status: 502, statusCode: '502' }, 'unavailable'],
    ['a 5xx inside a 400', { status: 400, statusCode: '503' }, 'unavailable'],
    ['no answer at all', { message: 'fetch failed' }, 'unavailable'],
  ])('storage: %s', async (_n, error, kind) => {
    expect(await viaStorage(error)).toEqual({ kind });
  });
});

describe('uploadStaffFile', () => {
  const base = {
    actor: ACTOR,
    caseId: CASE,
    accountId: 'acc',
    contactId: 'k1',
  };
  const recordReply = ok([{ document_id: DOC, ref: 'r' }]);

  it.each([
    [
      'bad MIME',
      { bytes: new Uint8Array(10), mime: 'text/html', originalName: 'a' },
      {},
      'MIME_NOT_ALLOWED',
    ],
    [
      'content that is not the declared type',
      {
        bytes: new TextEncoder().encode('<html><script>x</script></html>'),
        mime: 'application/pdf',
        originalName: 'a.pdf',
      },
      {},
      'MIME_NOT_ALLOWED',
    ],
    [
      'oversize',
      {
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
        mime: 'application/pdf',
        originalName: 'a',
      },
      {},
      'FILE_TOO_LARGE',
    ],
    [
      'bad expiresOn',
      { bytes: new Uint8Array(10), mime: 'application/pdf', originalName: 'a' },
      { expiresOn: '2026-02-30' },
      'VALIDATION_FAILED',
    ],
  ])('refuses %s with no write at all', async (_n, file, extra, reason) => {
    const fa = fakeAdmin({});
    const st = fakeStorage({});
    await expect(
      uploadStaffFile({
        ...base,
        ...extra,
        admin: fa.admin,
        file,
        deps: { storage: st.storage, clock },
      })
    ).rejects.toMatchObject({ reason });
    expect(st.uploads).toHaveLength(0);
    expect(fa.calls).toHaveLength(0);
  });

  it('refuses on the can-register check with zero storage writes', async () => {
    const fa = fakeAdmin({
      case_document_file_can_register: refuse('CASE_CLOSED'),
    });
    const st = fakeStorage({});
    const err = await uploadStaffFile({
      ...base,
      admin: fa.admin,
      file: {
        bytes: await pdfBytes(),
        mime: 'application/pdf',
        originalName: 'a.pdf',
      },
      deps: { storage: st.storage, clock },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CaseFilesRefusedError);
    expect(err.reason).toBe('CASE_CLOSED');
    expect(st.uploads).toHaveLength(0);
    expect(fa.rpcNames()).toEqual(['case_document_file_can_register']);
  });

  it('stores content-addressed with upsert false, records and registers', async () => {
    const bytes = await pdfBytes();
    const fa = fakeAdmin(
      {
        case_document_file_can_register: ok(true),
        customer_documents_record_internal: recordReply,
        case_document_file_register: ok(FILE),
      },
      { case_document_files: { [FILE]: fileRow } }
    );
    const st = fakeStorage({});
    const out = await uploadStaffFile({
      ...base,
      admin: fa.admin,
      file: {
        bytes,
        mime: 'Application/PDF; x=1',
        originalName: '../a\u0000.pdf',
      },
      deps: { storage: st.storage, clock },
    });
    expect(out.id).toBe(FILE);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(st.uploads).toEqual([
      {
        bucket: 'case-files',
        path: `cases/${CASE}/${sha}.pdf`,
        options: { contentType: 'application/pdf', upsert: false },
      },
    ]);
    const rec = fa.calls.find(
      (c) => c.fn === 'customer_documents_record_internal'
    )!.args;
    expect(rec).toMatchObject({
      p_source: 'staff_upload',
      p_kind: 'document',
      p_storage_path: `cases/${CASE}/${sha}.pdf`,
      p_uploaded_by: ACTOR,
      p_case_id: CASE,
      p_original_name: 'a.pdf',
    });
    expect(fa.rpcNames()).toEqual([
      'case_document_file_can_register',
      'customer_documents_record_internal',
      'case_document_file_register',
    ]);
  });

  it('treats an already-existing object as success', async () => {
    const fa = fakeAdmin(
      {
        case_document_file_can_register: ok(true),
        customer_documents_record_internal: recordReply,
        case_document_file_register: ok(FILE),
      },
      { case_document_files: { [FILE]: fileRow } }
    );
    const st = fakeStorage({
      uploadError: {
        statusCode: '409',
        error: 'Duplicate',
        message: 'The resource already exists',
      },
    });
    await expect(
      uploadStaffFile({
        ...base,
        admin: fa.admin,
        file: {
          bytes: await pdfBytes(),
          mime: 'application/pdf',
          originalName: 'a.pdf',
        },
        deps: { storage: st.storage, clock },
      })
    ).resolves.toMatchObject({ id: FILE });
  });
});

describe('attachCustomerDocument', () => {
  const tables = (doc = docRow()) => ({
    case_document_files: { [FILE]: fileRow },
    customer_documents: { [DOC]: doc },
  });

  it('registers, classifies and posts the checks under the classify_seq returned', async () => {
    const pdf = await pdfBytes();
    const fa = fakeAdmin(
      {
        case_document_file_register: ok(FILE),
        case_file_spec_rows: ok([specRow]),
        case_document_file_classify: cls,
        case_document_file_check_result: ok('passed'),
      },
      tables()
    );
    const f = vi.fn(async () => new Response(pdf));
    const out = await attachCustomerDocument({
      admin: fa.admin,
      actor: ACTOR,
      caseId: CASE,
      customerDocumentId: DOC,
      docKey: 'passport',
      deps: {
        storage: fakeStorage({}).storage,
        fetch: f as unknown as typeof fetch,
        internalBaseUrl: 'http://i',
        clock,
      },
    });
    expect(out.id).toBe(FILE);
    expect(fa.rpcNames()).toEqual([
      'case_document_file_register',
      'case_file_spec_rows',
      'case_document_file_classify',
      'case_document_file_check_result',
    ]);
    const post = fa.calls.at(-1)!.args;
    expect(post).toMatchObject({
      p_file: FILE,
      p_doc_key: 'passport',
      p_classify_seq: 7,
      p_pages: 1,
    });
    expect((post.p_checks as { ok: boolean }[]).every((c) => c.ok)).toBe(true);
  });

  it('posts the failed readable check when the bytes cannot be read', async () => {
    const fa = fakeAdmin(
      {
        case_document_file_register: ok(FILE),
        case_file_spec_rows: ok([specRow]),
        case_document_file_classify: cls,
        case_document_file_check_result: ok('failed'),
      },
      tables()
    );
    const f = vi.fn(async () => new Response('nope', { status: 404 }));
    await attachCustomerDocument({
      admin: fa.admin,
      actor: ACTOR,
      caseId: CASE,
      customerDocumentId: DOC,
      docKey: 'passport',
      deps: {
        storage: fakeStorage({}).storage,
        fetch: f as unknown as typeof fetch,
        internalBaseUrl: 'http://i',
        clock,
      },
    });
    expect(fa.calls.at(-1)!.args).toMatchObject({
      p_classify_seq: 7,
      p_pages: null,
      p_checks: [
        { name: 'readable', ok: false, detail: 'storage read failed' },
      ],
    });
  });

  it('a storage hiccup classifies nothing and fails nothing', async () => {
    const fa = fakeAdmin(
      {
        case_document_file_register: ok(FILE),
        case_file_spec_rows: ok([specRow]),
      },
      tables()
    );
    const f = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(
      attachCustomerDocument({
        admin: fa.admin,
        actor: ACTOR,
        caseId: CASE,
        customerDocumentId: DOC,
        docKey: 'passport',
        deps: {
          storage: fakeStorage({}).storage,
          fetch: f as unknown as typeof fetch,
          internalBaseUrl: 'http://i',
          clock,
        },
      })
    ).rejects.toMatchObject({ reason: 'STORAGE_UNAVAILABLE' });
    expect(fa.rpcNames()).toEqual([
      'case_document_file_register',
      'case_file_spec_rows',
    ]);
  });

  it('retries a deadlocked check_result once', async () => {
    const pdf = await pdfBytes();
    const fa = fakeAdmin(
      {
        case_document_file_register: ok(FILE),
        case_file_spec_rows: ok([specRow]),
        case_document_file_classify: cls,
        case_document_file_check_result: [refuse('', '40P01'), ok('passed')],
      },
      tables()
    );
    const f = vi.fn(async () => new Response(pdf));
    await attachCustomerDocument({
      admin: fa.admin,
      actor: ACTOR,
      caseId: CASE,
      customerDocumentId: DOC,
      docKey: 'passport',
      deps: {
        storage: fakeStorage({}).storage,
        fetch: f as unknown as typeof fetch,
        internalBaseUrl: 'http://i',
        clock,
      },
    });
    expect(
      fa.rpcNames().filter((n) => n === 'case_document_file_check_result')
    ).toHaveLength(2);
  });

  it('refuses an invalid expiresOn before any write', async () => {
    const fa = fakeAdmin({});
    await expect(
      attachCustomerDocument({
        admin: fa.admin,
        actor: ACTOR,
        caseId: CASE,
        customerDocumentId: DOC,
        docKey: 'passport',
        expiresOn: '2026-13-45',
        deps: { storage: fakeStorage({}).storage, clock },
      })
    ).rejects.toMatchObject({ reason: 'VALIDATION_FAILED' });
    expect(fa.calls).toHaveLength(0);
  });
});

describe('classifyAndCheck on a superseded file (270)', () => {
  const run = async (status: string, objects: Record<string, Uint8Array>) => {
    const f = fakeAdmin(
      {
        case_file_spec_rows: ok([specRow]),
        case_document_file_classify: cls,
        case_document_file_check_result: (a) => ({
          data: (a.p_checks as { ok: boolean }[]).every((c) => c.ok)
            ? 'passed'
            : 'failed',
          error: null,
        }),
      },
      {
        case_document_files: { [FILE]: { ...fileRow, status } },
        customer_documents: {
          [DOC]: docRow({
            media_url: null,
            storage_bucket: 'case-files',
            storage_path: 'a.pdf',
          }),
        },
      }
    );
    const result = classifyAndCheck({
      admin: f.admin,
      actor: ACTOR,
      fileId: FILE,
      docKey: 'passport',
      today: '2026-11-10',
      deps: { storage: fakeStorage({ objects }).storage },
    });
    return { f, result };
  };

  it('classifies and checks it again', async () => {
    const { f, result } = await run('superseded', {
      'case-files/a.pdf': await pdfBytes(),
    });
    expect((await result).status).toBe('passed');
    expect(f.rpcNames()).toContain('case_document_file_classify');
  });

  it('refuses one whose bytes are gone, before anything is classified', async () => {
    const { f, result } = await run('superseded', {});
    await expect(result).rejects.toMatchObject({ reason: 'FILE_STATE' });
    expect(f.rpcNames()).not.toContain('case_document_file_classify');
  });

  it('any other file without bytes still fails its checks, as before', async () => {
    const { result } = await run('failed', {});
    expect((await result).status).toBe('failed');
  });
});
