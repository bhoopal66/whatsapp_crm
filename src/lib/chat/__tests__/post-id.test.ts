import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPostIds, newPostId, type PostContent } from '../post-id';

const base: PostContent = {
  body: 'hi',
  fileIds: ['f1', 'f2'],
  replyToId: 'q1',
  threadRootId: 't1',
};
const ids = () => {
  let n = 0;
  return createPostIds(() => `id-${++n}`);
};

afterEach(() => vi.unstubAllGlobals());

describe('post ids (276)', () => {
  it('keeps the id of a draft sent again unchanged', () => {
    const p = ids();
    expect(p.idFor('d', base)).toBe('id-1');
    expect(p.idFor('d', { ...base, fileIds: [...base.fileIds] })).toBe('id-1');
  });

  it.each<[string, Partial<PostContent>]>([
    ['the body', { body: 'hi!' }],
    ['a file added', { fileIds: ['f1', 'f2', 'f3'] }],
    ['a file removed', { fileIds: ['f1'] }],
    ['a file swapped', { fileIds: ['f1', 'f9'] }],
    ['the quoted message', { replyToId: 'q2' }],
    ['no quote', { replyToId: null }],
    ['the thread', { threadRootId: null }],
  ])('renews it when the content changes: %s', (_, change) => {
    const p = ids();
    p.idFor('d', base);
    expect(p.idFor('d', { ...base, ...change })).toBe('id-2');
  });

  it('does not go back to an id whose content was replaced', () => {
    const p = ids();
    p.idFor('d', base);
    p.idFor('d', { ...base, body: 'b' });
    expect(p.idFor('d', base)).toBe('id-3');
  });

  it('gives the same words a new id once posted or emptied', () => {
    const p = ids();
    p.idFor('d', base);
    p.forget('d');
    expect(p.idFor('d', base)).toBe('id-2');
  });

  it('keeps each draft apart', () => {
    const p = ids();
    expect(p.idFor('d', base)).not.toBe(p.idFor('e', base));
    p.forget('e');
    expect(p.idFor('d', base)).toBe('id-1');
  });

  it('makes uuids by default', () => {
    expect(createPostIds().idFor('d', base)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    ['no randomUUID (plain http)', { getRandomValues: () => {} }],
    ['no crypto', undefined],
  ])('gives none without a secure context: %s', (_, crypto) => {
    vi.stubGlobal('crypto', crypto);
    expect(newPostId()).toBeUndefined();
    expect(createPostIds().idFor('d', base)).toBeUndefined();
  });
});
