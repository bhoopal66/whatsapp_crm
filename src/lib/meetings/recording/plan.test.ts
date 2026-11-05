import { describe, expect, it, vi } from 'vitest';

import type { RecordingFlagResult } from '@/lib/meetings/room/recording';

import {
  createRecorderMachine,
  finishRecording,
  FLAG_SEEN_WITHIN_MS,
  LAST_DATA_WAIT_MS,
  pickMimeType,
  recordEntry,
  recordingFileName,
  recordingLayout,
  type RecorderSink,
} from './plan';

function rig(answer: RecordingFlagResult = 'ok') {
  const sink: RecorderSink = { fileName: 'a.webm', abort: vi.fn() };
  const captureStop = vi.fn(async () => {});
  const deps = {
    setFlag: vi.fn(
      async (on: boolean) => (on ? answer : 'ok') as RecordingFlagResult
    ),
    pickSink: vi.fn(async (): Promise<RecorderSink | null> => sink),
    begin: vi.fn(async () => ({ stop: captureStop })),
    onChange: vi.fn(),
    onRefused: vi.fn(),
    onSaved: vi.fn(),
    onSaveFailed: vi.fn(),
    onInterrupted: vi.fn(),
    now: () => 5,
  };
  return { deps, sink, captureStop, m: createRecorderMachine(deps) };
}

async function recording(r: ReturnType<typeof rig>) {
  r.m.request();
  await r.m.confirm();
  r.m.flagIs('us');
}

describe('a recording that ends by itself', () => {
  it('stops, clears the flag and never reports a plain save', async () => {
    const r = rig();
    await recording(r);
    r.m.interrupted();
    await vi.waitFor(() => expect(r.m.state).toBe('idle'));
    expect(r.captureStop).toHaveBeenCalledTimes(1);
    expect(r.deps.setFlag).toHaveBeenLastCalledWith(false);
    expect(r.deps.onInterrupted).toHaveBeenCalledTimes(1);
    expect(r.deps.onSaved).not.toHaveBeenCalled();
  });

  it('says the file was lost when closing it fails', async () => {
    const r = rig();
    await recording(r);
    r.captureStop.mockRejectedValueOnce(new Error('disk'));
    r.m.interrupted();
    await vi.waitFor(() => expect(r.m.state).toBe('idle'));
    expect(r.deps.onSaveFailed).toHaveBeenCalledTimes(1);
    expect(r.deps.onInterrupted).not.toHaveBeenCalled();
    expect(r.deps.onSaved).not.toHaveBeenCalled();
    expect(r.deps.setFlag).toHaveBeenLastCalledWith(false);
  });
});

