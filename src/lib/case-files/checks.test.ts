import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CASE_FILE_MIME,
  imageSize,
  isRealDate,
  normalizeMime,
  renameFor,
  runChecks,
  sanitizeOriginalName,
  sha256Hex,
  type CheckSpec,
} from './checks';
import vectorFile from './render-name.vectors.json';

const TODAY = '2026-11-10';
const PDF = 'application/pdf';
const JPEG = 'image/jpeg';
const PNG = 'image/png';

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function pngHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    ...[0x49, 0x48, 0x44, 0x52], // IHDR
    ...u32(width),
    ...u32(height),
    8,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // CRC (not checked)
  ]);
}

function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    // APP0 (JFIF), length 16
    0xff,
    0xe0,
    ...u16(16),
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    // DHT (C4) must be skipped, not read as a SOF
    0xff,
    0xc4,
    ...u16(4),
    0x00,
    0x00,
    // SOF2, length 17: precision, height, width, 3 components
    0xff,
    0xc2,
    ...u16(17),
    8,
    ...u16(height),
    ...u16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

// FF D8, then a SOF0 cut off after its length and precision.
const TRUNCATED_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58,
]);

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return doc.save();
}

let onePage: Uint8Array;
let threePages: Uint8Array;
let encrypted: Uint8Array;
const corrupt = new TextEncoder().encode(
  '%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >>\ngarbage %%EOF'
);

beforeAll(async () => {
  onePage = await pdfWithPages(1);
  threePages = await pdfWithPages(3);
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.context.trailerInfo.Encrypt = doc.context.obj({ Filter: 'Standard' });
  encrypted = await doc.save({ useObjectStreams: false });
});

const spec = (over: Partial<CheckSpec> = {}): CheckSpec => ({
  maxMb: 10,
  allowedMime: CASE_FILE_MIME,
  minValidDays: null,
  ...over,
});

describe('normalizeMime', () => {
  it('lower-cases, drops parameters and trims', () => {
    expect(normalizeMime(' Application/PDF ; charset=binary')).toBe(PDF);
    expect(normalizeMime('IMAGE/PNG')).toBe(PNG);
  });
});

describe('runChecks: mime', () => {
  it('passes a matching type', async () => {
    const out = await runChecks(onePage, PDF, null, { today: TODAY });
    expect(out.checks[0]).toEqual({ name: 'mime', ok: true, detail: null });
  });

  it('refuses a type outside the spec list', async () => {
    const out = await runChecks(
      pngHeader(800, 800),
      PNG,
      spec({ allowedMime: [PDF] }),
      {
        today: TODAY,
      }
    );
    expect(out.ok).toBe(false);
    expect(out.checks.map((c) => c.name)).toEqual(['mime', 'size']);
    expect(out.checks[0]).toEqual({
      name: 'mime',
      ok: false,
      detail: 'not_allowed',
    });
  });

  it('refuses a type outside the closed list even if a spec lists it', async () => {
    const out = await runChecks(
      new Uint8Array([1, 2, 3]),
      'text/plain',
      spec({
        allowedMime: ['text/plain'],
      }),
      { today: TODAY }
    );
    expect(out.checks[0].detail).toBe('not_allowed');
  });

  it('refuses bytes that do not match the declared type', async () => {
    const out = await runChecks(pngHeader(800, 800), PDF, null, {
      today: TODAY,
    });
    expect(out.ok).toBe(false);
    expect(out.checks[0]).toEqual({
      name: 'mime',
      ok: false,
      detail: 'magic_mismatch',
    });
    // nothing after a failed mime check but size
    expect(out.checks.map((c) => c.name)).toEqual(['mime', 'size']);
    expect(out.pages).toBeNull();
  });

  it('fails a 0-byte file on magic bytes', async () => {
    const out = await runChecks(new Uint8Array(0), PDF, null, { today: TODAY });
    expect(out.checks[0].detail).toBe('magic_mismatch');
    expect(out.ok).toBe(false);
  });

  it('normalises the declared mime', async () => {
    const out = await runChecks(onePage, 'Application/PDF; x=y', null, {
      today: TODAY,
    });
    expect(out.ok).toBe(true);
  });
});

