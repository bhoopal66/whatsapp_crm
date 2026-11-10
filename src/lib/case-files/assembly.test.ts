import { PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  asciiSafe,
  assembleCaseFile,
  assembleIfReady,
  caseReference,
  currentCaseFileBuild,
} from './assembly';
import { sha256Hex } from './checks';
import { CaseFilesRefusedError, type CaseFilesDb } from './store';
import type { CaseFilesStorage } from './bytes';

const CASE = '11111111-2222-3333-4444-555555555555';
const CONTACT = 'c0000000-0000-0000-0000-000000000001';
const ACCOUNT = 'a0000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-11-10T08:00:00Z');

type Row = Record<string, unknown>;
type Reply = { data: unknown; error: unknown };

async function pdfOf(pages: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200, 200]);
  return d.save();
}
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
);
// SOI, a baseline SOF0 for a 1x1 three-channel image, EOI: all pdf-lib reads.
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

function fileRow(
  id: string,
  docKey: string,
  status: string,
  pages: number | null,
  renamed: string
): Row {
  return {
    id,
    case_id: CASE,
    customer_document_id: `doc-${id}`,
    doc_key: docKey,
    version: 1,
    status,
    classify_seq: 1,
    checks: [],
    pages,
    expires_on: null,
    renamed_name: renamed,
    registered_at: NOW.toISOString(),
    customer_documents: null,
  };
}

interface World {
  bank?: string;
  product?: string;
  submissionRef?: string | null;
  merged?: boolean;
  /** Newest first, as listFiles orders them. */
  files?: Row[];
  bytes?: Record<string, Uint8Array>;
  rpc?: Record<string, (args: Row) => Reply>;
  uploadError?: unknown;
}

async function world(w: World = {}) {
  const files = w.files ?? [
    fileRow('f-photo', 'photo', 'passed', 1, 'PHOTO.jpg'),
    fileRow('f-stmt', 'statement', 'passed', 3, 'STATEMENT.pdf'),
    fileRow('f-pass-old', 'passport', 'superseded', 2, 'PASSPORT.pdf'),
    fileRow('f-eid', 'emirates_id', 'passed', 1, 'EID.png'),
    fileRow('f-pass', 'passport', 'passed', 2, 'PASSPORT.pdf'),
    fileRow('f-other', 'other', 'passed', 1, 'OTHER.pdf'),
  ];
  const bytes = w.bytes ?? {
    'f-pass': await pdfOf(2),
    'f-stmt': await pdfOf(3),
    'f-eid': PNG,
    'f-photo': JPEG,
    'f-other': await pdfOf(5),
  };
  const merged = w.merged ?? true;
  // Out of position order on purpose; 'other' is optional.
  const spec = [
    { doc_key: 'statement', position: 2, required: true, merged },
    { doc_key: 'photo', position: 4, required: true, merged: false },
    { doc_key: 'passport', position: 1, required: true, merged: false },
    { doc_key: 'other', position: 5, required: false, merged: false },
    { doc_key: 'emirates_id', position: 3, required: true, merged: false },
  ];
  const tables: Record<string, Row[]> = {
    cases: [
      {
        id: CASE,
        account_id: ACCOUNT,
        bank_code: w.bank ?? 'ADCB',
        product: w.product ?? 'Personal loan',
        contact_id: CONTACT,
        group_id: 'group-1',
      },
    ],
    submission_groups: [
      {
        id: 'group-1',
        submission_ref:
          w.submissionRef === undefined ? 'SUB-0042' : w.submissionRef,
        contact_id: CONTACT,
      },
    ],
    customer_doc_folders: [{ contact_id: CONTACT, ref: 'TC-000123' }],
    case_document_files: files,
    customer_documents: files.map((f) => ({
      id: f.customer_document_id,
      contact_id: CONTACT,
      storage_bucket: 'case-files',
      storage_path: `cases/${CASE}/${String(f.id)}`,
      mime: 'application/pdf',
    })),
  };

  const calls: { fn: string; args: Row }[] = [];
  const handlers: Record<string, (args: Row) => Reply> = {
    case_file_build_gate: () => ({ data: 1, error: null }),
    case_file_build_reserve: () => ({
      data: [{ version: 3, reservation_id: 'r-1' }],
      error: null,
    }),
    case_file_spec_rows: () => ({ data: spec, error: null }),
    case_file_build_record: () => ({
      data: [{ build_id: 'b-1', version: 3 }],
      error: null,
    }),
    customer_documents_record_internal: () => ({
      data: [{ document_id: 'cd-1', ref: 'TC-000123' }],
      error: null,
    }),
    case_file_ready: () => ({ data: true, error: null }),
    case_file_build_current: () => ({ data: [], error: null }),
    ...w.rpc,
  };
  const reads: string[] = [];
  const from = (table: string) => {
    reads.push(table);
    const eqs: Row = {};
    const result = () =>
      (tables[table] ?? []).filter((r) =>
        Object.entries(eqs).every(([k, v]) => r[k] === v)
      );
    const b = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        eqs[k] = v;
        return b;
      },
      order: () => b,
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (ok: (r: Reply) => unknown) => ok({ data: result(), error: null }),
    };
    return b;
  };
  const admin = {
    rpc: async (fn: string, args: Row = {}) => {
      calls.push({ fn, args });
      const h = handlers[fn];
      if (!h) throw new Error(`unexpected rpc ${fn}`);
      return h(args);
    },
    from,
  } as unknown as CaseFilesDb;

  const uploads: {
    bucket: string;
    path: string;
    body: Uint8Array;
    options: unknown;
  }[] = [];
  const storage: CaseFilesStorage = {
    from: (bucket) => ({
      upload: async (path, body, options) => {
        uploads.push({ bucket, path, body: body as Uint8Array, options });
        return { data: null, error: w.uploadError ?? null };
      },
      download: async () => ({ data: null, error: { message: 'unused' } }),
    }),
  };
  const readDocumentBytes = vi.fn(
    async (doc: { storagePath: string | null }) =>
      bytes[String(doc.storagePath).split('/').pop()!] ?? null
  );
  const deps = { storage, readDocumentBytes, clock: () => NOW };
  const rpcNames = () => calls.map((c) => c.fn);
  const call = (fn: string) => calls.find((c) => c.fn === fn)?.args;
  return { admin, deps, uploads, calls, rpcNames, call, reads, bytes };
}

