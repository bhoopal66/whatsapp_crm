import { describe, expect, it } from 'vitest';

import { buildMediaPath } from '@/lib/storage/upload-media';

import {
  groupCaption,
  groupFileKind,
  groupMediaMaxBytes,
  groupMediaPayload,
  groupPickerAccept,
  groupUploadName,
  isGroupUploadPath,
  megabytes,
} from './composer';
import {
  GROUP_MEDIA_CAPTION_MAX,
  GROUP_MEDIA_FOLDER,
  isGroupMediaPath,
  parseGroupMedia,
} from './outbound-media';

const ACC = '11111111-2222-3333-4444-555555555555';

describe('groupFileKind', () => {
  it('keeps the menu choice when the type is on its list', () => {
    expect(groupFileKind('image', 'image/jpeg')).toBe('image');
    expect(groupFileKind('document', 'application/pdf')).toBe('document');
    expect(groupFileKind('video', 'video/mp4')).toBe('video');
  });

  it('moves a file picked under the wrong item to its own kind', () => {
    expect(groupFileKind('document', 'image/png')).toBe('image');
    expect(groupFileKind('image', 'video/3gpp')).toBe('video');
  });

  it('trusts the choice when the browser gave no type', () => {
    expect(groupFileKind('document', '')).toBe('document');
  });

  it('refuses a type the bucket does not take', () => {
    expect(groupFileKind('document', 'application/x-msdownload')).toBeNull();
    expect(groupFileKind('image', 'image/gif')).toBeNull();
  });

  it('reads the same accept lists as the inbox picker', () => {
    expect(groupPickerAccept('image')).toBe('image/png,image/jpeg,image/webp');
  });
});

describe('groupMediaMaxBytes', () => {
  it('uses the audio limit for a voice note', () => {
    expect(groupMediaMaxBytes('voice')).toBe(16 * 1024 * 1024);
    expect(groupMediaMaxBytes('image')).toBe(5 * 1024 * 1024);
  });

  it('formats megabytes for the notice', () => {
    expect(megabytes(5 * 1024 * 1024)).toBe('5');
    expect(megabytes(5.25 * 1024 * 1024)).toBe('5.3');
  });
});

describe('groupUploadName', () => {
  it('cleans the extension so buildMediaPath keeps it', () => {
    expect(groupUploadName('My Report.P D F')).toBe('My_Report.pdf');
    expect(groupUploadName('scan.tar.gz')).toBe('scan_tar.gz');
    expect(groupUploadName('README')).toBe('README.bin');
    expect(groupUploadName('.png')).toBe('file.png');
    expect(groupUploadName('photo.???')).toBe('photo.bin');
  });

  it('gives a path the send route accepts', () => {
    for (const name of ['a b.P D F', 'ملف.pdf', 'x.jpeg', 'voice-1.ogg']) {
      const path = buildMediaPath(
        ACC,
        groupUploadName(name),
        Date.now(),
        GROUP_MEDIA_FOLDER
      );
      expect(isGroupUploadPath(path)).toBe(true);
      expect(isGroupMediaPath(path, ACC)).toBe(true);
    }
  });

  it('is needed: buildMediaPath alone turns an odd extension into bin', () => {
    const path = buildMediaPath(ACC, 'a.p df', 1, GROUP_MEDIA_FOLDER);
    expect(path.endsWith('.bin')).toBe(true);
    const cleaned = buildMediaPath(
      ACC,
      groupUploadName('a.p df'),
      1,
      GROUP_MEDIA_FOLDER
    );
    expect(cleaned.endsWith('.pdf')).toBe(true);
  });
});

describe('isGroupUploadPath', () => {
  it('takes only one safe name under groups/', () => {
    expect(isGroupUploadPath(`account-${ACC}/groups/1-a.pdf`)).toBe(true);
    expect(isGroupUploadPath(`account-${ACC}/staged/1-a.pdf`)).toBe(false);
    expect(isGroupUploadPath(`account-${ACC}/groups/x/1-a.pdf`)).toBe(false);
    expect(isGroupUploadPath(`account-${ACC}/groups/.hidden`)).toBe(false);
  });
});

describe('groupMediaPayload', () => {
  const draft = {
    kind: 'image' as const,
    url: `https://crm.example/storage/v1/object/public/chat-media/account-${ACC}/groups/1-a.jpg`,
    path: `account-${ACC}/groups/1-a.jpg`,
    filename: 'a.jpg',
    mimeType: 'image/jpeg',
    caption: '  hello  ',
  };

  it('trims the caption and carries name and type', () => {
    expect(groupMediaPayload(draft)).toEqual({
      kind: 'image',
      url: draft.url,
      path: draft.path,
      caption: 'hello',
      filename: 'a.jpg',
      mimeType: 'image/jpeg',
    });
  });

  it('leaves a blank caption out', () => {
    expect(groupMediaPayload({ ...draft, caption: ' \n ' })).not.toHaveProperty(
      'caption'
    );
  });

  it('never sends a caption with a voice note', () => {
    expect(
      groupMediaPayload({ ...draft, kind: 'voice', caption: 'hi' })
    ).not.toHaveProperty('caption');
  });

  it('is a body the send route accepts', () => {
    const parsed = parseGroupMedia(
      groupMediaPayload(draft),
      ACC,
      'https://crm.example'
    );
    expect(parsed.path).toBe(draft.path);
    expect(parsed.caption).toBe('hello');
  });

  it('clips a caption to the WhatsApp ceiling', () => {
    const long = 'x'.repeat(GROUP_MEDIA_CAPTION_MAX + 50);
    expect(groupCaption(long)).toHaveLength(GROUP_MEDIA_CAPTION_MAX);
    expect(groupCaption('   ')).toBeUndefined();
  });
});
