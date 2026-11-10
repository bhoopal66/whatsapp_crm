import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BATCH_SIZE,
  type ClaimedDoc,
  type WorkerConfig,
  fileNameFor,
  type FsOps,
  loadConfig,
  makeDownload,
  nodeFs,
  parseMountPoints,
  processBatch,
  resolveMediaUrl,
  sanitizeBase,
} from './nas-worker';

describe('parseMountPoints', () => {
  it('reads the 5th field and decodes octal escapes', () => {
    const text = [
      '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
      '95 22 0:50 / /mnt/nas-share rw,relatime shared:60 - cifs //nas/share rw',
      '96 22 0:51 / /mnt/my\\040share rw - cifs //nas/b rw',
      '',
    ].join('\n');
    expect(parseMountPoints(text)).toEqual([
      '/',
      '/mnt/nas-share',
      '/mnt/my share',
    ]);
  });
});

describe('fileNameFor', () => {
  const at = '2026-03-04T21:30:00Z';
  const doc = (over: Partial<ClaimedDoc>) => ({
    kind: 'document' as const,
    mime: null,
    original_name: null,
    caption: null,
    received_at: at,
    ...over,
  });

  it('dates the name in the configured time zone', () => {
    const d = doc({ original_name: 'Passport.PDF' });
    expect(fileNameFor(d, 'Asia/Dubai')).toBe('2026-03-05 0130 Passport.pdf');
    expect(fileNameFor(d, 'UTC')).toBe('2026-03-04 2130 Passport.pdf');
  });

  it('names an image after the first line of its caption, else photo', () => {
    const img = doc({
      kind: 'image',
      mime: 'image/jpeg',
      caption: 'Emirates ID front\nsecond line',
    });
    expect(fileNameFor(img, 'UTC')).toBe(
      '2026-03-04 2130 Emirates ID front.jpg'
    );
    expect(fileNameFor(doc({ kind: 'image', mime: 'image/png' }), 'UTC')).toBe(
      '2026-03-04 2130 photo.png'
    );
  });

  it('takes the extension from the MIME when the name has none', () => {
    expect(
      fileNameFor(
        doc({
          caption: 'Salary certificate',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        'UTC'
      )
    ).toBe('2026-03-04 2130 Salary certificate.docx');
    expect(fileNameFor(doc({ mime: 'application/x-unknown' }), 'UTC')).toBe(
      '2026-03-04 2130 document.bin'
    );
  });

  it('sanitizes reserved characters and leading dots', () => {
    expect(fileNameFor(doc({ original_name: 'a/b:c*?.pdf' }), 'UTC')).toBe(
      '2026-03-04 2130 a-b-c--.pdf'
    );
    expect(sanitizeBase('...hidden  name. ', 'x')).toBe('hidden name');
    expect(sanitizeBase(' .. ', 'document')).toBe('document');
  });

  it('keeps Arabic', () => {
    expect(fileNameFor(doc({ original_name: 'كشف حساب.pdf' }), 'UTC')).toBe(
      '2026-03-04 2130 كشف حساب.pdf'
    );
  });

  it('caps a long name at 200 bytes without splitting a code point', () => {
    const name = fileNameFor(
      doc({ original_name: `${'ب'.repeat(300)}.pdf` }),
      'UTC'
    );
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200);
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name).not.toContain('�');
    expect(Buffer.from(name, 'utf8').toString('utf8')).toBe(name);
    // 200 - "2026-03-04 2130 " (16) - ".pdf" (4) = 180 bytes = 90 letters.
    expect(name).toBe(`2026-03-04 2130 ${'ب'.repeat(90)}.pdf`);
  });
});

