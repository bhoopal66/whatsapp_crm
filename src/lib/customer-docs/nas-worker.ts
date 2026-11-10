// Customer documents NAS copier. Claims pending `customer_documents`
// rows over PostgREST, downloads each file and writes it to
// `<NAS root>/<ref>/<file name>` on the Synology share.
//
// It runs as its own systemd service (scripts/customer-docs-worker.mjs,
// scripts/systemd/wacrm-customer-docs.service), never inside the Next.js
// app: the share is a `hard` CIFS mount, so a NAS outage blocks file I/O,
// and that must never stall the app.
//
// Node loads this file directly with type stripping, so it imports only
// `node:` built-ins and uses only erasable TypeScript: no `@/` aliases,
// no relative or npm imports, no enums, namespaces or parameter
// properties.
//
// Logging rule: ids and refs only. Never a URL (a storage URL is a
// bearer link), file contents, the service key or a customer's file
// name — which is why fs errors are described by syscall and code, not
// by their message (that carries the path).

import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const MARKER_FILE = '.wacrm-customer-docs';
export const INCOMING_DIR = '.incoming';
export const BATCH_SIZE = 10;
export const MAX_BYTES = 100 * 1024 * 1024;
export const DOWNLOAD_TIMEOUT_MS = 60_000;
export const RPC_TIMEOUT_MS = 30_000;
export const MAX_NAME_BYTES = 200;
const MAX_COLLISIONS = 1000;

const REF_RE = /^TC-[0-9]{6,}$/;
// A row id becomes a path segment of the part file: never let it walk.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// ---------------------------------------------------------------- types

export type DocKind = 'document' | 'image';

export type ClaimedDoc = {
  id: string;
  folder_id: string;
  ref: string;
  kind: DocKind;
  mime: string | null;
  original_name: string | null;
  caption: string | null;
  media_url: string;
  received_at: string;
  attempts: number;
};

export type WorkerConfig = {
  baseUrl: string;
  serviceKey: string;
  nasRoot: string;
  nasMount: string;
  timeZone: string;
  pollSeconds: number;
  batchSize: number;
};

export type Outcome = 'stored' | 'duplicate' | 'retry' | 'failed';

export type Rpc = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export type Downloaded =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; outcome: 'retry' | 'failed'; error: string };

export type Download = (mediaUrl: string) => Promise<Downloaded>;

/** The file system calls the worker makes; tests may swap them. */
export type FsOps = {
  stat: (path: string) => Promise<{ size: number }>;
  mkdir: (path: string, opts: { recursive: true }) => Promise<unknown>;
  writeFile: (path: string, data: Uint8Array | string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
};

export const nodeFs: FsOps = { stat, mkdir, writeFile, rename, unlink };

export function readProcMountInfo(): Promise<string> {
  return readFile('/proc/self/mountinfo', 'utf8');
}

// --------------------------------------------------------------- config

type Env = Record<string, string | undefined>;

export function loadConfig(
  env: Env
): { config: WorkerConfig } | { error: string } {
  const base = (env.SUPABASE_INTERNAL_URL || env.NEXT_PUBLIC_SUPABASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const rootRaw = (env.CUSTOMER_DOCS_NAS_ROOT || '').trim();
  const mountRaw = (env.CUSTOMER_DOCS_NAS_MOUNT || '').trim();

  const missing: string[] = [];
  if (!base)
    missing.push('SUPABASE_INTERNAL_URL (or NEXT_PUBLIC_SUPABASE_URL)');
  if (!key) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!rootRaw) missing.push('CUSTOMER_DOCS_NAS_ROOT');
  if (!mountRaw) missing.push('CUSTOMER_DOCS_NAS_MOUNT');
  if (missing.length) {
    return { error: `missing configuration: ${missing.join(', ')}` };
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return { error: 'invalid configuration: Supabase URL is not a URL' };
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    return { error: 'invalid configuration: Supabase URL must be http(s)' };
  }
  if (!isAbsolute(rootRaw) || !isAbsolute(mountRaw)) {
    return {
      error:
        'invalid configuration: CUSTOMER_DOCS_NAS_ROOT and CUSTOMER_DOCS_NAS_MOUNT must be absolute paths',
    };
  }
  const nasMount = resolve(mountRaw);
  const nasRoot = resolve(rootRaw);
  const rel = relative(nasMount, nasRoot);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return {
      error:
        'invalid configuration: CUSTOMER_DOCS_NAS_ROOT must lie inside CUSTOMER_DOCS_NAS_MOUNT',
    };
  }

  const timeZone = (env.CUSTOMER_DOCS_TIME_ZONE || '').trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    return {
      error:
        'invalid configuration: CUSTOMER_DOCS_TIME_ZONE is not a time zone',
    };
  }

  const pollRaw = (env.CUSTOMER_DOCS_POLL_SECONDS || '').trim();
  const pollSeconds = pollRaw ? Number(pollRaw) : 20;
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1 || pollSeconds > 3600) {
    return {
      error:
        'invalid configuration: CUSTOMER_DOCS_POLL_SECONDS must be 1 to 3600',
    };
  }

  return {
    config: {
      baseUrl: base,
      serviceKey: key,
      nasRoot,
      nasMount,
      timeZone,
      pollSeconds,
      batchSize: BATCH_SIZE,
    },
  };
}

