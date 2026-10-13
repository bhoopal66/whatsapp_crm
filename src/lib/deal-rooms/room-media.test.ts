import { describe, expect, it } from 'vitest';

import {
  ROOM_MEDIA_ACCEPT,
  ROOM_MEDIA_FORMATS,
  TEXT_SNIFF_BYTES,
  checkRoomMedia,
  checkRoomMediaContent,
  roomMediaKind,
  roomMediaPath,
} from './room-media';

const MB = 1024 * 1024;

describe('roomMediaKind', () => {
  it('takes JPEG and PNG images and the documents Meta sends', () => {
    expect(roomMediaKind('image/jpeg')).toBe('image');
    expect(roomMediaKind('IMAGE/PNG')).toBe('image');
    expect(roomMediaKind('application/pdf')).toBe('document');
    expect(roomMediaKind('text/plain; charset=utf-8')).toBe('document');
  });

  it('refuses what WhatsApp does not send as an image or a document', () => {
    for (const t of ['image/webp', 'image/gif', 'video/mp4', 'audio/ogg', ''])
      expect(roomMediaKind(t)).toBeNull();
  });
});

describe('checkRoomMedia', () => {
  it('holds images to 5 MB and documents to 9 MB', () => {
    expect(checkRoomMedia({ type: 'image/png', size: 5 * MB })).toEqual({
      ok: true,
      kind: 'image',
    });
    expect(checkRoomMedia({ type: 'image/png', size: 5 * MB + 1 })).toEqual({
      ok: false,
      code: 'media_size',
      maxBytes: 5 * MB,
    });
    expect(checkRoomMedia({ type: 'application/pdf', size: 9 * MB }).ok).toBe(
      true
    );
    expect(
      checkRoomMedia({ type: 'application/pdf', size: 9 * MB + 1 })
    ).toMatchObject({ ok: false, code: 'media_size' });
  });

  it('refuses an empty file and an unsupported type', () => {
    expect(checkRoomMedia({ type: 'application/pdf', size: 0 })).toMatchObject({
      ok: false,
      code: 'media_size',
    });
    expect(checkRoomMedia({ type: 'image/gif', size: 10 })).toEqual({
      ok: false,
      code: 'media_type',
    });
  });

  it('offers the picker exactly what it accepts', () => {
    for (const type of ROOM_MEDIA_ACCEPT.split(','))
      expect(roomMediaKind(type)).not.toBeNull();
  });
});