afterEach(() => vi.restoreAllMocks());

describe('assembleCaseFile', () => {
  it('refused at the gate: no reserve, no reads, no PDF, no storage write', async () => {
    const w = await world({
      rpc: {
        case_file_build_gate: () => ({
          data: null,
          error: { message: 'x', hint: 'FILE_NOT_READY', code: '23514' },
        }),
      },
    });
    const err = await assembleCaseFile({
      admin: w.admin,
      actor: 'u-1',
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaseFilesRefusedError);
    expect((err as CaseFilesRefusedError).reason).toBe('FILE_NOT_READY');
    expect(w.uploads).toEqual([]);
    expect(w.rpcNames()).toEqual(['case_file_build_gate']);
    expect(w.reads).toEqual([]);
    expect(w.deps.readDocumentBytes).not.toHaveBeenCalled();
  });

  it('merged: stores one content-addressed PDF of the cover plus every document', async () => {
    const w = await world();
    const out = await assembleCaseFile({
      admin: w.admin,
      actor: 'u-1',
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });

    expect(w.uploads).toHaveLength(1);
    const up = w.uploads[0];
    expect(up.bucket).toBe('case-files');
    expect(up.options).toEqual({
      contentType: 'application/pdf',
      upsert: false,
    });
    const sha = sha256Hex(up.body);
    expect(up.path).toBe(`cases/${CASE}/bundle-${sha}.pdf`);
    expect(out.objectPath).toBe(up.path);
    expect(out.sha256).toBe(sha);

    const pdf = await PDFDocument.load(up.body);
    // 1 cover + 2 + 3 (PDFs) + 1 (PNG) + 1 (JPEG); the optional doc is out.
    expect(pdf.getPageCount()).toBe(8);

    expect(out.manifest).toEqual([
      {
        position: 1,
        docKey: 'passport',
        fileId: 'f-pass',
        renamedName: 'PASSPORT.pdf',
        pages: 2,
        sha256: sha256Hex(w.bytes['f-pass']),
      },
      {
        position: 2,
        docKey: 'statement',
        fileId: 'f-stmt',
        renamedName: 'STATEMENT.pdf',
        pages: 3,
        sha256: sha256Hex(w.bytes['f-stmt']),
      },
      {
        position: 3,
        docKey: 'emirates_id',
        fileId: 'f-eid',
        renamedName: 'EID.png',
        pages: 1,
        sha256: sha256Hex(PNG),
      },
      {
        position: 4,
        docKey: 'photo',
        fileId: 'f-photo',
        renamedName: 'PHOTO.jpg',
        pages: 1,
        sha256: sha256Hex(JPEG),
      },
    ]);
    expect(out).toMatchObject({ buildId: 'b-1', version: 3, merged: true });

    expect(w.rpcNames().indexOf('case_file_build_reserve')).toBeLessThan(
      w.rpcNames().indexOf('case_file_build_record')
    );
    expect(w.call('case_file_build_record')).toEqual({
      p_actor: 'u-1',
      p_case: CASE,
      p_reservation: 'r-1',
      p_manifest: out.manifest.map((e) => ({
        position: e.position,
        doc_key: e.docKey,
        file_id: e.fileId,
        renamed_name: e.renamedName,
        pages: e.pages,
        sha256: e.sha256,
      })),
      p_merged: true,
      p_object_path: up.path,
      p_sha256: sha,
      p_now: NOW.toISOString(),
    });
    expect(w.call('customer_documents_record_internal')).toMatchObject({
      p_account_id: ACCOUNT,
      p_contact_id: CONTACT,
      p_source: 'case_build',
      p_kind: 'document',
      p_storage_bucket: 'case-files',
      p_storage_path: up.path,
      p_case_id: CASE,
      p_mime: 'application/pdf',
      p_original_name: 'Case file SUB-0042 v3.pdf',
    });
  });

  it('not merged: the stored PDF is the cover only, at the index path', async () => {
    const w = await world({ merged: false });
    const out = await assembleCaseFile({
      admin: w.admin,
      actor: null,
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });
    const up = w.uploads[0];
    expect(up.path).toBe(`cases/${CASE}/index-${sha256Hex(up.body)}.pdf`);
    expect((await PDFDocument.load(up.body)).getPageCount()).toBe(1);
    expect(out.merged).toBe(false);
    expect(w.call('case_file_build_record')).toMatchObject({
      p_actor: null,
      p_merged: false,
    });
  });

  it('an object already at the path is the same bytes: the build goes on', async () => {
    const w = await world({
      uploadError: {
        statusCode: '409',
        message: 'The resource already exists',
      },
    });
    const out = await assembleCaseFile({
      admin: w.admin,
      actor: 'u-1',
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });
    expect(out.buildId).toBe('b-1');
  });

  it('a file whose bytes cannot be read throws and stores nothing', async () => {
    const w = await world();
    delete w.bytes['f-stmt'];
    await expect(
      assembleCaseFile({
        admin: w.admin,
        actor: 'u-1',
        caseId: CASE,
        deps: w.deps,
        now: NOW,
      })
    ).rejects.toThrow();
    expect(w.uploads).toEqual([]);
    expect(w.rpcNames()).not.toContain('case_file_build_record');
  });

  it('a failed customer-document record is logged by id and does not undo the build', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const w = await world({
      rpc: {
        customer_documents_record_internal: () => ({
          data: null,
          error: { message: 'secret db text', hint: 'INVALID', code: 'P0001' },
        }),
      },
    });
    const out = await assembleCaseFile({
      admin: w.admin,
      actor: 'u-1',
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });
    expect(out.buildId).toBe('b-1');
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain('b-1');
    expect(String(log.mock.calls[0][0])).not.toContain('secret');
  });

  it('Arabic bank, product and names never reach drawText', async () => {
    const w = await world({
      bank: 'بنك أبوظبي',
      product: 'قرض شخصي',
      submissionRef: null,
      files: [
        fileRow('f-photo', 'photo', 'passed', 1, 'صورة.jpg'),
        fileRow('f-stmt', 'statement', 'passed', 3, 'كشف حساب.pdf'),
        fileRow('f-eid', 'emirates_id', 'passed', 1, 'هوية.png'),
        fileRow('f-pass', 'passport', 'passed', 2, 'جواز.pdf'),
      ],
    });
    const out = await assembleCaseFile({
      admin: w.admin,
      actor: 'u-1',
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });
    expect((await PDFDocument.load(w.uploads[0].body)).getPageCount()).toBe(8);
    expect(w.call('customer_documents_record_internal')).toMatchObject({
      p_original_name: `Case file CASE-11111111 v3.pdf`,
    });
    expect(out.manifest[1].renamedName).toBe('كشف حساب.pdf');
  });
});

