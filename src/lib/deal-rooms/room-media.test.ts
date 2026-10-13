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
    expect(checkRoomMediaContent({ type: DOCX, name: 'a.docx' }, OLE2)).toEqual(
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