describe('runChecks: size', () => {
  it('passes exactly maxMb MiB and fails one byte more', async () => {
    const exact = new Uint8Array(1024 * 1024);
    exact.set(pngHeader(800, 800));
    const ok = await runChecks(exact, PNG, spec({ maxMb: 1 }), {
      today: TODAY,
    });
    expect(ok.checks[1]).toEqual({ name: 'size', ok: true, detail: null });

    const over = new Uint8Array(1024 * 1024 + 1);
    over.set(pngHeader(800, 800));
    const no = await runChecks(over, PNG, spec({ maxMb: 1 }), { today: TODAY });
    expect(no.ok).toBe(false);
    expect(no.checks[1]).toEqual({
      name: 'size',
      ok: false,
      detail: 'too_large',
    });
  });

  it('defaults to 10 MB with a null spec', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pngHeader(800, 800));
    const out = await runChecks(big, PNG, null, { today: TODAY });
    expect(out.checks[1].detail).toBe('too_large');
  });
});

describe('runChecks: readable (pdf)', () => {
  it('counts pages', async () => {
    const one = await runChecks(onePage, PDF, null, { today: TODAY });
    expect(one.ok).toBe(true);
    expect(one.pages).toBe(1);
    expect(one.checks[2]).toEqual({ name: 'readable', ok: true, detail: null });

    const three = await runChecks(threePages, PDF, spec(), { today: TODAY });
    expect(three.ok).toBe(true);
    expect(three.pages).toBe(3);
  });

  it('fails an encrypted PDF', async () => {
    const out = await runChecks(encrypted, PDF, null, { today: TODAY });
    expect(out.ok).toBe(false);
    expect(out.checks[2]).toEqual({
      name: 'readable',
      ok: false,
      detail: 'unreadable',
    });
    expect(out.pages).toBeNull();
  });

  it('fails a corrupt PDF', async () => {
    const out = await runChecks(corrupt, PDF, null, { today: TODAY });
    expect(out.checks[2]).toEqual({
      name: 'readable',
      ok: false,
      detail: 'unreadable',
    });
    expect(out.pages).toBeNull();
  });

  it('parses no more than the size limit', async () => {
    // A valid PDF padded past 1 MiB: the parser only sees the first MiB,
    // which still holds the whole document.
    const padded = new Uint8Array(1024 * 1024 + 10);
    padded.set(onePage);
    const out = await runChecks(padded, PDF, spec({ maxMb: 1 }), {
      today: TODAY,
    });
    expect(out.checks.map((c) => [c.name, c.ok])).toEqual([
      ['mime', true],
      ['size', false],
      ['readable', true],
    ]);
  });
});

describe('runChecks: images', () => {
  it('passes 600x600 PNG and JPEG with pages = 1', async () => {
    for (const [bytes, mime] of [
      [pngHeader(600, 600), PNG],
      [jpegHeader(600, 600), JPEG],
    ] as const) {
      const out = await runChecks(bytes, mime, null, { today: TODAY });
      expect(out.ok).toBe(true);
      expect(out.pages).toBe(1);
      expect(out.checks[2]).toEqual({
        name: 'resolution',
        ok: true,
        detail: '600x600',
      });
    }
  });

  it('fails 599x1200 as low_resolution', async () => {
    for (const [bytes, mime] of [
      [pngHeader(599, 1200), PNG],
      [jpegHeader(599, 1200), JPEG],
    ] as const) {
      const out = await runChecks(bytes, mime, null, { today: TODAY });
      expect(out.ok).toBe(false);
      expect(out.checks[2]).toEqual({
        name: 'resolution',
        ok: false,
        detail: 'low_resolution',
      });
      expect(out.pages).toBe(1);
    }
  });

  it('fails a truncated JPEG as unreadable', async () => {
    const out = await runChecks(TRUNCATED_JPEG, JPEG, null, { today: TODAY });
    expect(out.checks[2]).toEqual({
      name: 'readable',
      ok: false,
      detail: 'unreadable',
    });
    expect(out.pages).toBeNull();
  });
});