describe('resolveMediaUrl', () => {
  const base = 'http://127.0.0.1:8000';
  it('rewrites a storage URL on any origin to the base', () => {
    for (const origin of [
      'https://old-tunnel.trycloudflare.com',
      'https://crm.example.com',
    ]) {
      expect(
        resolveMediaUrl(
          `${origin}/storage/v1/object/public/chat-media/account-1/inbound/a.jpg?x=1`,
          base
        )
      ).toEqual({
        ok: true,
        url: `${base}/storage/v1/object/public/chat-media/account-1/inbound/a.jpg?x=1`,
        internal: true,
      });
    }
  });

  it('allows other https URLs and refuses everything else', () => {
    expect(
      resolveMediaUrl('https://gate.whapi.cloud/media/1', base)
    ).toMatchObject({ ok: true, internal: false });
    expect(resolveMediaUrl('http://gate.whapi.cloud/media/1', base)).toEqual({
      ok: false,
    });
    expect(resolveMediaUrl('file:///etc/passwd', base)).toEqual({ ok: false });
    expect(resolveMediaUrl('not a url', base)).toEqual({ ok: false });
  });
});

describe('loadConfig', () => {
  it('names what is missing', () => {
    const r = loadConfig({});
    expect('error' in r && r.error).toMatch(
      /missing configuration: .*SUPABASE_SERVICE_ROLE_KEY/
    );
  });
  it('refuses a root outside the mount', () => {
    const r = loadConfig({
      SUPABASE_INTERNAL_URL: 'http://127.0.0.1:8000',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      CUSTOMER_DOCS_NAS_MOUNT: '/mnt/nas-share',
      CUSTOMER_DOCS_NAS_ROOT: '/mnt/other',
    });
    expect('error' in r && r.error).toMatch(/inside/);
  });
});