// ----------------------------------------------------------- mountinfo

/** `\040` and friends: mountinfo escapes space, tab, newline, backslash. */
function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_m, oct: string) =>
    String.fromCharCode(parseInt(oct, 8))
  );
}

/** Mount points listed in /proc/self/mountinfo text (the 5th field). */
export function parseMountPoints(text: string): string[] {
  const points: string[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(' ');
    if (fields.length < 5) continue;
    points.push(decodeMountField(fields[4]));
  }
  return points;
}

export type NasState = { ready: true } | { ready: false; reason: string };

/**
 * Ready means the share is mounted and the root carries the marker.
 * With the mount present, a missing root or marker is created; with it
 * absent nothing is created, because the mount point directory is then
 * on local disk.
 */
export async function checkNas(
  config: Pick<WorkerConfig, 'nasMount' | 'nasRoot'>,
  fs: FsOps,
  readMountInfo: () => Promise<string>
): Promise<NasState> {
  let info: string;
  try {
    info = await readMountInfo();
  } catch (e) {
    return {
      ready: false,
      reason: `cannot read mountinfo (${describeError(e)})`,
    };
  }
  if (!parseMountPoints(info).includes(config.nasMount)) {
    return { ready: false, reason: 'NAS share is not mounted' };
  }
  const marker = join(config.nasRoot, MARKER_FILE);
  try {
    await fs.stat(marker);
    return { ready: true };
  } catch (e) {
    if (errCode(e) !== 'ENOENT') {
      return {
        ready: false,
        reason: `NAS root not reachable (${describeError(e)})`,
      };
    }
  }
  try {
    await fs.mkdir(config.nasRoot, { recursive: true });
    await fs.writeFile(marker, 'wacrm customer documents root\n');
    return { ready: true };
  } catch (e) {
    return {
      ready: false,
      reason: `cannot create NAS root (${describeError(e)})`,
    };
  }
}

// ----------------------------------------------------------- file names

const MIME_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tif',
  'image/bmp': 'bmp',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/rtf': 'rtf',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};

/** `name.ext` → [name, ext]; a leading dot or a non-word suffix is no extension. */
function splitExtension(name: string): [string, string | null] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, null];
  const ext = name.slice(dot + 1);
  if (!/^[A-Za-z0-9]{1,10}$/.test(ext)) return [name, null];
  return [name.slice(0, dot), ext.toLowerCase()];
}

export function extensionFor(
  originalName: string | null,
  mime: string | null
): string {
  if (originalName) {
    const [, ext] = splitExtension(originalName.trim());
    if (ext) return ext;
  }
  const type = (mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[type] ?? 'bin';
}

/**
 * A safe file name part. Whitespace (newlines included) collapses to one
 * space, other control characters and bidi overrides go, the characters
 * Windows/SMB refuse become '-', and spaces and dots are trimmed at both
 * ends. Any script is kept.
 */
export function sanitizeBase(raw: string, fallback: string): string {
  const s = raw
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/ {2,}/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '');
  return s || fallback;
}

/** Cut `s` at a code point boundary to at most `maxBytes` UTF-8 bytes. */
function cutToBytes(s: string, maxBytes: number): string {
  let out = '';
  let used = 0;
  for (const cp of s) {
    const n = Buffer.byteLength(cp, 'utf8');
    if (used + n > maxBytes) break;
    out += cp;
    used += n;
  }
  return out;
}