describe('text helpers', () => {
  it('asciiSafe turns each non-ASCII run into one ?', () => {
    expect(asciiSafe('بنك ADCB')).toBe('? ADCB');
    expect(asciiSafe('Al Hilal – بنك')).toBe('Al Hilal ? ?');
    expect(asciiSafe(null)).toBe('');
  });
  it('caseReference falls back to CASE- and the first 8 of the id', () => {
    expect(caseReference(CASE, 'SUB-1')).toBe('SUB-1');
    expect(caseReference(CASE, null)).toBe('CASE-11111111');
    expect(caseReference(CASE, '   ')).toBe('CASE-11111111');
  });
});

describe('assembleIfReady', () => {
  const currentRow = (fileIds: string[], merged = true) => ({
    build_id: 'b-0',
    version: 2,
    merged,
    manifest: fileIds.map((id, i) => ({
      position: i + 1,
      doc_key: 'k',
      file_id: id,
      renamed_name: null,
      pages: 1,
      sha256: 'a'.repeat(64),
    })),
    object_path: `cases/${CASE}/bundle-${'b'.repeat(64)}.pdf`,
    sha256: 'b'.repeat(64),
    status: 'ready',
    built_at: NOW.toISOString(),
  });

  it('not File ready: null, nothing built', async () => {
    const w = await world({
      rpc: { case_file_ready: () => ({ data: false, error: null }) },
    });
    expect(
      await assembleIfReady({
        admin: w.admin,
        caseId: CASE,
        deps: w.deps,
        now: NOW,
      })
    ).toBeNull();
    expect(w.rpcNames()).toEqual(['case_file_ready']);
    expect(w.uploads).toEqual([]);
  });

  it('the current build lists the current passed files: returned, created false', async () => {
    const w = await world({
      rpc: {
        case_file_build_current: () => ({
          data: [currentRow(['f-pass', 'f-stmt', 'f-eid', 'f-photo'])],
          error: null,
        }),
      },
    });
    const out = await assembleIfReady({
      admin: w.admin,
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });
    expect(out).toMatchObject({ buildId: 'b-0', version: 2, created: false });
    expect(w.uploads).toEqual([]);
    expect(w.rpcNames()).not.toContain('case_file_build_reserve');
    expect(w.call('case_file_build_current')).toEqual({
      p_actor: null,
      p_case: CASE,
    });
  });

  it('changed files or merged flag: a new build, created true', async () => {
    for (const row of [
      currentRow(['f-pass-old', 'f-stmt', 'f-eid', 'f-photo']),
      currentRow(['f-pass', 'f-stmt', 'f-eid', 'f-photo'], false),
    ]) {
      const w = await world({
        rpc: { case_file_build_current: () => ({ data: [row], error: null }) },
      });
      const out = await assembleIfReady({
        admin: w.admin,
        caseId: CASE,
        deps: w.deps,
        now: NOW,
      });
      expect(out).toMatchObject({ buildId: 'b-1', created: true });
      expect(w.uploads).toHaveLength(1);
      expect(w.call('case_file_build_reserve')).toMatchObject({
        p_actor: null,
      });
    }
  });
});

describe('currentCaseFileBuild', () => {
  it('null with no ready build', async () => {
    const w = await world();
    expect(
      await currentCaseFileBuild({ admin: w.admin, actor: 'u-1', caseId: CASE })
    ).toBeNull();
  });
});