describe('processBatch', () => {
  let mount: string;
  let root: string;
  let config: WorkerConfig;
  let settled: Record<string, unknown>[];
  let calls: string[];
  let existing: string | null;
  let rows: ClaimedDoc[];

  const mountinfo = () =>
    Promise.resolve(`95 22 0:50 / ${mount} rw - cifs //nas/s rw\n`);
  const row = (over: Partial<ClaimedDoc> = {}): ClaimedDoc => ({
    id: '11111111-2222-3333-4444-555555555555',
    folder_id: 'f1',
    ref: 'TC-000123',
    kind: 'document',
    mime: 'application/pdf',
    original_name: 'Passport.pdf',
    caption: null,
    media_url:
      'https://tunnel.example.com/storage/v1/object/public/chat-media/x.pdf',
    received_at: '2026-03-04T21:30:00Z',
    attempts: 1,
    ...over,
  });
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push(name);
    if (name === 'customer_documents_claim') return rows;
    if (name === 'customer_documents_existing') return existing;
    settled.push(args);
    return 'done';
  };
  const bytesOf = (s: string) => new TextEncoder().encode(s);
  const okDownload = (s: string) => async () => ({
    ok: true as const,
    bytes: bytesOf(s),
  });

  beforeEach(async () => {
    mount = await mkdtemp(join(tmpdir(), 'nas-worker-'));
    root = join(mount, 'Customer Documents');
    config = {
      baseUrl: 'http://127.0.0.1:8000',
      serviceKey: 'k',
      nasRoot: root,
      nasMount: mount,
      timeZone: 'Asia/Dubai',
      pollSeconds: 20,
      batchSize: BATCH_SIZE,
    };
    settled = [];
    calls = [];
    existing = null;
    rows = [row()];
  });
  afterEach(async () => {
    await rm(mount, { recursive: true, force: true });
  });

  it('stores the file under the ref with the dated name', async () => {
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('PDF-1'),
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ ready: true, claimed: 1, stored: 1 });
    const name = '2026-03-05 0130 Passport.pdf';
    expect(await readFile(join(root, 'TC-000123', name), 'utf8')).toBe('PDF-1');
    expect(
      await readFile(join(root, '.wacrm-customer-docs'), 'utf8')
    ).toContain('wacrm');
    expect(settled[0]).toMatchObject({
      p_outcome: 'stored',
      p_size: 5,
      p_nas_name: name,
      p_error: null,
    });
    expect(settled[0].p_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(join(root, '.incoming'))).toEqual([]);
  });

  it('never overwrites: a taken name gets " (2)"', async () => {
    await mkdir(join(root, 'TC-000123'), { recursive: true });
    await writeFile(
      join(root, 'TC-000123', '2026-03-05 0130 Passport.pdf'),
      'OLD'
    );
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('NEW'),
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ stored: 1 });
    expect(
      await readFile(
        join(root, 'TC-000123', '2026-03-05 0130 Passport.pdf'),
        'utf8'
      )
    ).toBe('OLD');
    expect(
      await readFile(
        join(root, 'TC-000123', '2026-03-05 0130 Passport (2).pdf'),
        'utf8'
      )
    ).toBe('NEW');
    expect(settled[0]).toMatchObject({
      p_nas_name: '2026-03-05 0130 Passport (2).pdf',
    });
  });

  it('settles a known sha as duplicate and writes nothing', async () => {
    existing = '2026-01-01 1000 Passport.pdf';
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('PDF-1'),
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ duplicate: 1, stored: 0 });
    expect(settled[0]).toMatchObject({
      p_outcome: 'duplicate',
      p_size: 5,
      p_nas_name: null,
    });
    await expect(readdir(join(root, 'TC-000123'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('retries a download error and fails an oversize file, batch continues', async () => {
    rows = [
      row({ id: 'a1' }),
      row({ id: 'b2' }),
      row({ id: 'c3', media_url: 'http://x.example/a.pdf' }),
    ];
    const fetchImpl = async (url: string) => {
      expect(url.startsWith('http://127.0.0.1:8000/storage/v1/object/')).toBe(
        true
      );
      return rows.length && settled.length === 0
        ? new Response('nope', { status: 503 })
        : new Response('0123456789ABCDEF');
    };
    const download = makeDownload({
      baseUrl: config.baseUrl,
      serviceKey: 'k',
      fetchImpl,
      maxBytes: 10,
    });
    const r = await processBatch({
      config,
      rpc,
      download,
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ claimed: 3, retry: 1, failed: 2, stored: 0 });
    expect(settled.map((s) => [s.p_id, s.p_outcome, s.p_error])).toEqual([
      ['a1', 'retry', 'download HTTP 503'],
      ['b2', 'failed', 'too large'],
      ['c3', 'failed', 'unsupported media URL'],
    ]);
    await expect(readdir(join(root, 'TC-000123'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('claims nothing while the share is not mounted, and creates nothing', async () => {
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('x'),
      readMountInfo: async () => '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n',
    });
    expect(r).toEqual({ ready: false, reason: 'NAS share is not mounted' });
    expect(calls).toEqual([]);
    expect(await readdir(mount)).toEqual([]);
  });

  const tree = async () =>
    ((await readdir(mount, { recursive: true })) as string[]).sort();
  const name = '2026-03-05 0130 Passport.pdf';
  const inRef = (n: string) => join(root, 'TC-000123', n);

  it('stops the batch when the mount goes between rows, creating and settling nothing more', async () => {
    rows = [
      row({ id: 'a1' }),
      row({ id: 'b2', ref: 'TC-000456' }),
      row({ id: 'c3', ref: 'TC-000789' }),
    ];
    // Batch check and row a1's re-check see the mount; b2's does not.
    let reads = 0;
    const readMountInfo = async () =>
      ++reads <= 2 ? mountinfo() : '22 1 8:1 / / rw - ext4 /dev/sda1 rw\n';
    const downloaded: string[] = [];
    const r = await processBatch({
      config,
      rpc,
      download: async (url) => {
        downloaded.push(url);
        return { ok: true, bytes: bytesOf('PDF-1') };
      },
      readMountInfo,
    });
    expect(r).toEqual({ ready: false, reason: 'NAS share is not mounted' });
    expect(downloaded).toHaveLength(1);
    expect(settled.map((s) => [s.p_id, s.p_outcome])).toEqual([
      ['a1', 'stored'],
    ]);
    expect(await tree()).toEqual(
      [
        'Customer Documents',
        'Customer Documents/.incoming',
        'Customer Documents/.wacrm-customer-docs',
        'Customer Documents/TC-000123',
        `Customer Documents/TC-000123/${name}`,
      ].sort()
    );
  });

  it('never recreates a root that vanished after the check', async () => {
    const r = await processBatch({
      config,
      rpc,
      download: async () => {
        await rm(root, { recursive: true, force: true });
        return { ok: true, bytes: bytesOf('PDF-1') };
      },
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ ready: false });
    expect(settled).toEqual([]);
    expect(await readdir(mount)).toEqual([]);
  });

  // A file that appears at `target` right after the free-name check.
  const plantOnMiss = (target: string, body: string): FsOps => {
    let planted = false;
    return {
      ...nodeFs,
      stat: async (p) => {
        try {
          return await nodeFs.stat(p);
        } catch (e) {
          if (p === target && !planted) {
            planted = true;
            await writeFile(p, body);
          }
          throw e;
        }
      },
    };
  };

  it('never overwrites a file that appears at the chosen name before publishing', async () => {
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('OURS'),
      readMountInfo: mountinfo,
      fs: plantOnMiss(inRef(name), 'THEIRS'),
    });
    expect(r).toMatchObject({ stored: 1 });
    expect(await readFile(inRef(name), 'utf8')).toBe('THEIRS');
    const second = '2026-03-05 0130 Passport (2).pdf';
    expect(await readFile(inRef(second), 'utf8')).toBe('OURS');
    expect(settled[0]).toMatchObject({ p_nas_name: second });
    expect(await readdir(join(root, '.incoming'))).toEqual([]);
  });

  it('publishes by exclusive copy when hard links are refused', async () => {
    const links: string[] = [];
    const fs: FsOps = {
      ...plantOnMiss(inRef(name), 'THEIRS'),
      link: async (_from, to) => {
        links.push(to);
        throw Object.assign(new Error('link'), {
          code: 'EPERM',
          syscall: 'link',
        });
      },
    };
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('OURS'),
      readMountInfo: mountinfo,
      fs,
    });
    expect(r).toMatchObject({ stored: 1 });
    expect(links.length).toBeGreaterThan(0);
    expect(await readFile(inRef(name), 'utf8')).toBe('THEIRS');
    const second = '2026-03-05 0130 Passport (2).pdf';
    expect(await readFile(inRef(second), 'utf8')).toBe('OURS');
    expect(settled[0]).toMatchObject({ p_nas_name: second });
    expect(await readdir(join(root, '.incoming'))).toEqual([]);
  });

  it('adopts an identical file an earlier attempt published, writing nothing', async () => {
    await mkdir(join(root, 'TC-000123'), { recursive: true });
    await writeFile(inRef(name), 'OTHER');
    const second = '2026-03-05 0130 Passport (2).pdf';
    await writeFile(inRef(second), 'PDF-1');
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('PDF-1'),
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ stored: 1 });
    expect(settled[0]).toMatchObject({
      p_outcome: 'stored',
      p_nas_name: second,
      p_size: 5,
    });
    expect((await readdir(join(root, 'TC-000123'))).sort()).toEqual(
      [name, second].sort()
    );
    expect(await readFile(inRef(name), 'utf8')).toBe('OTHER');
  });

  it('does not adopt a same-name, same-size file with different bytes', async () => {
    await mkdir(join(root, 'TC-000123'), { recursive: true });
    await writeFile(inRef(name), 'PDF-2');
    const r = await processBatch({
      config,
      rpc,
      download: okDownload('PDF-1'),
      readMountInfo: mountinfo,
    });
    expect(r).toMatchObject({ stored: 1 });
    const second = '2026-03-05 0130 Passport (2).pdf';
    expect(settled[0]).toMatchObject({ p_nas_name: second });
    expect(await readFile(inRef(name), 'utf8')).toBe('PDF-2');
    expect(await readFile(inRef(second), 'utf8')).toBe('PDF-1');
  });
});
