import { describe, expect, it } from 'vitest';

import {
  ROOM_MEDIA_ACCEPT,
  checkRoomMedia,
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
