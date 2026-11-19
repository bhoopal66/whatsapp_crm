import { describe, expect, it } from 'vitest';

import { groupMediaView } from './group-media';
import {
  chatMediaPathOf,
  groupMediaRowMedia,
  groupMediaRowType,
  isGroupMediaPath,
  parseGroupMedia,
} from './outbound-media';

const PATH = 'account-a1/groups/1700000000000-doc.pdf';
const url = (p: string, origin = 'https://t.example') =>
  `${origin}/storage/v1/object/public/chat-media/${p}`;

describe('chatMediaPathOf', () => {
  it('reads the object path whatever the origin', () => {
    expect(chatMediaPathOf(url(PATH))).toBe(PATH);
    expect(chatMediaPathOf(url(PATH, 'http://kong:8000'))).toBe(PATH);
  });
  it('refuses other buckets, queries and non-URLs', () => {
    expect(chatMediaPathOf('nope')).toBeNull();
    expect(chatMediaPathOf(`${url(PATH)}?a=1`)).toBeNull();
    expect(
      chatMediaPathOf(
        'https://t.example/storage/v1/object/public/flow-media/x.pdf'
      )
    ).toBeNull();
  });
});

describe('isGroupMediaPath', () => {
  it('accepts one file name under the account groups folder', () => {
    expect(isGroupMediaPath(PATH, 'a1')).toBe(true);
    expect(isGroupMediaPath(PATH, 'a2')).toBe(false);
    expect(isGroupMediaPath('account-a1/groups/sub/x.pdf', 'a1')).toBe(false);
    expect(isGroupMediaPath('account-a1/groups/..', 'a1')).toBe(false);
  });
});

describe('parseGroupMedia', () => {
  it('validates and trims', () => {
    expect(
      parseGroupMedia(
        { kind: 'document', url: url(PATH), path: PATH, caption: ' hi ' },
        'a1'
      )
    ).toEqual({
      kind: 'document',
      url: url(PATH),
      path: PATH,
      caption: 'hi',
      filename: null,
      mimeType: null,
    });
  });
  it('refuses a url that does not match its path', () => {
    expect(() =>
      parseGroupMedia(
        {
          kind: 'image',
          url: url('account-a1/groups/other.jpg'),
          path: PATH,
        },
        'a1'
      )
    ).toThrow();
  });
});

describe('row shape', () => {
  it('is drawn by groupMediaView', () => {
    const view = groupMediaView(
      groupMediaRowType('document'),
      groupMediaRowMedia({ url: url(PATH), filename: 'doc.pdf' }),
      'cap'
    );
    expect(view).toMatchObject({
      kind: 'document',
      url: url(PATH),
      filename: 'doc.pdf',
      caption: 'cap',
    });
    expect(groupMediaRowType('voice')).toBe('audio');
  });
});
