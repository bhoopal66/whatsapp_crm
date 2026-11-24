import { describe, expect, it, vi } from 'vitest';

import type { ComposerDraft } from '../composer';
import type { FileChip } from '../composer-input';
import { createPostIds } from '../post-id';
import {
  createPostedNotices,
  draftPost,
  draftPosted,
  newTakePost,
  takeForSend,
  takePost,
} from '../post-payload';

const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const upload: NonNullable<FileChip['input']> = {
  storage_path: 'p1',
  name: 'a',
  mime: 'audio/ogg',
  bytes: 1,
};
const chip = (id: string): FileChip => ({
  id,
  name: `${id}.pdf`,
  status: 'done',
  input: upload,
  error: null,
});
const draftOf = (text: string): ComposerDraft => ({ text, picked: [] });

describe('what a send carries', () => {
  const base = {
    channelId: 'c1',
    threadRootId: 't1' as string | null,
    replyToId: 'q1' as string | null,
    body: 'hi',
    chips: [chip('f1')],
  };

  it('the body, files, quote and thread, under the draft’s id', () => {
    expect(draftPost(createPostIds(counter()), 'd', base)).toEqual({
      channelId: 'c1',
      body: 'hi',
      threadRootId: 't1',
      replyToId: 'q1',
      attachments: [upload],
      clientId: 'id-1',
    });
  });

  it('the same id again unchanged, another one when anything in it changed', () => {
    const ids = createPostIds(counter());
    const id = (p: Partial<typeof base>) =>
      draftPost(ids, 'd', { ...base, ...p }).clientId;
    expect([id({}), id({ chips: [chip('f1')] })]).toEqual(['id-1', 'id-1']);
    expect(id({ body: 'ho' })).toBe('id-2');
    expect(id({ chips: [chip('f2')] })).toBe('id-3');
    expect(id({ replyToId: null })).toBe('id-4');
    expect(id({ threadRootId: null })).toBe('id-5');
  });
});

describe('what a take carries', () => {
  const at = {
    channelId: 'c1',
    threadRootId: 't1',
    body: 'Voice note 0:03',
    uploaded: upload,
    durationMs: 3000,
  };

  it('the recording, its quote and thread, under the take’s id', () => {
    const post = takeForSend(
      newTakePost(() => 'first'),
      'q1',
      () => 'id'
    );
    expect(takePost(post, at)).toEqual({
      channelId: 'c1',
      body: 'Voice note 0:03',
      threadRootId: 't1',
      replyToId: 'q1',
      attachments: [expect.objectContaining({ ...upload, kind: 'voice' })],
      clientId: 'id',
    });
  });

  it('one id per take, kept with the upload when it is sent again', () => {
    const newId = counter();
    const one = newTakePost(newId);
    const two = newTakePost(newId);
    expect([one.postId, two.postId]).toEqual(['id-1', 'id-2']);
    const tried = { ...takeForSend(one, null, newId), uploaded: upload };
    expect(takeForSend(tried, null, newId)).toEqual({
      postId: 'id-1',
      replyToId: null,
      uploaded: upload,
    });
  });

  it('another quote is another post, with its own upload', () => {
    const newId = counter();
    const tried = { postId: 'old', replyToId: 'q1', uploaded: upload };
    expect(takeForSend(tried, 'q2', newId)).toEqual({
      postId: 'id-1',
      replyToId: 'q2',
      uploaded: null,
    });
    expect(takeForSend(tried, null, newId).postId).toBe('id-2');
  });
});

describe('a posted draft', () => {
  function setup(mounted: boolean, stored = draftOf('hello')) {
    const ids = createPostIds(counter());
    const content = {
      body: 'hello',
      fileIds: [],
      replyToId: null,
      threadRootId: null,
    };
    ids.idFor('d', content);
    const notices = createPostedNotices();
    const drop = vi.fn();
    const write = vi.fn();
    return {
      notices,
      drop,
      write,
      nextId: () => ids.idFor('d', content),
      posted: () =>
        draftPosted({
          ids,
          notices,
          draftKey: 'd',
          sent: draftOf('hello'),
          mounted,
          drop,
          stored: { read: () => stored, write },
        }),
    };
  }

  it('is dropped by the composer that sent it, and its id forgotten', () => {
    const s = setup(true);
    s.posted();
    expect(s.drop).toHaveBeenCalledWith(draftOf('hello'));
    expect(s.nextId()).toBe('id-2');
  });

  it('is dropped by the composer mounted since, and keeps its id', () => {
    const s = setup(false);
    const heard = vi.fn();
    const other = vi.fn();
    s.notices.listen('d', heard);
    s.notices.listen('e', other);
    s.posted();
    expect(heard).toHaveBeenCalledWith(draftOf('hello'));
    expect(other).not.toHaveBeenCalled();
    expect(s.drop).not.toHaveBeenCalled();
    expect(s.write).not.toHaveBeenCalled();
    // A Send already pressed there is the same post.
    expect(s.nextId()).toBe('id-1');
  });

  it('is dropped from storage when no composer of it is mounted', () => {
    const s = setup(false);
    s.notices.listen('d', () => {})();
    s.posted();
    expect(s.write).toHaveBeenCalledWith('d', draftOf(''));
    expect(s.nextId()).toBe('id-1');
  });

  it('leaves in storage what was typed after it, or instead of it', () => {
    const after = setup(false, draftOf('hello there'));
    after.posted();
    expect(after.write).toHaveBeenCalledWith('d', draftOf('there'));
    const instead = setup(false, draftOf('bye'));
    instead.posted();
    expect(instead.write).not.toHaveBeenCalled();
  });
});
