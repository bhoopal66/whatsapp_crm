import { describe, expect, it, vi } from 'vitest';

import { createUnsentQueue, sendOrKeep } from './unsent-media';

describe('createUnsentQueue', () => {
  it('offers what a chat refused oldest first, to its login only', () => {
    const q = createUnsentQueue<string>();
    q.claim('u');
    expect(q.add('u', 'a', 'photo')).toBe(true);
    expect(q.add('u', 'a', 'pdf')).toBe(true);
    expect(q.first('u', 'b')).toBeNull();
    expect(q.first('other', 'a')).toBeNull();
    expect(q.first('u', 'a')).toBe('photo');
    expect(q.take('u', 'a')).toBe('photo');
    expect(q.take('u', 'a')).toBe('pdf');
    expect(q.take('u', 'a')).toBeNull();
  });

  it('empties when another login takes the tab', () => {
    const q = createUnsentQueue<string>();
    q.claim('u');
    q.add('u', 'a', 'photo');
    q.claim('other');
    expect(q.add('u', 'a', 'late')).toBe(false);
    q.claim('u');
    expect(q.first('u', 'a')).toBeNull();
  });
});

describe('sendOrKeep', () => {
  /** A composer left meanwhile, unless the test says otherwise. */
  const refused = (over: Record<string, unknown> = {}) => ({
    toComposer: vi.fn(() => false),
    keepRecording: vi.fn(() => false),
    keepUpload: vi.fn(() => true),
    remove: vi.fn(),
    onKept: vi.fn(),
    ...over,
  });

  it('leaves a sent one alone', async () => {
    const r = refused();
    await sendOrKeep('file', async () => true, r);
    for (const fn of Object.values(r)) expect(fn).not.toHaveBeenCalled();
  });

  it('gives a refused one back to the composer on screen', async () => {
    const r = refused({ toComposer: vi.fn(() => true) });
    await sendOrKeep('file', async () => false, r);
    expect(r.toComposer).toHaveBeenCalledWith('file');
    expect(r.keepUpload).not.toHaveBeenCalled();
    expect(r.remove).not.toHaveBeenCalled();
    expect(r.onKept).not.toHaveBeenCalled();
  });

  it('keeps a file refused, or failed, after the chat was left', async () => {
    for (const deliver of [
      async () => false,
      () => Promise.reject(new Error('network')),
    ]) {
      const r = refused();
      await sendOrKeep('file', deliver, r);
      expect(r.keepUpload).toHaveBeenCalledWith('file');
      expect(r.remove).not.toHaveBeenCalled();
      expect(r.onKept).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps a recording itself, without its upload', async () => {
    const r = refused({ keepRecording: vi.fn(() => true) });
    await sendOrKeep('file', async () => false, r);
    expect(r.keepUpload).not.toHaveBeenCalled();
    expect(r.remove).toHaveBeenCalledWith('file');
    expect(r.onKept).toHaveBeenCalledTimes(1);
  });

  it('removes it, saying nothing, when another login has the tab', async () => {
    const r = refused({ keepUpload: vi.fn(() => false) });
    await sendOrKeep('file', async () => false, r);
    expect(r.remove).toHaveBeenCalledWith('file');
    expect(r.onKept).not.toHaveBeenCalled();
  });
});
