import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startCapture } from './capture';

// A recorder that will not start must leave nothing running: the ticker
// would draw and the audio context hold on for the rest of the visit.

const fake = vi.hoisted(() => ({
  ticker: { stop: vi.fn() },
  track: { stop: vi.fn() },
  close: vi.fn(async () => {}),
  construct: (() => {}) as () => void,
  start: (() => {}) as () => void,
}));

vi.mock('@/lib/meetings/effects/ticker', () => ({
  createTicker: () => fake.ticker,
}));

const anything = () =>
  new Proxy({}, { get: () => vi.fn(), set: () => true }) as object;

const sink = { write: vi.fn(async () => {}) } as unknown as Parameters<
  typeof startCapture
>[0];

beforeEach(() => {
  vi.clearAllMocks();
  fake.construct = () => {};
  fake.start = () => {};
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: anything,
      captureStream: () => ({ getVideoTracks: () => [fake.track] }),
    }),
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      resume = async () => {};
      close = fake.close;
      createMediaStreamDestination = () => ({
        stream: { getAudioTracks: () => [] },
      });
    }
  );
  vi.stubGlobal('MediaStream', class {});
  vi.stubGlobal(
    'MediaRecorder',
    class {
      constructor() {
        fake.construct();
      }
      start() {
        fake.start();
      }
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const expectNothingRunning = () => {
  expect(fake.ticker.stop).toHaveBeenCalled();
  expect(fake.track.stop).toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalled();
};

describe('startCapture', () => {
  it('cleans up and rethrows when the recorder cannot be made', async () => {
    fake.construct = () => {
      throw new Error('unsupported');
    };
    await expect(startCapture(sink, 'video/webm', () => {})).rejects.toThrow(
      'unsupported'
    );
    expectNothingRunning();
  });

  it('cleans up and rethrows when the recorder cannot start', async () => {
    fake.start = () => {
      throw new Error('refused');
    };
    await expect(startCapture(sink, 'video/webm', () => {})).rejects.toThrow(
      'refused'
    );
    expectNothingRunning();
  });

  it('leaves a recorder that started running', async () => {
    await startCapture(sink, 'video/webm', () => {});
    expect(fake.ticker.stop).not.toHaveBeenCalled();
    expect(fake.close).not.toHaveBeenCalled();
  });
});
