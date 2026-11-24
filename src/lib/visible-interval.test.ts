import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { visibleInterval } from './visible-interval';

let onVisibility: Set<() => void>;
let visibilityState: string;

function show(state: 'visible' | 'hidden') {
  visibilityState = state;
  onVisibility.forEach((fn) => fn());
}

beforeEach(() => {
  vi.useFakeTimers();
  onVisibility = new Set();
  visibilityState = 'visible';
  vi.stubGlobal('document', {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (_: string, fn: () => void) => onVisibility.add(fn),
    removeEventListener: (_: string, fn: () => void) => onVisibility.delete(fn),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('visibleInterval', () => {
  it('runs on screen, skips hidden, and runs at once on return', () => {
    const run = vi.fn();
    const stop = visibleInterval(run, 60_000);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    show('hidden');
    vi.advanceTimersByTime(600_000);
    expect(run).toHaveBeenCalledTimes(1);
    show('visible');
    expect(run).toHaveBeenCalledTimes(2);
    // The next one is a whole interval after that.
    vi.advanceTimersByTime(59_999);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it('does not run again on a quick tab switch', () => {
    const run = vi.fn();
    const stop = visibleInterval(run, 60_000);
    vi.advanceTimersByTime(30_000);
    show('hidden');
    vi.advanceTimersByTime(1_000);
    show('visible');
    expect(run).not.toHaveBeenCalled();
    stop();
  });

  it('cleans up', () => {
    const run = vi.fn();
    visibleInterval(run, 60_000)();
    expect(onVisibility.size).toBe(0);
    vi.advanceTimersByTime(120_000);
    show('visible');
    expect(run).not.toHaveBeenCalled();
  });
});
