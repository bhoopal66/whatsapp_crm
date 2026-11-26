import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import { getDocumentProxy, getResolvedPDFJS } from 'unpdf';
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
  /** customer_documents.size_bytes by file id (absent = NULL). */
  sizes?: Record<string, number>;
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
      size_bytes: w.sizes?.[String(f.id)] ?? null,
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

  describe('size limits (BUILD_TOO_LARGE)', () => {
    async function refusal(
      w: Awaited<ReturnType<typeof world>>,
      limits: { maxInputBytes?: number; maxOutputBytes?: number }
    ) {
      const err = await assembleCaseFile({
        admin: w.admin,
        actor: 'u-1',
        caseId: CASE,
        deps: { ...w.deps, ...limits },
        now: NOW,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CaseFilesRefusedError);
      expect((err as CaseFilesRefusedError).reason).toBe('BUILD_TOO_LARGE');
      // Nothing stored or recorded; the reservation is left to lapse.
      expect(w.uploads).toEqual([]);
      expect(w.rpcNames()).toContain('case_file_build_reserve');
      expect(w.rpcNames()).not.toContain('case_file_build_record');
      expect(w.rpcNames()).not.toContain('customer_documents_record_internal');
    }

    it('declared sizes over the input budget refuse before the crossing read', async () => {
      const w = await world({ sizes: { 'f-eid': 2_000_000 } });
      // passport and statement are read; emirates_id's declared size
      // crosses the budget, so it is never read.
      await refusal(w, { maxInputBytes: 1_000_000 });
      expect(w.deps.readDocumentBytes).toHaveBeenCalledTimes(2);
    });

    it('bytes read over the input budget stop at the first that crosses', async () => {
      const w = await world();
      await refusal(w, { maxInputBytes: w.bytes['f-pass'].byteLength + 1 });
      expect(w.deps.readDocumentBytes).toHaveBeenCalledTimes(2);
    });

    it('an assembled PDF over the output cap is never uploaded', async () => {
      const w = await world();
      await refusal(w, { maxOutputBytes: 100 });
      expect(w.deps.readDocumentBytes).toHaveBeenCalledTimes(4);
    });

    it('an index-only build holds no bytes, so the input budget does not apply', async () => {
      const w = await world({ merged: false });
      const out = await assembleCaseFile({
        admin: w.admin,
        actor: 'u-1',
        caseId: CASE,
        deps: { ...w.deps, maxInputBytes: 1 },
        now: NOW,
      });
      expect(out.buildId).toBe('b-1');
      expect(w.uploads).toHaveLength(1);
    });

    it('a merged build within both limits is stored and recorded', async () => {
      const w = await world();
      const out = await assembleCaseFile({
        admin: w.admin,
        actor: 'u-1',
        caseId: CASE,
        deps: {
          ...w.deps,
          maxInputBytes: 1024 * 1024,
          maxOutputBytes: 1024 * 1024,
        },
        now: NOW,
      });
      expect(out.buildId).toBe('b-1');
      expect(w.uploads).toHaveLength(1);
    });
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

describe('what the bank receives', () => {
  const build = (w: Awaited<ReturnType<typeof world>>) =>
    assembleCaseFile({
      admin: w.admin,
      actor: 'u-1',
      caseId: CASE,
      deps: w.deps,
      now: NOW,
    });
  /** Every decoded stream of the stored PDF. */
  async function streams(w: Awaited<ReturnType<typeof world>>) {
    const out = await PDFDocument.load(w.uploads[0].body);
    return out.context
      .enumerateIndirectObjects()
      .flatMap(([, o]) =>
        o instanceof PDFRawStream &&
        o.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')
          ? [Buffer.from(decodePDFRawStream(o).decode()).toString('latin1')]
          : []
      );
  }
  const hex = (s: string) => Buffer.from(s).toString('hex').toUpperCase();

  type Raw = Record<string, unknown>;
  const n = (s: string) => PDFName.of(s);
  const str = (s: string) => PDFHexString.fromText(s);
  const TICK = '0 0 m 10 10 l S';
  const BLANK = '% off';

  /** An appearance stream. */
  const ap = (d: PDFDocument, body: string, more: Raw = {}) =>
    d.context.register(
      d.context.stream(body, {
        Type: 'XObject',
        Subtype: 'Form',
        BBox: [0, 0, 100, 20],
        ...more,
      })
    );
  /** One page with these raw widgets, and their form. */
  async function form(
    make: (d: PDFDocument) => Raw[],
    acro: ((d: PDFDocument, refs: PDFRef[]) => Raw | string) | null = () => ({})
  ) {
    const d = await PDFDocument.create();
    const page = d.addPage([300, 300]);
    const refs = make(d).map((w) =>
      d.context.register(
        d.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [10, 10, 110, 30],
          F: 4,
          ...w,
        } as never)
      )
    );
    page.node.set(n('Annots'), d.context.obj(refs));
    if (acro) {
      const extra = acro(d, refs);
      d.catalog.set(
        n('AcroForm'),
        d.context.obj(
          (typeof extra === 'string'
            ? extra
            : { Fields: refs, ...extra }) as never
        )
      );
    }
    return d.save({ updateFieldAppearances: false });
  }
  const NEED = () => ({ NeedAppearances: true });
  const text = (v?: string, more: Raw = {}): Raw => ({
    FT: 'Tx',
    T: str('name'),
    ...(v === undefined ? {} : { V: str(v) }),
    ...more,
  });
  const box = (more: Raw): Raw => ({ FT: 'Btn', T: str('agree'), ...more });
  const states = (d: PDFDocument) => ({
    Yes: ap(d, TICK),
    Off: ap(d, BLANK),
  });

  /** The widgets in the stored bundle and what each one draws. */
  async function drawn(pdf: Uint8Array) {
    const w = await world();
    w.bytes['f-stmt'] = pdf;
    await build(w);
    const body: Uint8Array = w.uploads[0].body;
    const out = await PDFDocument.load(body);
    const widgets = out.getPages().flatMap((p) => {
      const annots = p.node.lookup(n('Annots'));
      if (!(annots instanceof PDFArray)) return [];
      return annots.asArray().map((a) => {
        const dict = out.context.lookup(a, PDFDict);
        expect(dict.get(n('Subtype'))).toBe(n('Widget'));
        const as = dict.lookup(n('AS'));
        const apDict = dict.lookup(n('AP'));
        const N = apDict instanceof PDFDict ? apDict.lookup(n('N')) : undefined;
        const s =
          N instanceof PDFDict && as instanceof PDFName ? N.lookup(as) : N;
        const stream = s instanceof PDFRawStream ? s : null;
        return {
          as: as instanceof PDFName ? as.decodeText() : null,
          draws: stream
            ? Buffer.from(decodePDFRawStream(stream).decode()).toString(
                'latin1'
              )
            : null,
          bbox: stream?.dict.get(n('BBox'))?.toString(),
          matrix: stream?.dict.get(n('Matrix'))?.toString(),
        };
      });
    });
    return { widgets, body };
  }
  const only = async (pdf: Uint8Array) => {
    const { widgets } = await drawn(pdf);
    expect(widgets).toHaveLength(1);
    return widgets[0];
  };
  const refusal = async (pdf: Uint8Array) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await world();
    w.bytes['f-stmt'] = pdf;
    const err = (await build(w).catch((e) => e)) as CaseFilesRefusedError;
    expect(err).toBeInstanceOf(CaseFilesRefusedError);
    expect(w.uploads).toEqual([]);
    return { reason: err.reason, document: err.document };
  };
  const REFUSED = { reason: 'FORM_NOT_FLATTENED', document: 'STATEMENT.pdf' };
  const ARABIC = 'محمد';

  describe('form values the file draws itself stay as they are', () => {
    it('a tick whose N is an indirect reference', async () => {
      const w = await only(
        await form((d) => [
          box({
            V: 'Yes',
            AS: 'Yes',
            AP: { N: d.context.register(d.context.obj(states(d))) },
          }),
        ])
      );
      expect(w).toMatchObject({ as: 'Yes', draws: TICK });
    });

    it.each([
      ['checkbox', 0],
      ['radio', 1 << 15],
    ])('a %s ticked by AS without V', async (_, Ff) => {
      const w = await only(
        await form((d) => [box({ Ff, AS: 'Yes', AP: { N: states(d) } })])
      );
      expect(w).toMatchObject({ as: 'Yes', draws: TICK });
    });

    it('AS wins over the value', async () => {
      const w = await only(
        await form((d) => [box({ V: 'Yes', AS: 'Off', AP: { N: states(d) } })])
      );
      expect(w).toMatchObject({ as: 'Off', draws: BLANK });
    });

    it('a box with no AS shows the state its value names', async () => {
      const w = await only(
        await form((d) => [box({ V: 'Yes', AP: { N: states(d) } })])
      );
      expect(w).toMatchObject({ as: 'Yes', draws: TICK });
    });

    it('a form with a field on no page', async () => {
      const w = await only(
        await form(
          (d) => [text('kept', { AP: { N: ap(d, TICK) } })],
          (d, refs) => ({
            Fields: [
              ...refs,
              d.context.register(
                d.context.obj({
                  Type: 'Annot',
                  Subtype: 'Widget',
                  Rect: [0, 0, 50, 20],
                  P: d.context.nextRef(),
                  ...text('gone'),
                } as never)
              ),
            ],
          })
        )
      );
      expect(w.draws).toBe(TICK);
    });

    it.each([
      ['empty AP', {}],
      ['N that is gone', { N: PDFRef.of(999) }],
      ['N without a stream', { N: {} }],
    ])('an unused field and box with an %s', async (_, AP) => {
      const { widgets } = await drawn(
        await form(() => [text(undefined, { AP }), box({ AP })])
      );
      expect(widgets.map((w) => w.draws)).toEqual([null, null]);
    });

    it.each([
      ['none', null],
      ['stale', NEED],
    ])('an appearance with its own BBox and Matrix (%s)', async (_, need) => {
      const w = await only(
        await form(
          (d) => [
            text(need ? ARABIC : 'x', {
              AP: {
                N: ap(d, TICK, {
                  BBox: [50, 50, 150, 70],
                  Matrix: [0, 1, -1, 0, 5, 6],
                }),
              },
            }),
          ],
          need ?? (() => ({}))
        )
      );
      expect(w).toMatchObject({
        draws: TICK,
        bbox: '[ 50 50 150 70 ]',
        matrix: '[ 0 1 -1 0 5 6 ]',
      });
    });

    it('a tick, with NeedAppearances', async () => {
      const w = await only(
        await form((d) => [box({ AS: 'Yes', AP: { N: states(d) } })], NEED)
      );
      expect(w).toMatchObject({ as: 'Yes', draws: TICK });
    });

    it.each([
      ['a form without fields', () => ({})],
      ['no form', null],
    ])('%s', async (_, acro) => {
      const { widgets } = await drawn(await form(() => [], acro));
      expect(widgets).toEqual([]);
    });

    it.each([
      ['a form that is not a dictionary', () => 'Broken', 1],
      [
        'a field list with a broken entry',
        (_: PDFDocument, refs: PDFRef[]) => ({
          Fields: [PDFRef.of(998), ...refs],
        }),
        0,
      ],
    ])('%s does not stop the build', async (_, acro, logged) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const w = await only(
        await form((d) => [text('kept', { AP: { N: ap(d, TICK) } })], acro)
      );
      expect(w.draws).toBe(TICK);
      expect(warn).toHaveBeenCalledTimes(logged);
      for (const call of warn.mock.calls)
        expect(call).toEqual(['[case-files] form of f-stmt not read in full']);
    });

    it('a widget nothing is known about is left, and logged by id', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const w = await only(await form(() => [{ T: str('SECRET') }]));
      expect(w.draws).toBeNull();
      expect(warn.mock.calls).toEqual([
        ['[case-files] form of f-stmt not read in full'],
      ]);
    });
  });

  describe('form values the file leaves to the reader are drawn', () => {
    it.each([
      ['no AP', {}],
      ['an empty AP', { AP: {} }],
      ['an N that is gone', { AP: { N: PDFRef.of(999) } }],
    ])('text with %s', async (_, more) => {
      const w = await only(await form(() => [text('AED 12500', more)]));
      expect(w.draws).toContain(hex('AED 12500'));
    });

    it('text whose appearance is out of date', async () => {
      const w = await only(
        await form((d) => [text('AED 12500', { AP: { N: ap(d, TICK) } })], NEED)
      );
      expect(w.draws).toContain(hex('AED 12500'));
    });

    it('nothing over a value that was emptied', async () => {
      const list = { FT: 'Ch', T: str('l') };
      const { widgets } = await drawn(
        await form(
          (d) => [
            text(undefined, { AP: { N: ap(d, TICK) } }),
            text(' ', { AP: { N: ap(d, TICK) } }),
            { ...list, AP: { N: ap(d, TICK) } },
          ],
          NEED
        )
      );
      expect(widgets.map((w) => w.draws)).toEqual([null, null, null]);
    });

    it('a widget whose flags are no number, a name, and UTF-8', async () => {
      const { widgets } = await drawn(
        await form(
          (d) => [
            text('AED 12500', { F: n('odd') }),
            text(undefined, { V: n('NAMED') }),
            text(undefined, {
              V: PDFHexString.of(
                Buffer.from('\uFEFFZoë', 'utf8').toString('hex')
              ),
              AP: { N: ap(d, TICK) },
            }),
          ],
          NEED
        )
      );
      expect(widgets[0].draws).toContain(hex('AED 12500'));
      expect(widgets[1].draws).toContain(hex('NAMED'));
      expect(widgets[2].draws).toContain('5A6FEB');
    });

    it('a value with marks nobody sees', async () => {
      const w = await only(await form(() => [text('\u200E+971 50\u200B1')]));
      expect(w.draws).toContain(hex('+971 501'));
    });

    it('a list whose other option cannot be drawn', async () => {
      const w = await only(
        await form((d) => [
          {
            FT: 'Ch',
            T: str('l'),
            V: str('Oman'),
            Opt: d.context.obj([[str(ARABIC)], [str('Oman')]] as never),
          },
        ])
      );
      expect(w.draws).toContain(hex('Oman'));
    });

    it('a tick whose N has only its unticked state', async () => {
      const w = await only(
        await form((d) => [
          box({ V: 'Yes', AS: 'Yes', AP: { N: { Off: ap(d, BLANK) } } }),
        ])
      );
      expect(w.as).toBe('Yes');
      expect(w.draws).toMatch(/ [lc]\n/);
    });

    it('not a sign of a symbol font as a letter', async () => {
      const sign = { DA: str('/ZaDb 12 Tf 0 g') };
      const w = await only(
        await form(
          (d) => [text('4', { ...sign, AP: { N: ap(d, TICK) } })],
          NEED
        )
      );
      expect(w.draws).toBe(TICK);
      expect(await refusal(await form(() => [text('4', sign)]))).toEqual(
        REFUSED
      );
    });

    it('refuses a value it cannot read', async () => {
      const bad = (d: PDFDocument) =>
        d.context.register(d.context.stream('x', { Filter: 'NoSuchFilter' }));
      expect(
        await refusal(await form((d) => [text(undefined, { V: bad(d) })]))
      ).toEqual(REFUSED);
      const w = await only(
        await form((d) => [
          text(undefined, { V: bad(d), AP: { N: ap(d, TICK) } }),
        ])
      );
      expect(w.draws).toBe(TICK);
    });

    it('text stored as a stream, or on the parent', async () => {
      const { widgets } = await drawn(
        await form((d) => [
          text(undefined, { V: d.context.register(d.context.stream('LONG')) }),
          {
            Parent: d.context.register(
              d.context.obj(text('FROM PARENT') as never)
            ),
          },
        ])
      );
      expect(widgets[0].draws).toContain(hex('LONG'));
      expect(widgets[1].draws).toContain(hex('FROM PARENT'));
    });

    it('only the widget that has none, when its sibling has one', async () => {
      const { widgets } = await drawn(
        await form((d) => {
          const Parent = d.context.register(
            d.context.obj(text('AED 12500') as never)
          );
          return [{ Parent, AP: { N: ap(d, TICK) } }, { Parent }];
        })
      );
      expect(widgets[0].draws).toBe(TICK);
      expect(widgets[1].draws).toContain(hex('AED 12500'));
    });

    it('a dropdown (its display text) and a list', async () => {
      const Opt = (d: PDFDocument) =>
        d.context.obj([[str('AE'), str('Emirates')], str('Oman')] as never);
      const { widgets } = await drawn(
        await form((d) => [
          { FT: 'Ch', Ff: 1 << 17, T: str('c'), V: str('AE'), Opt: Opt(d) },
          {
            FT: 'Ch',
            T: str('l'),
            V: str('Oman'),
            Opt: d.context.obj([[str('Oman')]] as never),
          },
        ])
      );
      expect(widgets[0].draws).toContain(hex('Emirates'));
      expect(widgets[1].draws).toContain(hex('Oman'));
    });

    it.each([
      ['checkbox by AS', { AS: 'On' }, 'On'],
      ['checkbox by value', { V: 'On' }, 'On'],
      ['radio by AS', { Ff: 1 << 15, AS: '2' }, '2'],
      ['radio by value', { Ff: 1 << 15, V: '2', AP: {} }, '2'],
    ])('a ticked %s', async (_, more, as) => {
      const w = await only(await form(() => [box(more)]));
      expect(w.as).toBe(as);
      expect(w.draws).toMatch(/ [lc]\n/);
    });

    it('not the other boxes of a ticked field', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { widgets } = await drawn(
        await form((d) => {
          const Parent = d.context.nextRef();
          d.context.assign(
            Parent,
            d.context.obj({
              ...box({ V: 'A' }),
              Kids: [PDFRef.of(900), PDFRef.of(901)],
            } as never)
          );
          return [{ Parent }, { Parent, AS: 'Off' }];
        })
      );
      expect(widgets.map((w) => w.draws)).toEqual([null, null]);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('not what a reader does not show', async () => {
      const { widgets, body } = await drawn(
        await form(() => [
          text('SECRET', { F: 2 }),
          text('SECRET', { F: 32 }),
          text('SECRET', { Ff: 1 << 13 }),
          text(' '),
          text(ARABIC, { F: 2 }),
          text(ARABIC, { Rect: [0, 0, 0, 0] }),
        ])
      );
      expect(widgets.map((w) => w.draws)).toEqual(Array(6).fill(null));
      expect(body.length).toBeGreaterThan(0);
    });

    it('a reader shows them, with no form in the bundle', async () => {
      const { body } = await drawn(
        await form((d) => [
          text('DRAWN HERE'),
          text('x', {
            AP: {
              N: ap(d, 'BT /F 10 Tf (STORED) Tj ET', {
                Resources: {
                  Font: {
                    F: {
                      Type: 'Font',
                      Subtype: 'Type1',
                      BaseFont: 'Helvetica',
                    },
                  },
                },
              }),
            },
          }),
        ])
      );
      expect((await PDFDocument.load(body)).catalog.has(n('AcroForm'))).toBe(
        false
      );
      const { OPS } = await getResolvedPDFJS();
      const pdf = await getDocumentProxy(Uint8Array.from(body));
      let shown = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const ops = await (await pdf.getPage(i)).getOperatorList();
        let inside = false;
        ops.fnArray.forEach((fn, j) => {
          if (fn === OPS.beginAnnotation) inside = true;
          if (fn === OPS.endAnnotation) inside = false;
          if (inside && fn === OPS.showText)
            for (const g of ops.argsArray[j][0])
              shown += (g as { unicode?: string }).unicode ?? '';
        });
      }
      expect(shown).toContain('DRAWN HERE');
      expect(shown).toContain('STORED');
    });

    it.each([
      ['no appearance', {}, undefined],
      ['an empty AP', { AP: {} }, undefined],
      ['no appearance, NeedAppearances', {}, NEED],
    ])('refuses Arabic with %s, naming the document', async (_, more, acro) => {
      expect(
        await refusal(await form(() => [text(ARABIC, more)], acro))
      ).toEqual(REFUSED);
    });

    it.each([
      ['', undefined],
      [' and NeedAppearances', NEED],
    ])('keeps Arabic with a stored appearance%s', async (_, acro) => {
      const w = await only(
        await form((d) => [text(ARABIC, { AP: { N: ap(d, TICK) } })], acro)
      );
      expect(w.draws).toBe(TICK);
    });
  });

  /** `JPEG`, 300x100, with an EXIF orientation. */
  function photo(turn: number, little: boolean) {
    const u16 = (n: number) => (little ? [n & 255, n >> 8] : [n >> 8, n & 255]);
    const u32 = (n: number) => (little ? [...u16(n), 0, 0] : [0, 0, ...u16(n)]);
    const tiff = [
      ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...u16(42),
      ...u32(8),
      ...u16(1),
      ...u16(0x0112),
      ...u16(3),
      ...u32(1),
      ...u16(turn),
      0,
      0,
      ...u32(0),
    ];
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const jpeg = [...JPEG];
    jpeg.splice(7, 4, 0, 100, 300 >> 8, 300 & 255);
    jpeg.splice(2, 0, 0xff, 0xe1, 0, app1.length + 2, ...app1);
    return Uint8Array.from(jpeg);
  }

  // Where the photo's right and up directions point on the page.
  it.each([
    [1, true, [1, 0], [0, 1]],
    [3, true, [-1, 0], [0, -1]],
    [6, true, [0, -1], [1, 0]],
    [6, false, [0, -1], [1, 0]],
    [8, false, [0, 1], [-1, 0]],
  ])(
    'a photo with EXIF orientation %i stands upright',
    async (turn, little, right, up) => {
      const w = await world();
      w.bytes['f-photo'] = photo(turn, little);
      await build(w);
      const draws = (await streams(w)).filter(
        (s) => / cm\n/.test(s) && / Do\n/.test(s) && !/ Tf/.test(s)
      );
      // The PNG is another page: take the 3:1 one.
      const boxes = draws.map((s) => {
        let m = [1, 0, 0, 1, 0, 0];
        for (const [, nums] of s.matchAll(/^([-\d.e ]+) cm$/gm)) {
          const [a, b, c, d, e, f] = nums.split(' ').map(Number);
          m = [
            a * m[0] + b * m[2],
            a * m[1] + b * m[3],
            c * m[0] + d * m[2],
            c * m[1] + d * m[3],
            e * m[0] + f * m[2] + m[4],
            e * m[1] + f * m[3] + m[5],
          ];
        }
        return m;
      });
      const m = boxes.find(
        ([a, b, c, d]) =>
          Math.abs(Math.hypot(a, b) / Math.hypot(c, d) - 3) < 0.01
      )!;
      const dir = (x: number, y: number) =>
        [x, y].map((v) => Math.round(v / Math.hypot(x, y)) + 0);
      expect(dir(m[0], m[1])).toEqual(right);
      expect(dir(m[2], m[3])).toEqual(up);
      for (const [x, y] of [
        [0, 0],
        [1, 1],
      ]) {
        const px = m[0] * x + m[2] * y + m[4];
        const py = m[1] * x + m[3] * y + m[5];
        expect(px).toBeGreaterThan(0);
        expect(px).toBeLessThan(596);
        expect(py).toBeGreaterThan(0);
        expect(py).toBeLessThan(842);
      }
    }
  );
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