/** `YYYY-MM-DD HHmm` of an instant in a time zone, 24-hour. */
export function stampFor(receivedAt: string, timeZone: string): string {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) throw new Error('invalid received_at');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}${get('minute')}`;
}

export function fileNameFor(
  doc: Pick<
    ClaimedDoc,
    'kind' | 'mime' | 'original_name' | 'caption' | 'received_at'
  >,
  timeZone: string
): string {
  const ext = extensionFor(doc.original_name, doc.mime);
  let base: string;
  if (doc.kind === 'image') {
    const firstLine = (doc.caption || '').trim().split(/\r\n|\r|\n/)[0];
    base = sanitizeBase(firstLine, 'photo');
  } else {
    const [nameBase] = splitExtension((doc.original_name || '').trim());
    base = sanitizeBase(nameBase, '');
    if (!base) base = sanitizeBase(doc.caption || '', 'document');
  }
  const prefix = `${stampFor(doc.received_at, timeZone)} `;
  const budget =
    MAX_NAME_BYTES -
    Buffer.byteLength(prefix, 'utf8') -
    Buffer.byteLength(`.${ext}`, 'utf8');
  if (Buffer.byteLength(base, 'utf8') > budget) {
    base = cutToBytes(base, budget).replace(/[ .]+$/, '');
  }
  return `${prefix}${base}.${ext}`;
}

// ------------------------------------------------------------ download

/**
 * Where to fetch a stored media URL from. A Supabase Storage object is
 * fetched from the configured base: the public origin changes with the
 * Cloudflare tunnel, so it is matched on the path, never the origin.
 * Anything else must be https.
 */
export function resolveMediaUrl(
  mediaUrl: string,
  baseUrl: string
): { ok: true; url: string; internal: boolean } | { ok: false } {
  let u: URL;
  try {
    u = new URL(mediaUrl);
  } catch {
    return { ok: false };
  }
  const at = u.pathname.indexOf('/storage/v1/object/');
  if (at >= 0) {
    return {
      ok: true,
      url: `${baseUrl.replace(/\/+$/, '')}${u.pathname.slice(at)}${u.search}`,
      internal: true,
    };
  }
  if (u.protocol !== 'https:') return { ok: false };
  return { ok: true, url: u.toString(), internal: false };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function makeDownload(opts: {
  baseUrl: string;
  serviceKey: string;
  fetchImpl?: FetchLike;
  maxBytes?: number;
  timeoutMs?: number;
}): Download {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  return async (mediaUrl) => {
    const target = resolveMediaUrl(mediaUrl, opts.baseUrl);
    if (!target.ok) {
      return { ok: false, outcome: 'failed', error: 'unsupported media URL' };
    }
    // The service key goes only to our own Supabase, never to a gateway.
    const headers: Record<string, string> = target.internal
      ? { apikey: opts.serviceKey, Authorization: `Bearer ${opts.serviceKey}` }
      : {};
    try {
      const res = await fetchImpl(target.url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return {
          ok: false,
          outcome: 'retry',
          error: `download HTTP ${res.status}`,
        };
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, outcome: 'failed', error: 'too large' };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            return { ok: false, outcome: 'failed', error: 'too large' };
          }
          chunks.push(value);
        }
      }
      return { ok: true, bytes: Buffer.concat(chunks, total) };
    } catch (e) {
      return { ok: false, outcome: 'retry', error: describeDownloadError(e) };
    }
  };
}

function describeDownloadError(e: unknown): string {
  const name = (e as { name?: unknown })?.name;
  if (name === 'TimeoutError' || name === 'AbortError')
    return 'download timed out';
  const cause = (e as { cause?: { code?: unknown } })?.cause;
  if (cause && typeof cause.code === 'string')
    return `download failed (${cause.code})`;
  return 'download failed';
}

// ------------------------------------------------------------------ rpc

export function makeRpc(opts: {
  baseUrl: string;
  serviceKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Rpc {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  return async (name, args) => {
    const res = await fetchImpl(`${base}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: opts.serviceKey,
        Authorization: `Bearer ${opts.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(opts.timeoutMs ?? RPC_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const body = JSON.parse(text) as { message?: unknown; hint?: unknown };
        detail = [body.message, body.hint]
          .filter((v): v is string => typeof v === 'string' && v !== '')
          .join(' / ');
      } catch {
        // not JSON: the status alone
      }
      const err = new Error(
        `${name}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`.slice(0, 300)
      ) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  };
}

// -------------------------------------------------------------- writing

function errCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Short, path-free description: fs messages carry the customer's file name. */
export function describeError(e: unknown): string {
  const code = errCode(e);
  if (code) {
    const syscall = (e as { syscall?: unknown }).syscall;
    return typeof syscall === 'string' ? `${syscall} ${code}` : code;
  }
  if (e instanceof Error) return e.message.slice(0, 200);
  return 'unknown error';
}

async function exists(fs: FsOps, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (e) {
    if (errCode(e) === 'ENOENT') return false;
    throw e;
  }
}

/** `name.ext`, else `name (2).ext`, `(3)`, …: the first that does not exist. */
export async function pickFreeName(
  fs: FsOps,
  folder: string,
  fileName: string
): Promise<string> {
  const dot = fileName.lastIndexOf('.');
  const stem = fileName.slice(0, dot);
  const ext = fileName.slice(dot);
  for (let n = 1; n <= MAX_COLLISIONS; n++) {
    const candidate = n === 1 ? fileName : `${stem} (${n})${ext}`;
    if (!(await exists(fs, join(folder, candidate)))) return candidate;
  }
  throw new Error('no free file name');
}

type WriteResult =
  | { ok: true; name: string }
  | { ok: false; outcome: 'retry' | 'failed'; error: string };

/** Write into the ref's folder without ever overwriting a file. */
export async function writeDocument(
  fs: FsOps,
  nasRoot: string,
  doc: Pick<ClaimedDoc, 'id' | 'ref'>,
  fileName: string,
  bytes: Uint8Array
): Promise<WriteResult> {
  if (!REF_RE.test(doc.ref)) {
    return { ok: false, outcome: 'failed', error: 'invalid folder reference' };
  }
  if (!ID_RE.test(doc.id)) {
    return { ok: false, outcome: 'failed', error: 'invalid document id' };
  }
  const folder = join(nasRoot, doc.ref);
  const incoming = join(nasRoot, INCOMING_DIR);
  const part = join(incoming, `${doc.id}.part`);
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(incoming, { recursive: true });
  // A leftover part file from a crash is simply overwritten.
  await fs.writeFile(part, bytes);
  let renamed = false;
  try {
    const name = await pickFreeName(fs, folder, fileName);
    const dest = join(folder, name);
    await fs.rename(part, dest);
    renamed = true;
    const { size } = await fs.stat(dest);
    if (size !== bytes.byteLength) {
      // Ours, just written and wrong: remove it so the retry starts clean.
      await fs.unlink(dest).catch(() => {});
      return {
        ok: false,
        outcome: 'retry',
        error: 'size mismatch after write',
      };
    }
    return { ok: true, name };
  } finally {
    if (!renamed) await fs.unlink(part).catch(() => {});
  }
}

// ---------------------------------------------------------------- batch

export type BatchDeps = {
  config: WorkerConfig;
  rpc: Rpc;
  download: Download;
  fs?: FsOps;
  readMountInfo?: () => Promise<string>;
  log?: (line: string) => void;
  /** Checked between rows: an abort finishes the current file only. */
  signal?: AbortSignal;
};

export type BatchResult =
  | { ready: false; reason: string }
  | {
      ready: true;
      claimed: number;
      stored: number;
      duplicate: number;
      retry: number;
      failed: number;
      /** Claimed but left for the claim expiry (stopping). */
      skipped: number;
      settleErrors: number;
    };

type RowResult =
  | { outcome: 'stored'; sha256: string; size: number; name: string }
  | { outcome: 'duplicate'; sha256: string; size: number }
  | { outcome: 'retry' | 'failed'; error: string };

async function processRow(
  doc: ClaimedDoc,
  deps: Required<Pick<BatchDeps, 'config' | 'rpc' | 'download' | 'fs'>>
): Promise<RowResult> {
  const got = await deps.download(doc.media_url);
  if (!got.ok) return { outcome: got.outcome, error: got.error };
  const bytes = got.bytes;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const size = bytes.byteLength;

  const existing = await deps.rpc('customer_documents_existing', {
    p_folder_id: doc.folder_id,
    p_sha256: sha256,
  });
  if (typeof existing === 'string' && existing !== '') {
    return { outcome: 'duplicate', sha256, size };
  }

  const fileName = fileNameFor(doc, deps.config.timeZone);
  const written = await writeDocument(
    deps.fs,
    deps.config.nasRoot,
    doc,
    fileName,
    bytes
  );
  if (!written.ok) return { outcome: written.outcome, error: written.error };
  return { outcome: 'stored', sha256, size, name: written.name };
}

export async function processBatch(deps: BatchDeps): Promise<BatchResult> {
  const fs = deps.fs ?? nodeFs;
  const log = deps.log ?? (() => {});
  const state = await checkNas(
    deps.config,
    fs,
    deps.readMountInfo ?? readProcMountInfo
  );
  if (!state.ready) return state;

  const claimed = await deps.rpc('customer_documents_claim', {
    p_limit: deps.config.batchSize,
  });
  if (!Array.isArray(claimed))
    throw new Error('customer_documents_claim: not an array');
  const rows = claimed as ClaimedDoc[];

  const result = {
    ready: true as const,
    claimed: rows.length,
    stored: 0,
    duplicate: 0,
    retry: 0,
    failed: 0,
    skipped: 0,
    settleErrors: 0,
  };

  for (const doc of rows) {
    if (deps.signal?.aborted) {
      result.skipped++;
      continue;
    }
    let row: RowResult;
    try {
      row = await processRow(doc, {
        config: deps.config,
        rpc: deps.rpc,
        download: deps.download,
        fs,
      });
    } catch (e) {
      row = { outcome: 'retry', error: describeError(e) };
    }
    result[row.outcome]++;
    if (row.outcome !== 'stored') {
      const why = 'error' in row ? `: ${row.error}` : '';
      log(`row ${doc.id} (${doc.ref}) ${row.outcome}${why}`);
    }
    try {
      await deps.rpc('customer_documents_settle', {
        p_id: doc.id,
        p_outcome: row.outcome,
        p_sha256: 'sha256' in row ? row.sha256 : null,
        p_size: 'size' in row ? row.size : null,
        p_nas_name: row.outcome === 'stored' ? row.name : null,
        p_error: 'error' in row ? row.error : null,
      });
    } catch (e) {
      // The 15-minute claim expiry puts the row back in the queue.
      result.settleErrors++;
      log(`row ${doc.id} (${doc.ref}) settle failed: ${describeError(e)}`);
    }
  }
  return result;
}

// --------------------------------------------------------------- worker

export type WorkerDeps = Partial<Omit<BatchDeps, 'config'>> & {
  /** One batch, then return. */
  once?: boolean;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Runs until `signal` aborts (or one batch with `once`); answers an exit code. */
export async function runWorker(
  config: WorkerConfig,
  deps: WorkerDeps = {}
): Promise<{ exitCode: number }> {
  const now = deps.now ?? (() => new Date());
  const log =
    deps.log ??
    ((line: string) =>
      console.log(`${now().toISOString()} [customer-docs] ${line}`));
  const sleep = deps.sleep ?? abortableSleep;
  const rpc = deps.rpc ?? makeRpc(config);
  const download = deps.download ?? makeDownload(config);
  let lastState = '';

  for (;;) {
    let ok = true;
    let full = false;
    try {
      const r = await processBatch({ ...deps, config, rpc, download, log });
      const stateLine = r.ready ? 'ready' : `not ready: ${r.reason}`;
      if (stateLine !== lastState) {
        log(`NAS ${stateLine}`);
        lastState = stateLine;
      }
      if (!r.ready) {
        ok = false;
      } else {
        if (r.claimed > 0) {
          log(
            `batch: claimed ${r.claimed}, stored ${r.stored}, duplicate ${r.duplicate}, ` +
              `retry ${r.retry}, failed ${r.failed}` +
              (r.skipped ? `, left for later ${r.skipped}` : '')
          );
        }
        ok = r.retry === 0 && r.failed === 0 && r.settleErrors === 0;
        full = r.claimed >= config.batchSize;
      }
    } catch (e) {
      ok = false;
      log(`batch error: ${describeError(e)}`);
    }
    if (deps.once) return { exitCode: ok ? 0 : 1 };
    if (deps.signal?.aborted) return { exitCode: 0 };
    if (!full) await sleep(config.pollSeconds * 1000, deps.signal);
    if (deps.signal?.aborted) return { exitCode: 0 };
  }
}
