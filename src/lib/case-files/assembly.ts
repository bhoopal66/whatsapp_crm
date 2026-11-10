/**
 * Case file assembly (migration 182), ported from the 021 package's
 * `assembly.ts`: a File-ready case's passed documents become ONE PDF in the
 * private 'case-files' bucket, recorded as a build and filed in the
 * customer's documents (180) so the NAS worker copies it.
 *
 *   merged  (the spec's merged flag): cover/index page(s), then every
 *           document (PDF pages copied, a JPEG/PNG one A4 page each);
 *           stored at `cases/<case>/bundle-<sha256>.pdf`.
 *   !merged the cover/index only, at `cases/<case>/index-<sha256>.pdf`.
 *
 * Order: gate (refusals before any PDF work or storage write), reserve,
 * read every file (an unreadable one throws, nothing stored), render,
 * store content-addressed (`upsert: false`; already there = same bytes),
 * record, then file in the customer's documents (a failure there is
 * logged by id and never undoes the build).
 *
 * Text: pdf-lib's standard fonts encode WinAnsi only, so everything drawn
 * goes through `asciiSafe` first; an Arabic bank or product name prints
 * '?', it never throws.
 *
 * TENANCY: a route has already checked the case belongs to the actor's
 * active account (see store.ts). `actor` NULL is the system job.
 */
import {
  PDFDocument,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

import { recordCustomerDocumentInternal } from '@/lib/customer-docs/record';

import {
  readDocumentBytes as defaultReadDocumentBytes,
  type CaseFilesStorage,
} from './bytes';
import { sha256Hex } from './checks';
import { CASE_FILES_BUCKET, isAlreadyExists } from './intake-file';
import {
  CASE_FILES_REFUSALS,
  CaseFilesRefusedError,
  CaseFilesStore,
  type CaseFilesRefusal,
  CaseFilesStoreError,
  type CaseFile,
  type CaseFilesDb,
  type CaseFileSpecRow,
} from './store';

export interface AssemblyDeps {
  /** The service-role storage client (`admin.storage`). */
  storage: CaseFilesStorage;
  readDocumentBytes?: typeof defaultReadDocumentBytes;
  fetch?: typeof fetch;
  /** Defaults to `serverSupabaseUrl()`. */
  internalBaseUrl?: string;
  clock?: () => Date;
}

export interface ManifestEntry {
  position: number;
  docKey: string;
  fileId: string;
  renamedName: string | null;
  pages: number | null;
  /** The file's bytes as read for this build. */
  sha256: string;
}

export interface AssembledCaseFile {
  buildId: string;
  version: number;
  merged: boolean;
  manifest: ManifestEntry[];
  objectPath: string;
  sha256: string;
}

export interface CaseFileBuild extends AssembledCaseFile {
  status: 'ready' | 'superseded';
  builtAt: Date;
}

type Row = Record<string, unknown>;
const rows = (data: unknown): Row[] =>
  Array.isArray(data) ? (data as Row[]) : data ? [data as Row] : [];

const REFUSALS = new Set<string>(CASE_FILES_REFUSALS);

/** The 182 RPCs, with store.ts's refusal mapping (no database text). */
async function rpc(admin: CaseFilesDb, fn: string, args: Row) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) {
    const e = error as { hint?: unknown; code?: unknown };
    if (typeof e.hint === 'string' && REFUSALS.has(e.hint))
      throw new CaseFilesRefusedError(e.hint as CaseFilesRefusal);
    throw new CaseFilesStoreError(
      fn,
      typeof e.code === 'string' ? e.code : null
    );
  }
  return data as unknown;
}

// ------------------------------------------------------------ text

/** Printable ASCII only: each run of anything else becomes one '?'. */
export function asciiSafe(value: string | null | undefined): string {
  return (value ?? '').replace(/[^\x20-\x7e]+/g, '?');
}

/** The case reference printed on the cover and in the file name. */
export function caseReference(
  caseId: string,
  submissionRef: string | null
): string {
  const ref = asciiSafe(submissionRef).trim();
  return ref !== '' ? ref : `CASE-${caseId.slice(0, 8)}`;
}

// ------------------------------------------------------------ reads

interface CaseHeader {
  accountId: string;
  bankCode: string | null;
  product: string | null;
  submissionRef: string | null;
  contactId: string | null;
  customerRef: string | null;
}

