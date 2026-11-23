import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startCatchUp,
  CATCH_UP_GAP_MS,
  channelStep,
  hideStep,
  LONG_HIDE_MS,
  RETRY_DELAYS_MS,
  startLiveRead,
  type LiveRead,
} from './catch-up';

describe('channelStep', () => {
  it('asks for nothing on the first clean join', () => {
    expect(channelStep('new', 'SUBSCRIBED')).toEqual({
      state: 'live',
      catchUp: false,
    });
  });

  it('asks for a read on every later join', () => {
    expect(channelStep('live', 'SUBSCRIBED').catchUp).toBe(true);
    for (const status of ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']) {
      const lost = channelStep('live', status);
      expect(lost).toEqual({ state: 'lost', catchUp: false });
      expect(channelStep(lost.state, 'SUBSCRIBED').catchUp).toBe(true);
    }
  });

  it('asks for a read when the very first join came after a failure', () => {
    const failed = channelStep('new', 'TIMED_OUT').state;
    expect(channelStep(failed, 'SUBSCRIBED').catchUp).toBe(true);
  });
});

describe('hideStep', () => {
  it('catches up after a long hide only', () => {
    expect(hideStep(null, 'hidden', 1_000)).toEqual({
      hiddenAt: 1_000,
      catchUp: false,
    });
    expect(hideStep(1_000, 'visible', 1_000 + LONG_HIDE_MS)).toEqual({
      hiddenAt: null,
      catchUp: false,
    });
    expect(hideStep(1_000, 'visible', 1_001 + LONG_HIDE_MS).catchUp).toBe(true);
  });

  it('keeps the first hide of two, and ignores a show without a hide', () => {
    expect(hideStep(1_000, 'hidden', 9_000).hiddenAt).toBe(1_000);
    expect(hideStep(null, 'visible', 9e9).catchUp).toBe(false);
  });
});

describe('startLiveRead', () => {
  type Pending = { resolve: (v: string) => void; reject: () => void };
  let pending: Pending[] = [];
  let applied: string[] = [];
  let live: LiveRead;
  const doc = {
    visibilityState: 'visible',
    listeners: new Set<() => void>(),
    addEventListener: (_: string, fn: () => void) => doc.listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) =>
      doc.listeners.delete(fn),
  };
  const show = (state: string) => {
    doc.visibilityState = state;
    doc.listeners.forEach((fn) => fn());
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const start = () =>
    (live = startLiveRead<string>({
      read: () =>
        new Promise((resolve, reject) =>
          pending.push({ resolve, reject: () => reject(new Error('503')) })
        ),
      apply: (v) => applied.push(v),
    }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', doc);
    doc.visibilityState = 'visible';
    pending = [];
    applied = [];
    start();
  });
  afterEach(() => {
    live.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads once, and not again on the first SUBSCRIBED', async () => {
    pending[0].resolve('a');
    await flush();
    live.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(applied).toEqual(['a']);
    expect(pending).toHaveLength(1); // no polling
  });

  it('reads again on each rejoin', async () => {
    pending[0].resolve('a');
    live.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60_000);
    live.onStatus('CHANNEL_ERROR');
    live.onStatus('SUBSCRIBED');
    pending[1].resolve('b');
    await flush();
    expect(applied).toEqual(['a', 'b']);
  });

  it('folds a wake-up (shown, then rejoined) and a flapping channel', async () => {
    pending[0].resolve('a');
    live.onStatus('SUBSCRIBED');
    show('hidden');
    await vi.advanceTimersByTimeAsync(LONG_HIDE_MS + 1);
    show('visible');
    expect(pending).toHaveLength(2);
    for (let i = 0; i < 10; i++) {
      live.onStatus('CHANNEL_ERROR');
      live.onStatus('SUBSCRIBED');
      await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS / 10);
    }
    // One at the end of the gap, after the last rejoin.
    expect(pending).toHaveLength(3);
  });

  it('does not read after a short hide', async () => {
    pending[0].resolve('a');
    show('hidden');
    await vi.advanceTimersByTimeAsync(LONG_HIDE_MS);
    show('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pending).toHaveLength(1);
  });

  it('retries a failed read with backoff, then gives up until a rejoin', async () => {
    live.onStatus('SUBSCRIBED');
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      pending[i].reject();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(pending).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(pending).toHaveLength(i + 2);
    }
    const tried = pending.length;
    pending[tried - 1].reject();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(pending).toHaveLength(tried);
    expect(applied).toEqual([]);
    live.onStatus('SUBSCRIBED');
    pending[tried].resolve('back');
    await flush();
    expect(applied).toEqual(['back']);
  });

  it('never lets an older read land on a newer one', async () => {
    live.refresh();
    pending[1].resolve('new');
    await flush();
    pending[0].resolve('old');
    await flush();
    expect(applied).toEqual(['new']);
  });

  it('drops an answer a change overtook, and reads again', async () => {
    live.changed();
    pending[0].resolve('stale');
    await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS);
    expect(applied).toEqual([]);
    pending[1].resolve('fresh');
    await flush();
    expect(applied).toEqual(['fresh']);
  });

  it('is silent once stopped', async () => {
    live.stop();
    pending[0].resolve('late');
    live.onStatus('CLOSED');
    live.onStatus('SUBSCRIBED');
    live.refresh();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(applied).toEqual([]);
    expect(pending).toHaveLength(1);
    expect(doc.listeners.size).toBe(0);
  });
});

describe('startCatchUp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs after a gap only: not on start, not on the first join', async () => {
    const run = vi.fn();
    const live = startCatchUp(run);
    live.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    live.onStatus('CHANNEL_ERROR');
    live.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS);
    expect(run).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it('folds a wake (online, joined again) into one run, and retries it', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const live = startCatchUp(run);
    live.catchUp();
    live.onStatus('TIMED_OUT');
    live.onStatus('SUBSCRIBED');
    await vi.advanceTimersByTimeAsync(CATCH_UP_GAP_MS);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
    expect(run).toHaveBeenCalledTimes(2);
    live.stop();
    live.catchUp();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
