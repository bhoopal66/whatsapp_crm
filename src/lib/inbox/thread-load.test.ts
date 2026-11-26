import { describe, expect, it, vi } from 'vitest';

import {
  NO_THREAD,
  isFailed,
  isKnown,
  loadFailed,
  loadStarted,
  loadSucceeded,
  readTwice,
  threadView,
} from './thread-load';

const idle = { loading: false, hasContent: false };

describe('thread load', () => {
  it('never calls a chat empty before a read of it succeeded', () => {
    const started = loadStarted(NO_THREAD, 'a', false);
    expect(threadView(NO_THREAD, 'a', idle)).toBe('loading');
    expect(threadView(started, 'a', idle)).toBe('loading');
    expect(threadView(loadFailed(started, 'a'), 'a', idle)).toBe('error');
    expect(isKnown(loadFailed(started, 'a'), 'a')).toBe(false);
    expect(threadView(loadSucceeded('a'), 'a', idle)).toBe('empty');
    expect(threadView(loadSucceeded('a'), 'b', idle)).toBe('loading');
  });

  it('never calls a chat empty before it is known to be still ours', () => {
    const load = loadSucceeded('a');
    const unconfirmed = { ...idle, unconfirmed: true };
    expect(threadView(load, 'a', unconfirmed)).toBe('loading');
    const shown = { ...unconfirmed, hasContent: true };
    expect(threadView(load, 'a', shown)).toBe('messages');
  });

  it('keeps what is shown when a later read fails', () => {
    const failed = loadFailed(loadStarted(loadSucceeded('a'), 'a', false), 'a');
    expect(isKnown(failed, 'a')).toBe(true);
    expect(isFailed(failed, 'a')).toBe(true);
    const shown = { ...idle, hasContent: true };
    expect(threadView(failed, 'a', shown)).toBe('messages');
  });

  it('a cached page is knowledge; a chat already left changes nothing', () => {
    const now = loadStarted(NO_THREAD, 'b', true);
    expect(isKnown(now, 'b')).toBe(true);
    expect(loadFailed(now, 'a')).toBe(now);
  });
});

describe('readTwice', () => {
  it('tries once more and no more, and not for a chat that was left', async () => {
    const log = vi.spyOn(console, 'error').mockReturnValue(undefined);
    const bad = { data: null, error: new Error('down') };
    const read = vi.fn().mockResolvedValueOnce(bad);
    read.mockResolvedValueOnce({ data: [1], error: null });
    expect(await readTwice(read, () => true, 0)).toEqual({ data: [1] });

    const down = vi.fn().mockRejectedValue(new Error('down'));
    expect(await readTwice(down, () => true, 0)).toBeNull();
    expect(down).toHaveBeenCalledTimes(2);

    let here = true;
    const left = vi.fn().mockResolvedValue(bad);
    const answer = readTwice(left, () => here, 0);
    here = false;
    expect(await answer).toBeNull();
    expect(left).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