async function loadCaseHeader(
  admin: CaseFilesDb,
  caseId: string
): Promise<CaseHeader> {
  const { data, error } = await admin
    .from('cases')
    .select(
      'id, account_id, bank_code, product, submission_groups!cases_group_fkey(submission_ref, contact_id)'
    )
    .eq('id', caseId)
    .maybeSingle();
  if (error) throw new CaseFilesStoreError('cases', error.code ?? null);
  if (!data) throw new CaseFilesRefusedError('CASE_NOT_FOUND');
  const c = data as Row;
  const g = (
    Array.isArray(c.submission_groups)
      ? c.submission_groups[0]
      : c.submission_groups
  ) as Row | null | undefined;
  const contactId = g?.contact_id ? String(g.contact_id) : null;

  let customerRef: string | null = null;
  if (contactId) {
    const folder = await admin
      .from('customer_doc_folders')
      .select('ref')
      .eq('contact_id', contactId)
      .maybeSingle();
    if (folder.error)
      throw new CaseFilesStoreError(
        'customer_doc_folders',
        folder.error.code ?? null
      );
    const ref = (folder.data as Row | null)?.ref;
    customerRef = typeof ref === 'string' ? ref : null;
  }
  return {
    accountId: String(c.account_id),
    bankCode: c.bank_code ? String(c.bank_code) : null,
    product: c.product ? String(c.product) : null,
    submissionRef: g?.submission_ref ? String(g.submission_ref) : null,
    contactId,
    customerRef,
  };
}

interface PlannedEntry {
  spec: CaseFileSpecRow;
  file: CaseFile;
}

/**
 * One entry per REQUIRED spec doc, its current passed file, in the order
 * 182's record compares against (position, then doc_key); the spec's
 * merged flag is any row's (182's bool_or).
 */
async function planManifest(
  store: CaseFilesStore,
  caseId: string
): Promise<{ merged: boolean; entries: PlannedEntry[] }> {
  const [spec, files] = await Promise.all([
    store.specRows(caseId),
    store.listFiles(caseId),
  ]);
  const merged = spec.some((s) => s.merged);
  const required = spec
    .filter((s) => s.required)
    .sort((a, b) =>
      a.position !== b.position
        ? a.position - b.position
        : a.docKey < b.docKey
          ? -1
          : a.docKey > b.docKey
            ? 1
            : 0
    );
  const entries: PlannedEntry[] = [];
  for (const s of required) {
    // listFiles is newest first.
    const file = files.find(
      (f) => f.docKey === s.docKey && f.status === 'passed'
    );
    if (!file) throw new CaseFilesRefusedError('FILE_NOT_READY');
    entries.push({ spec: s, file });
  }
  return { merged, entries };
}

// ------------------------------------------------------------ PDF

type Kind = 'pdf' | 'jpeg' | 'png';

/** By the bytes, not the stored MIME. */
function sniff(bytes: Uint8Array): Kind | null {
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  )
    return 'pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'png';
  return null;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 48;
const ROW_H = 16;

interface CoverInfo {
  caseRef: string;
  customerRef: string | null;
  bankCode: string | null;
  product: string | null;
  builtAt: Date;
  version: number;
  merged: boolean;
}