describe('imageSize', () => {
  it('reads PNG IHDR and the first JPEG SOF past a DHT', () => {
    expect(imageSize(pngHeader(599, 1200), PNG)).toEqual({
      width: 599,
      height: 1200,
    });
    expect(imageSize(jpegHeader(599, 1200), JPEG)).toEqual({
      width: 599,
      height: 1200,
    });
  });

  it('returns null for truncated or malformed headers', () => {
    expect(imageSize(TRUNCATED_JPEG, JPEG)).toBeNull();
    expect(imageSize(pngHeader(600, 600).subarray(0, 20), PNG)).toBeNull();
    expect(
      imageSize(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]), JPEG)
    ).toBeNull();
    // a zero length cannot advance the walk
    expect(
      imageSize(
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0, 0]),
        JPEG
      )
    ).toBeNull();
    expect(imageSize(pngHeader(600, 600), 'image/gif')).toBeNull();
  });

  it('honours a subarray offset', () => {
    const buf = new Uint8Array(40);
    buf.set(pngHeader(700, 800), 7);
    expect(imageSize(buf.subarray(7), PNG)).toEqual({
      width: 700,
      height: 800,
    });
  });
});

describe('runChecks: expiry', () => {
  const s = spec({ minValidDays: 30 });

  it('passes exactly today + minValidDays and fails one day earlier', async () => {
    const at = await runChecks(onePage, PDF, s, {
      today: TODAY,
      expiresOn: '2026-12-10',
    });
    expect(at.ok).toBe(true);
    expect(at.checks[3]).toEqual({ name: 'expiry', ok: true, detail: null });

    const before = await runChecks(onePage, PDF, s, {
      today: TODAY,
      expiresOn: '2026-12-09',
    });
    expect(before.ok).toBe(false);
    expect(before.checks[3]).toEqual({
      name: 'expiry',
      ok: false,
      detail: 'expiring',
    });
  });

  it('runs only with both minValidDays and expiresOn', async () => {
    const noDate = await runChecks(onePage, PDF, s, { today: TODAY });
    expect(noDate.checks.some((c) => c.name === 'expiry')).toBe(false);
    const noRule = await runChecks(onePage, PDF, null, {
      today: TODAY,
      expiresOn: '2020-01-01',
    });
    expect(noRule.ok).toBe(true);
    expect(noRule.checks.some((c) => c.name === 'expiry')).toBe(false);
  });

  it('fails an impossible date instead of throwing', async () => {
    const out = await runChecks(onePage, PDF, s, {
      today: TODAY,
      expiresOn: '2026-02-30',
    });
    expect(out.checks[3]).toEqual({
      name: 'expiry',
      ok: false,
      detail: 'invalid_date',
    });
    const badToday = await runChecks(onePage, PDF, s, {
      today: 'nope',
      expiresOn: '2027-01-01',
    });
    expect(badToday.ok).toBe(false);
  });
});

describe('isRealDate', () => {
  it('accepts real dates only', () => {
    expect(isRealDate('2026-11-10')).toBe(true);
    expect(isRealDate('2028-02-29')).toBe(true);
    expect(isRealDate('2026-02-29')).toBe(false);
    expect(isRealDate('2026-02-30')).toBe(false);
    expect(isRealDate('2026-13-45')).toBe(false);
    expect(isRealDate('2026-1-05')).toBe(false);
    expect(isRealDate('2026-11-10T00:00:00Z')).toBe(false);
    expect(isRealDate('')).toBe(false);
  });
});