describe('a flag that never reads back', () => {
  it('stops once the bound passes, though nothing announced a change', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      r.m.request();
      await r.m.confirm();
      r.m.flagIs('nobody'); // cleared during the start: no stop on its own
      expect(r.m.state).toBe('recording');
      await vi.advanceTimersByTimeAsync(FLAG_SEEN_WITHIN_MS);
      expect(r.m.state).toBe('idle');
      expect(r.deps.onInterrupted).toHaveBeenCalledTimes(1);
      expect(r.deps.setFlag).toHaveBeenLastCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves a recording alone once the flag was seen', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      await recording(r);
      await vi.advanceTimersByTimeAsync(FLAG_SEEN_WITHIN_MS * 2);
      expect(r.m.state).toBe('recording');
      expect(r.captureStop).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('finishRecording', () => {
  const sinkRig = () => ({ close: vi.fn(async () => {}) });
  const recorderIn = (state: string) => ({ state, stop: vi.fn() });

  it('closes the file when the recorder already stopped itself', async () => {
    const sink = sinkRig();
    const recorder = recorderIn('inactive');
    await finishRecording({
      recorder,
      ended: Promise.resolve(),
      flushed: async () => {},
      sink,
    });
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(recorder.stop).not.toHaveBeenCalled();
  });

  it('closes it even if the stop event never comes', async () => {
    vi.useFakeTimers();
    try {
      const sink = sinkRig();
      const done = finishRecording({
        recorder: recorderIn('inactive'),
        ended: new Promise(() => {}),
        flushed: async () => {},
        sink,
      });
      await vi.advanceTimersByTimeAsync(LAST_DATA_WAIT_MS);
      await done;
      expect(sink.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the last chunk before closing', async () => {
    const order: string[] = [];
    await finishRecording({
      recorder: recorderIn('recording'),
      ended: Promise.resolve().then(() => void order.push('ended')),
      flushed: async () => void order.push('flushed'),
      sink: { close: async () => void order.push('closed') },
    });
    expect(order).toEqual(['ended', 'flushed', 'closed']);
  });

  it('still closes after a failed write, and rejects', async () => {
    const sink = sinkRig();
    await expect(
      finishRecording({
        recorder: recorderIn('recording'),
        ended: Promise.resolve(),
        flushed: async () => {
          throw new Error('disk');
        },
        sink,
      })
    ).rejects.toThrow('disk');
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when the close fails', async () => {
    await expect(
      finishRecording({
        recorder: recorderIn('inactive'),
        ended: Promise.resolve(),
        flushed: async () => {},
        sink: { close: () => Promise.reject(new Error('disk')) },
      })
    ).rejects.toThrow('disk');
  });
});

describe('consent rules', () => {
  it('raises the flag before any capture starts', async () => {
    const r = rig();
    await recording(r);
    expect(r.m.state).toBe('recording');
    expect(r.deps.setFlag.mock.invocationCallOrder[0]).toBeLessThan(
      r.deps.begin.mock.invocationCallOrder[0]
    );
  });

  it.each(['already_recording', 'unavailable', 'failed'] as const)(
    'never records on %s',
    async (answer) => {
      const r = rig(answer);
      r.m.request();
      await r.m.confirm();
      expect(r.deps.begin).not.toHaveBeenCalled();
      expect(r.m.state).toBe('idle');
      expect(r.deps.onRefused).toHaveBeenCalledWith(answer);
      expect(r.sink.abort).toHaveBeenCalled();
    }
  );

  it('never records when the flag request throws', async () => {
    const r = rig();
    r.deps.setFlag.mockRejectedValueOnce(new Error('offline'));
    r.m.request();
    await r.m.confirm();
    expect(r.deps.begin).not.toHaveBeenCalled();
  });

  it('leaves the flag alone when the save dialog is cancelled', async () => {
    const r = rig();
    r.deps.pickSink.mockResolvedValueOnce(null);
    r.m.request();
    await r.m.confirm();
    expect(r.deps.setFlag).not.toHaveBeenCalled();
    expect(r.m.state).toBe('idle');
  });

  it('clears the flag when capture cannot start', async () => {
    const r = rig();
    r.deps.begin.mockRejectedValueOnce(new Error('no codec'));
    r.m.request();
    await r.m.confirm();
    expect(r.deps.setFlag).toHaveBeenLastCalledWith(false);
    expect(r.deps.onRefused).toHaveBeenCalledWith('start_failed');
  });

  it('stops at once when the flag vanishes', async () => {
    const r = rig();
    await recording(r);
    r.m.flagIs('nobody');
    await vi.waitFor(() => expect(r.m.state).toBe('idle'));
    expect(r.captureStop).toHaveBeenCalled();
    expect(r.deps.onSaved).toHaveBeenCalledWith('a.webm');
  });

  it("stops without touching another person's new flag", async () => {
    const r = rig();
    await recording(r);
    r.m.flagIs('other');
    await vi.waitFor(() => expect(r.m.state).toBe('idle'));
    expect(r.deps.setFlag).not.toHaveBeenCalledWith(false);
  });

  it('saves first, then clears the flag, even if the save failed', async () => {
    const r = rig();
    await recording(r);
    r.captureStop.mockRejectedValueOnce(new Error('disk full'));
    await r.m.stop();
    expect(r.deps.setFlag).toHaveBeenLastCalledWith(false);
    expect(r.deps.onSaveFailed).toHaveBeenCalled();
    expect(r.m.state).toBe('idle');
  });

  it('a stop while starting ends with no capture and no flag', async () => {
    const r = rig();
    r.m.request();
    const started = r.m.confirm();
    void r.m.stop();
    await started;
    expect(r.deps.begin).not.toHaveBeenCalled();
    expect(r.m.state).toBe('idle');
  });
});

describe('recordingLayout', () => {
  const p = (id: string, extra = {}) => ({
    id,
    name: id,
    camera: `${id}-cam`,
    screen: null as string | null,
    ...extra,
  });

  it('fills the frame with a screen and keeps the speaker in a corner', () => {
    const boxes = recordingLayout({
      people: [p('a'), p('b', { screen: 'b-screen' })],
      activeSpeakerId: 'a',
    });
    expect(boxes[0]).toMatchObject({
      track: 'b-screen',
      fit: 'contain',
      w: 1280,
    });
    expect(boxes[1]).toMatchObject({ track: 'a-cam', fit: 'cover', w: 256 });
  });

  it('shows the speaker, else a grid of at most four', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => p(id));
    expect(
      recordingLayout({ people: five, activeSpeakerId: 'c' })
    ).toMatchObject([{ personId: 'c', w: 1280, h: 720 }]);
    const grid = recordingLayout({ people: five, activeSpeakerId: null });
    expect(grid).toHaveLength(4);
    expect(grid[3]).toMatchObject({ x: 640, y: 360, w: 640, h: 360 });
  });
});

describe('small rules', () => {
  it('prefers vp9, then vp8, then plain webm', () => {
    expect(pickMimeType(() => true)).toBe('video/webm;codecs=vp9,opus');
    expect(pickMimeType((t) => !t.includes('vp9'))).toBe(
      'video/webm;codecs=vp8,opus'
    );
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
    expect(pickMimeType(() => false)).toBeNull();
  });

  it('names the file safely', () => {
    const d = new Date('2026-11-05T10:30:00Z');
    expect(recordingFileName('Q4 / review: "final"', d)).toBe(
      'Q4-review-final-2026-11-05-10-30.webm'
    );
    expect(recordingFileName('///', d)).toBe('meeting-2026-11-05-10-30.webm');
  });

  it('offers the entry to moderators, and Stop to the recorder', () => {
    const base = { state: 'idle', recordingBy: null, selfId: 'u' } as const;
    expect(recordEntry({ ...base, canModerate: false })).toBeNull();
    expect(recordEntry({ ...base, canModerate: true })).toBe('start');
    expect(recordEntry({ ...base, canModerate: true, recordingBy: 'x' })).toBe(
      'taken'
    );
    expect(
      recordEntry({ ...base, canModerate: false, state: 'recording' })
    ).toBe('stop');
  });
});