function fit(text: string, font: PDFFont, size: number, max: number): string {
  let s = asciiSafe(text);
  if (font.widthOfTextAtSize(s, size) <= max) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}...`, size) > max)
    s = s.slice(0, -1);
  return `${s}...`;
}

function drawCover(
  doc: PDFDocument,
  info: CoverInfo,
  manifest: readonly ManifestEntry[],
  font: PDFFont,
  bold: PDFFont
): void {
  const cols = { pos: MARGIN, name: MARGIN + 40, pages: 430, sha: 475 };
  const nameWidth = cols.pages - cols.name - 8;
  let page: PDFPage = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  const text = (s: string, x: number, size = 10, f = font) =>
    page.drawText(asciiSafe(s), { x, y, size, font: f });

  text(`Case file ${info.caseRef}`, MARGIN, 18, bold);
  y -= 28;
  const lines: [string, string][] = [
    ['Case reference', info.caseRef],
    ['Customer reference', info.customerRef ?? '-'],
    ['Bank', info.bankCode ?? '-'],
    ['Product', info.product ?? '-'],
    ['Built', info.builtAt.toISOString().slice(0, 10)],
    ['Version', String(info.version)],
    ['Contents', info.merged ? 'Index and every document' : 'Index only'],
  ];
  for (const [label, value] of lines) {
    text(label, MARGIN, 10, bold);
    page.drawText(fit(value, font, 10, A4[0] - MARGIN - 170), {
      x: MARGIN + 130,
      y,
      size: 10,
      font,
    });
    y -= ROW_H;
  }
  y -= ROW_H;

  const header = () => {
    text('#', cols.pos, 10, bold);
    text('Document', cols.name, 10, bold);
    text('Pages', cols.pages, 10, bold);
    text('SHA-256', cols.sha, 10, bold);
    y -= ROW_H;
  };
  header();
  for (const e of manifest) {
    if (y < MARGIN) {
      page = doc.addPage(A4);
      y = A4[1] - MARGIN;
      header();
    }
    text(String(e.position), cols.pos);
    page.drawText(fit(e.renamedName ?? e.docKey, font, 10, nameWidth), {
      x: cols.name,
      y,
      size: 10,
      font,
    });
    text(e.pages === null ? '-' : String(e.pages), cols.pages);
    text(e.sha256.slice(0, 12), cols.sha);
    y -= ROW_H;
  }
}

async function appendDocument(
  doc: PDFDocument,
  bytes: Uint8Array,
  fileId: string
): Promise<void> {
  const kind = sniff(bytes);
  if (kind === 'pdf') {
    const src = await PDFDocument.load(bytes);
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) doc.addPage(p);
    return;
  }
  if (kind === 'jpeg' || kind === 'png') {
    const img =
      kind === 'jpeg' ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    const page = doc.addPage(A4);
    const boxW = A4[0] - 2 * MARGIN;
    const boxH = A4[1] - 2 * MARGIN;
    const scale = Math.min(boxW / img.width, boxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, {
      x: (A4[0] - w) / 2,
      y: (A4[1] - h) / 2,
      width: w,
      height: h,
    });
    return;
  }
  throw new CaseFilesStoreError(`assembly.file ${fileId}`, null);
}

async function renderPdf(
  info: CoverInfo,
  manifest: readonly ManifestEntry[],
  documents: readonly { fileId: string; bytes: Uint8Array }[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(info.builtAt);
  doc.setModificationDate(info.builtAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  drawCover(doc, info, manifest, font, bold);
  if (info.merged)
    for (const d of documents) await appendDocument(doc, d.bytes, d.fileId);
  return doc.save();
}

// ------------------------------------------------------------ build

const toJson = (e: ManifestEntry) => ({
  position: e.position,
  doc_key: e.docKey,
  file_id: e.fileId,
  renamed_name: e.renamedName,
  pages: e.pages,
  sha256: e.sha256,
});

export async function assembleCaseFile(input: {
  admin: CaseFilesDb;
  actor: string | null;
  caseId: string;
  deps: AssemblyDeps;
  now?: Date;
}): Promise<AssembledCaseFile> {
  const { admin, actor, caseId, deps } = input;
  const now = input.now ?? (deps.clock ?? (() => new Date()))();
  const store = new CaseFilesStore(admin);
  const read = deps.readDocumentBytes ?? defaultReadDocumentBytes;

  // 1. Refusals before any PDF work or storage write.
  await rpc(admin, 'case_file_build_gate', { p_actor: actor, p_case: caseId });

  // 2. A version, held for 10 minutes.
  const reserved = rows(
    await rpc(admin, 'case_file_build_reserve', {
      p_actor: actor,
      p_case: caseId,
      p_now: now.toISOString(),
    })
  )[0];
  if (!reserved?.reservation_id)
    throw new CaseFilesStoreError('case_file_build_reserve', null);
  const version = Number(reserved.version);
  const reservationId = String(reserved.reservation_id);

  // 3. The manifest, every file's bytes read and hashed.
  const [header, plan] = await Promise.all([
    loadCaseHeader(admin, caseId),
    planManifest(store, caseId),
  ]);
  const manifest: ManifestEntry[] = [];
  const documents: { fileId: string; bytes: Uint8Array }[] = [];
  for (const { spec, file } of plan.entries) {
    const doc = await store.getDocument(file.customerDocumentId);
    const bytes = doc
      ? await read(doc, {
          storage: deps.storage,
          fetch: deps.fetch,
          internalBaseUrl: deps.internalBaseUrl,
        })
      : null;
    if (!bytes) throw new CaseFilesStoreError(`assembly.read ${file.id}`, null);
    manifest.push({
      position: spec.position,
      docKey: spec.docKey,
      fileId: file.id,
      renamedName: file.renamedName,
      pages: file.pages,
      sha256: sha256Hex(bytes),
    });
    documents.push({ fileId: file.id, bytes });
  }

  // 4. One PDF.
  const caseRef = caseReference(caseId, header.submissionRef);
  const pdf = await renderPdf(
    {
      caseRef,
      customerRef: header.customerRef,
      bankCode: header.bankCode,
      product: header.product,
      builtAt: now,
      version,
      merged: plan.merged,
    },
    manifest,
    documents
  );

  // 5. Content-addressed: a path only ever holds the bytes it names.
  const sha256 = sha256Hex(pdf);
  const objectPath = `cases/${caseId}/${plan.merged ? 'bundle' : 'index'}-${sha256}.pdf`;
  let stored: { error: unknown };
  try {
    stored = await deps.storage
      .from(CASE_FILES_BUCKET)
      .upload(objectPath, pdf, {
        contentType: 'application/pdf',
        upsert: false,
      });
  } catch {
    throw new CaseFilesStoreError('storage.upload', null);
  }
  if (stored.error && !isAlreadyExists(stored.error))
    throw new CaseFilesStoreError('storage.upload', null);

  // 6. The build.
  const recorded = rows(
    await rpc(admin, 'case_file_build_record', {
      p_actor: actor,
      p_case: caseId,
      p_reservation: reservationId,
      p_manifest: manifest.map(toJson),
      p_merged: plan.merged,
      p_object_path: objectPath,
      p_sha256: sha256,
      p_now: now.toISOString(),
    })
  )[0];
  if (!recorded?.build_id)
    throw new CaseFilesStoreError('case_file_build_record', null);
  const buildId = String(recorded.build_id);
  const builtVersion = Number(recorded.version ?? version);

  // 7. Filed for the NAS worker; never undoes the build.
  if (header.contactId) {
    try {
      const doc = await recordCustomerDocumentInternal(admin, {
        source: 'case_build',
        accountId: header.accountId,
        contactId: header.contactId,
        kind: 'document',
        storageBucket: CASE_FILES_BUCKET,
        storagePath: objectPath,
        receivedAt: now.toISOString(),
        mime: 'application/pdf',
        originalName: `Case file ${caseRef} v${builtVersion}.pdf`,
        caseId,
      });
      if (!doc)
        console.error(
          `[case-files] build ${buildId} of case ${caseId}: customer document not recorded`
        );
    } catch {
      console.error(
        `[case-files] build ${buildId} of case ${caseId}: customer document record failed`
      );
    }
  } else {
    console.error(
      `[case-files] build ${buildId} of case ${caseId}: no contact, not filed`
    );
  }

  return {
    buildId,
    version: builtVersion,
    merged: plan.merged,
    manifest,
    objectPath,
    sha256,
  };
}

function toManifestEntry(r: Row): ManifestEntry {
  return {
    position: Number(r.position),
    docKey: String(r.doc_key),
    fileId: String(r.file_id),
    renamedName:
      r.renamed_name === null || r.renamed_name === undefined
        ? null
        : String(r.renamed_name),
    pages: r.pages === null || r.pages === undefined ? null : Number(r.pages),
    sha256: String(r.sha256),
  };
}

/** The ready build of the case, or null. */
export async function currentCaseFileBuild(input: {
  admin: CaseFilesDb;
  actor: string | null;
  caseId: string;
}): Promise<CaseFileBuild | null> {
  const r = rows(
    await rpc(input.admin, 'case_file_build_current', {
      p_actor: input.actor,
      p_case: input.caseId,
    })
  )[0];
  if (!r) return null;
  return {
    buildId: String(r.build_id),
    version: Number(r.version),
    merged: r.merged === true,
    manifest: Array.isArray(r.manifest)
      ? (r.manifest as Row[]).map(toManifestEntry)
      : [],
    objectPath: String(r.object_path),
    sha256: String(r.sha256),
    status: r.status === 'superseded' ? 'superseded' : 'ready',
    builtAt: new Date(String(r.built_at)),
  };
}

/**
 * The system job (actor NULL): null when the case is not File ready; the
 * current build (`created: false`) when it already lists the current
 * passed files in order with the spec's merged flag; else a new build.
 */
export async function assembleIfReady(input: {
  admin: CaseFilesDb;
  caseId: string;
  deps: AssemblyDeps;
  now?: Date;
}): Promise<(AssembledCaseFile & { created: boolean }) | null> {
  const store = new CaseFilesStore(input.admin);
  if (!(await store.fileReady(input.caseId))) return null;

  const [current, plan] = await Promise.all([
    currentCaseFileBuild({
      admin: input.admin,
      actor: null,
      caseId: input.caseId,
    }),
    planManifest(store, input.caseId),
  ]);
  if (
    current &&
    current.merged === plan.merged &&
    current.manifest.length === plan.entries.length &&
    current.manifest.every((e, i) => e.fileId === plan.entries[i].file.id)
  ) {
    const { buildId, version, merged, manifest, objectPath, sha256 } = current;
    return {
      buildId,
      version,
      merged,
      manifest,
      objectPath,
      sha256,
      created: false,
    };
  }

  const built = await assembleCaseFile({
    admin: input.admin,
    actor: null,
    caseId: input.caseId,
    deps: input.deps,
    now: input.now,
  });
  return { ...built, created: true };
}
