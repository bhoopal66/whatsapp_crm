import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  nextPushDelayMs,
  PUSH_BUSY_DELAY_MS,
  PUSH_IDLE_DELAY_MS,
  startPushLoop,
} from './loop';
import type { DispatchSummary } from './dispatch';

const idle: DispatchSummary = {
  claimed: 0,
  sent: 0,
  held: 0,
  skipped: 0,
  released: 0,
  failed: 0,
};

describe('nextPushDelayMs', () => {
  it('comes back quickly after a pass that touched anything', () => {
    expect(PUSH_BUSY_DELAY_MS).toBe(3_000);
    for (const key of [
      'sent',
      'held',
      'skipped',
      'failed',
      'released',
    ] as const) {
      expect(nextPushDelayMs({ ...idle, claimed: 1, [key]: 1 })).toBe(
        PUSH_BUSY_DELAY_MS
      );
    }
  });

  it('waits the idle delay after an empty or failed pass', () => {
    expect(PUSH_IDLE_DELAY_MS).toBe(10_000);
    expect(nextPushDelayMs(idle)).toBe(PUSH_IDLE_DELAY_MS);
    expect(nextPushDelayMs(null)).toBe(PUSH_IDLE_DELAY_MS);
  });
});

describe('startPushLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('chains passes by their outcome and survives a throwing pass', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pass = vi
      .fn<() => Promise<DispatchSummary>>()
      .mockResolvedValueOnce({ ...idle, claimed: 2, sent: 2 })
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue(idle);

    startPushLoop(pass);
    expect(pass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(1);

    // Busy pass: the next one 3 s later, not before.
    await vi.advanceTimersByTimeAsync(PUSH_BUSY_DELAY_MS - 1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[push] delivery pass failed:', 'db down');

    // Failed pass: the loop lives on, at the idle pace.
    await vi.advanceTimersByTimeAsync(PUSH_IDLE_DELAY_MS - 1);
    expect(pass).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(3);
    log.mockRestore();
  });
});
