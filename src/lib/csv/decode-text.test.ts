import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readContactCsv } from '@/lib/contacts/parse-contact-csv';
import { decodeText, readTextFile, TextEncodingError } from './decode-text';

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    Buffer.concat(
      parts.map((p) =>
        typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)
      )
    )
  );

// "محمد" and "شركة النور" as Excel's "CSV (Comma delimited)" writes them
// on an Arabic Windows.
const MOHAMMED_1256 = [0xe3, 0xcd, 0xe3, 0xcf];
const COMPANY_1256 = [
  0xd4, 0xd1, 0xdf, 0xc9, 0x20, 0xc7, 0xe1, 0xe4, 0xe6, 0xd1,
];
const ARABIC_CSV = bytes(
  'phone,name,company\r\n+971501234567,',
  MOHAMMED_1256,
  ',',
  COMPANY_1256,
  '\r\n'
);

const utf16 = (text: string, bigEndian = false) => {
  const body = Buffer.from('﻿' + text, 'utf16le');
  return new Uint8Array(bigEndian ? body.swap16() : body);
};

describe('decodeText', () => {
  it('reads a Windows-1256 CSV', () => {
    expect(readContactCsv(decodeText(ARABIC_CSV)).rows).toMatchObject([
      { phone: '+971501234567', name: 'محمد', company: 'شركة النور' },
    ]);
  });

  it('reads UTF-8, with and without a byte order mark', () => {
    const text = 'phone,name\n+971501234567,محمد é 김민수 😀\n';
    expect(decodeText(bytes(text))).toBe(text);
    expect(decodeText(bytes([0xef, 0xbb, 0xbf], text))).toBe(text);
    expect(decodeText(bytes(''))).toBe('');
  });

  it.each([false, true])('reads a UTF-16 CSV (big endian: %s)', (be) => {
    const text = 'phone\tname\r\n+971501234567\tمحمد\r\n';
    const read = decodeText(utf16(text, be));
    expect(read).toBe(text);
    expect(readContactCsv(read).rows).toMatchObject([
      { phone: '+971501234567', name: 'محمد' },
    ]);
  });

  it('reads the Persian letters and punctuation of Windows-1256', () => {
    // پ چ ژ گ ، ؟
    expect(
      decodeText(bytes([0x81, 0x8d, 0x8e, 0x90, 0x20, 0xa1, 0x20, 0xbf]))
    ).toBe('پچژگ ، ؟');
  });

  const refused: [string, Uint8Array][] = [
    ['text already lost to U+FFFD', bytes('phone,name\n1,��')],
    ['broken bytes after a UTF-8 mark', bytes([0xef, 0xbb, 0xbf], 'a', [0xe3])],
    ['half a UTF-16 character', bytes([0xff, 0xfe, 0x41])],
    [
      'UTF-8 with one broken byte, not misread as Windows-1256',
      bytes('phone,name\n1,محمد', [0xe3], '\n2,فاطمة\n'),
    ],
    [
      'UTF-16 without its mark',
      new Uint8Array(Buffer.from('phone,name\n', 'utf16le')),
    ],
  ];
  it.each(refused)('refuses %s', (_, content) => {
    expect(() => decodeText(content)).toThrow(TextEncodingError);
  });
});

describe('readTextFile', () => {
  it("reads a File's bytes", async () => {
    expect(await readTextFile(new File([ARABIC_CSV], 'a.csv'))).toContain(
      'محمد'
    );
  });

  // `file.text()` is UTF-8 only. A response's `.text()` is not a file's.
  it.each([
    'src/components/contacts/import-modal.tsx',
    'src/components/broadcasts/step2-select-audience.tsx',
  ])('%s does not decode an uploaded file itself', (path) => {
    expect(readFileSync(join(process.cwd(), path), 'utf8')).not.toMatch(
      /\.text\(\)/
    );
  });
});