describe('checkRoomMediaContent', () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, 0x20, 0x20, 0x20]);
  const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
  // A real PNG's signature, then its IHDR chunk's length and name.
  const PNG = bytes(
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...[0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]
  );
  const PDF = new TextEncoder().encode('%PDF-1.7\n');
  const OLE2 = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1);
  const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0);
  const TEXT = new TextEncoder().encode('Offer: AED 1,200,000\r\nمرحبا\n');
  const DOCX =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const XLSX =
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const ok = { ok: true };

  it('takes each type with its extension and leading bytes', () => {
    const cases: [string, string, Uint8Array][] = [
      ['image/jpeg', 'scan.JPG', JPEG],
      ['image/jpeg', 'scan.jpeg', JPEG],
      ['image/png', 'id.png', PNG],
      ['application/pdf', 'offer.pdf', PDF],
      ['application/msword', 'old.doc', OLE2],
      ['application/vnd.ms-excel', 'old.xls', OLE2],
      ['application/vnd.ms-powerpoint', 'old.ppt', OLE2],
      [DOCX, 'offer.docx', ZIP],
      [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'sheet.xlsx',
        ZIP,
      ],
      [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'deck.pptx',
        ZIP,
      ],
      ['text/plain; charset=utf-8', 'note.txt', TEXT],
    ];
    for (const [type, name, b] of cases)
      expect(checkRoomMediaContent({ type, name }, b)).toEqual(ok);
  });

  it('refuses a name whose extension is not its type’s', () => {
    for (const name of ['offer.exe', 'offer.pdf.exe', 'offer', '.pdf.', ''])
      expect(
        checkRoomMediaContent({ type: 'application/pdf', name }, PDF)
      ).toEqual({ ok: false, code: 'media_name' });
    expect(
      checkRoomMediaContent({ type: 'image/png', name: 'id.jpg' }, PNG)
    ).toEqual({ ok: false, code: 'media_name' });
  });

  it('refuses bytes that are not what the browser said', () => {
    const exe = bytes(0x4d, 0x5a, 0x90, 0);
    const refused = { ok: false, code: 'media_content' };
    expect(
      checkRoomMediaContent({ type: 'application/pdf', name: 'a.pdf' }, exe)
    ).toEqual(refused);
    expect(
      checkRoomMediaContent({ type: 'image/jpeg', name: 'a.jpg' }, PNG)
    ).toEqual(refused);
    expect(
      checkRoomMediaContent({ type: 'application/msword', name: 'a.doc' }, ZIP)
    ).toEqual(refused);
    expect(checkRoomMediaContent({ type: DOCX, name: 'a.docx' }, PDF)).toEqual(
      refused
    );
    expect(
      checkRoomMediaContent(
        { type: 'application/pdf', name: 'a.pdf' },
        PDF.subarray(0, 4)
      )
    ).toEqual(refused);
    // Plain text: no NUL byte in the first 8000, and not empty.
    for (const b of [ZIP, PNG, new Uint8Array(0)])
      expect(
        checkRoomMediaContent({ type: 'text/plain', name: 'a.txt' }, b)
      ).toEqual(refused);
    const late = new Uint8Array(TEXT_SNIFF_BYTES + 1).fill(0x61);
    late[TEXT_SNIFF_BYTES] = 0;
    expect(
      checkRoomMediaContent({ type: 'text/plain', name: 'a.txt' }, late)
    ).toEqual(ok);
    expect(
      checkRoomMediaContent({ type: 'image/gif', name: 'a.gif' }, JPEG)
    ).toEqual(refused);
  });

  it('takes a password-protected .docx, .xlsx or .pptx: an OLE2 file', () => {
    for (const [type, name] of [
      [DOCX, 'offer.docx'],
      [XLSX, 'sheet.xlsx'],
      [
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'deck.pptx',
      ],
    ])
      expect(checkRoomMediaContent({ type, name }, OLE2)).toEqual(ok);
  });

  it('takes UTF-16 text after its byte order mark, NUL bytes and all', () => {
    const le = Buffer.from('\ufeffOffer: AED 1,200,000\r\nمرحبا\n', 'utf16le');
    const be = Buffer.from(le).swap16();
    expect([le[0], le[1], be[0], be[1]]).toEqual([0xff, 0xfe, 0xfe, 0xff]);
    expect(le.includes(0)).toBe(true);
    for (const b of [le, be])
      expect(
        checkRoomMediaContent({ type: 'text/plain', name: 'note.txt' }, b)
      ).toEqual(ok);
    // Still no NUL character: a binary file behind a byte order mark, or
    // UTF-32 (its mark starts as UTF-16's), is refused.
    const refused = { ok: false, code: 'media_content' };
    for (const b of [
      Buffer.from('\ufeffMZ\u0000\u0003', 'utf16le'),
      Buffer.from('\ufeffMZ\u0000\u0003', 'utf16le').swap16(),
      new Uint8Array([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]),
    ])
      expect(
        checkRoomMediaContent({ type: 'text/plain', name: 'note.txt' }, b)
      ).toEqual(refused);
  });

  it('takes the .jfif and .jpe names of a JPEG', () => {
    for (const name of ['scan.jfif', 'scan.JPE'])
      expect(checkRoomMediaContent({ type: 'image/jpeg', name }, JPEG)).toEqual(
        ok
      );
  });

  it('takes a .csv labelled as Excel and an .rtf as Word, on their content', () => {
    const CSV = new TextEncoder().encode('name,amount\r\nمرحبا,1200000\r\n');
    const RTF = new TextEncoder().encode('{\\rtf1\\ansi Offer}');
    const XLS = 'application/vnd.ms-excel';
    const DOC = 'application/msword';
    expect(checkRoomMediaContent({ type: XLS, name: 'list.csv' }, CSV)).toEqual(
      ok
    );
    expect(
      checkRoomMediaContent({ type: DOC, name: 'offer.rtf' }, RTF)
    ).toEqual(ok);
    const refused = { ok: false, code: 'media_content' };
    const exe = bytes(0x4d, 0x5a, 0x90, 0);
    expect(checkRoomMediaContent({ type: XLS, name: 'list.csv' }, exe)).toEqual(
      refused
    );
    expect(
      checkRoomMediaContent({ type: DOC, name: 'offer.rtf' }, OLE2)
    ).toEqual(refused);
    expect(checkRoomMediaContent({ type: DOC, name: 'old.doc' }, RTF)).toEqual(
      refused
    );
    // Only those pairs: each name with its own Windows type.
    const badName = { ok: false, code: 'media_name' };
    expect(checkRoomMediaContent({ type: DOC, name: 'list.csv' }, CSV)).toEqual(
      badName
    );
    expect(
      checkRoomMediaContent({ type: XLS, name: 'offer.rtf' }, RTF)
    ).toEqual(badName);
    expect(
      checkRoomMediaContent({ type: 'text/plain', name: 'list.csv' }, CSV)
    ).toEqual(badName);
  });

  it('knows what every type the picker offers looks like', () => {
    for (const type of ROOM_MEDIA_ACCEPT.split(','))
      expect(ROOM_MEDIA_FORMATS[type]).toBeDefined();
  });
});

describe('roomMediaPath', () => {
  it('files under the room, where 088 lets the room staff read it', () => {
    expect(roomMediaPath('a1', 'r1', 'Offer letter (v2).pdf', 7)).toBe(
      'account-a1/room-r1/out-7-Offer_letter__v2_.pdf'
    );
    expect(roomMediaPath('a1', 'r1', '../../x', 7)).toBe(
      'account-a1/room-r1/out-7-_.._x'
    );
    expect(roomMediaPath('a1', 'r1', '', 7)).toBe(
      'account-a1/room-r1/out-7-file'
    );
  });
});