describe('sanitizeOriginalName', () => {
  it('strips traversal, separators and control characters', () => {
    expect(sanitizeOriginalName('../../evil.sh')).toBe('evil.sh');
    expect(sanitizeOriginalName('..\\..\\win.ini')).toBe('win.ini');
    expect(sanitizeOriginalName('a\u0000b\nc\u007fd\u0085e.pdf')).toBe(
      'abcde.pdf'
    );
    expect(sanitizeOriginalName('  . .hidden.pdf ')).toBe('hidden.pdf');
  });

  it("falls back to 'file' and cuts to 200 characters", () => {
    expect(sanitizeOriginalName('')).toBe('file');
    expect(sanitizeOriginalName('../..//')).toBe('file');
    expect(sanitizeOriginalName('x'.repeat(300))).toBe('x'.repeat(200));
    // 200 code points, never half a surrogate pair
    const cut = sanitizeOriginalName('😀'.repeat(250));
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut).toBe('😀'.repeat(200));
  });

  it('keeps Arabic names', () => {
    expect(sanitizeOriginalName('جواز سفر.pdf')).toBe('جواز سفر.pdf');
  });
});

describe('renameFor', () => {
  type Vector = {
    id: string;
    pattern: string | null;
    case: string | null;
    company: string | null;
    doc: string | null;
    date: string;
    mime: string | null;
    expected: string;
  };
  const vectors = vectorFile.vectors as Vector[];

  it('has the 20 vectors, with the long inputs the ids promise', () => {
    expect(vectors).toHaveLength(20);
    const long = vectors.find((v) => v.id === 'company-200-chars')!;
    expect(long.company).toHaveLength(200);
    expect(long.expected).toHaveLength(120);
    const cut = vectors.find((v) => v.id === 'cut-lands-on-separator')!;
    expect(cut.company).toHaveLength(122);
  });

  it.each(vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    expect(
      renameFor(
        v.pattern,
        { case: v.case, company: v.company, doc: v.doc, date: v.date },
        v.mime
      )
    ).toBe(v.expected);
  });

  it('never exceeds 120 characters', () => {
    const name = renameFor(
      '{{company}}',
      { case: null, company: 'z'.repeat(500), doc: null, date: TODAY },
      PNG
    );
    expect(name).toHaveLength(120);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('ignores prototype keys as a mime', () => {
    expect(
      renameFor(
        'a',
        { case: null, company: null, doc: null, date: TODAY },
        'constructor'
      )
    ).toBe('a');
  });

  it('refuses a date that is not real', () => {
    expect(() =>
      renameFor(
        'x',
        { case: null, company: null, doc: null, date: '2026-02-30' },
        PDF
      )
    ).toThrow(RangeError);
  });
});

describe('sha256Hex', () => {
  it('hashes bytes', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });
});

describe('no input throws', () => {
  // mulberry32, fixed seed
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('fuzzes 200 random byte arrays through runChecks and imageSize', async () => {
    const rand = rng(21);
    const prefixes: Record<string, number[]> = {
      [PDF]: [0x25, 0x50, 0x44, 0x46, 0x2d],
      [JPEG]: [0xff, 0xd8, 0xff],
      [PNG]: [0x89, 0x50, 0x4e, 0x47],
    };
    const mimes = [PDF, JPEG, PNG, 'text/plain', ''];
    for (let n = 0; n < 200; n++) {
      const mime = mimes[n % mimes.length];
      const len = Math.floor(rand() * 64);
      const body = Array.from({ length: len }, () => Math.floor(rand() * 256));
      // JPEG bodies lean on marker bytes so the walk is exercised
      const biased =
        mime === JPEG ? body.map((b, i) => (i % 3 === 0 ? 0xff : b)) : body;
      const bytes = new Uint8Array([...(prefixes[mime] ?? []), ...biased]);
      for (const m of [mime, PDF, JPEG, PNG]) {
        expect(() => imageSize(bytes, m)).not.toThrow();
      }
      const out = await runChecks(bytes, mime, null, {
        today: TODAY,
        expiresOn: '2027-01-01',
      });
      expect(out.checks.length).toBeGreaterThanOrEqual(2);
    }
  });
});
