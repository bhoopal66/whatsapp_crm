import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingCallEngine } from '@/hooks/use-meeting-call';
import type { BackgroundEffect } from '@/lib/meetings/effects/types';

// The privacy rule: a person who chose a background never has the raw
// camera reach a sender. The processor is faked; each test holds the
// moment it starts, gives up or fails.

interface FakeProcessor {
  start: ReturnType<typeof vi.fn>;
  setEffect: ReturnType<typeof vi.fn>;
  setInput: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onGiveUp: (fn: () => void) => void;
  giveUp: () => void;
  started: (out: MediaStreamTrack) => void;
  refused: () => void;
}

const fx = vi.hoisted(() => ({ made: [] as unknown[] }));

function makeProcessor() {
  const p = { giveUp: () => {} } as FakeProcessor;
  p.start = vi.fn(
    () =>
      new Promise((resolve, reject) => {
        p.started = resolve;
        p.refused = () => reject(new Error('load_failed'));
      })
  );
  p.setEffect = vi.fn();
  p.setInput = vi.fn(async () => {});
  p.stop = vi.fn();
  p.onGiveUp = (fn) => {
    p.giveUp = fn;
  };
  fx.made.push(p);
  return p;
}

vi.mock('@/lib/meetings/effects/processor', () => ({
  createVideoEffectProcessor: () => makeProcessor(),
  effectsSupported: () => true,
}));

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const BLUR: BackgroundEffect = { kind: 'blur', strength: 'strong' };

const track = (id: string) =>
  ({
    id,
    kind: 'video',
    enabled: true,
    stop: vi.fn(),
    addEventListener: vi.fn(),
  }) as unknown as MediaStreamTrack;

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** The engine's privates these tests set up or replace. */
interface Inner {
  attached: boolean;
  video: MediaStreamTrack | null;
  videoSender: { replaceTrack: ReturnType<typeof vi.fn> } | null;
  participantId: string | null;
  pc: unknown;
  api: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribeRows: () => Promise<void>;
  loadChat: () => Promise<void>;
  heartbeat: () => Promise<void>;
  replan: () => void;
  stopMedia: () => void;
  emit: () => void;
  onTrackEnded: (kind: 'video', t: MediaStreamTrack) => void;
}

function setup(opts: { live?: boolean; camera?: boolean } = {}) {
  const engine = new MeetingCallEngine('m');
  const inner = engine as unknown as Inner;
  const raw = track('raw');
  const out = track('out');
  const sender = { replaceTrack: vi.fn(async () => {}) };
  inner.attached = true;
  inner.api = vi.fn(async () => ({ ok: true, status: 200, body: {} }));
  if (opts.camera !== false) inner.video = raw;
  if (opts.live !== false) {
    inner.pc = {};
    inner.participantId = 'seat';
    inner.videoSender = sender;
  }
  return { engine, inner, raw, out, sender };
}

const lastProcessor = () => fx.made.at(-1) as FakeProcessor;
const snap = (e: MeetingCallEngine) => e.getSnapshot();
const noticeKinds = (e: MeetingCallEngine) =>
  snap(e).notices.map((n) => n.kind);
const sent = (sender: { replaceTrack: ReturnType<typeof vi.fn> }) =>
  sender.replaceTrack.mock.calls.map((c) => c[0]);

function expectCameraOffAfterFailure(
  s: ReturnType<typeof setup>,
  processor: FakeProcessor
) {
  expect(sent(s.sender)).not.toContain(s.raw);
  expect(s.raw.stop).toHaveBeenCalled();
  expect(processor.stop).toHaveBeenCalled();
  expect(snap(s.engine).cameraOn).toBe(false);
  expect(snap(s.engine).localVideo).toBeNull();
  expect(noticeKinds(s.engine)).toContain('background_failed');
  // The choice is kept for the camera's next turn.
  expect(snap(s.engine).background).toEqual(BLUR);
}

async function running(s: ReturnType<typeof setup>) {
  const picked = s.engine.setBackground(BLUR);
  lastProcessor().started(s.out);
  await picked;
  return lastProcessor();
}

beforeEach(() => {
  fx.made.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a background that fails', () => {
  it('turns the camera off in the tick the processor gives up', async () => {
    const s = setup();
    const processor = await running(s);
    expect(sent(s.sender)).toEqual([null, s.out]);
    processor.giveUp();
    expect(sent(s.sender)).toEqual([null, s.out, null]);
    expectCameraOffAfterFailure(s, processor);
    expect(s.inner.api).toHaveBeenCalledWith(
      'state',
      'POST',
      expect.objectContaining({ videoOff: true })
    );
  });

  it('turns the camera off when the processor cannot start', async () => {
    const s = setup();
    const picked = s.engine.setBackground(BLUR);
    expect(snap(s.engine).backgroundBusy).toBe(true);
    lastProcessor().refused();
    await picked;
    expect(sent(s.sender)).toEqual([null, null]);
    expectCameraOffAfterFailure(s, lastProcessor());
    expect(snap(s.engine).backgroundBusy).toBe(false);
  });

  it('ignores a give-up from a processor already replaced', async () => {
    const s = setup();
    const processor = await running(s);
    await s.engine.setBackground({ kind: 'none' });
    processor.giveUp();
    expect(snap(s.engine).cameraOn).toBe(true);
    expect(noticeKinds(s.engine)).toEqual([]);
  });
});

describe('joining with a background', () => {
  function joinable() {
    const s = setup({ live: false });
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        addEventListener() {}
        close() {}
      }
    );
    s.inner.api = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { participantId: 'seat', sessionId: 's', iceServers: [] },
    }));
    s.inner.publish = vi.fn(async () => {});
    s.inner.subscribeRows = async () => {};
    s.inner.loadChat = async () => {};
    s.inner.heartbeat = async () => {};
    s.inner.replan = () => {};
    return s;
  }

  it('publishes nothing until the processor is ready, then its output', async () => {
    const s = joinable();
    void s.engine.setBackground(BLUR);
    const joined = s.engine.join();
    await flush();
    expect(s.inner.publish).not.toHaveBeenCalled();
    lastProcessor().started(s.out);
    await joined;
    expect(s.inner.publish).toHaveBeenCalledTimes(1);
    expect(s.inner.publish).toHaveBeenCalledWith([
      { track: s.out, kind: 'video' },
    ]);
    s.engine.detach();
  });

  it('joins with the camera off once the wait runs out', async () => {
    vi.useFakeTimers();
    const s = joinable();
    void s.engine.setBackground(BLUR);
    const joined = s.engine.join();
    await vi.advanceTimersByTimeAsync(8_000);
    await joined;
    expect(s.inner.publish).not.toHaveBeenCalled();
    expectCameraOffAfterFailure(s, lastProcessor());
    s.engine.detach();
  });
});

describe('the camera with a background set', () => {
  it('sends the processed track, never raw, when turned back on', async () => {
    const s = setup({ camera: false });
    await s.engine.setBackground(BLUR); // off: only remembered
    expect(fx.made).toHaveLength(0);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [s.raw] }),
      },
    });
    const on = s.engine.toggleCamera();
    await flush();
    expect(lastProcessor().start).toHaveBeenCalledWith(s.raw, BLUR);
    expect(s.sender.replaceTrack).not.toHaveBeenCalled();
    lastProcessor().started(s.out);
    await on;
    expect(sent(s.sender)).toEqual([s.out]);
  });

  it('feeds a new camera in without touching the sender', async () => {
    const s = setup();
    const processor = await running(s);
    s.sender.replaceTrack.mockClear();
    const next = track('next');
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [next] }),
      },
    });
    vi.stubGlobal('localStorage', { setItem: () => {} });
    await s.engine.selectDevice('videoinput', 'cam2');
    expect(processor.setInput).toHaveBeenCalledWith(next);
    expect(s.sender.replaceTrack).not.toHaveBeenCalled();
    expect(s.raw.stop).toHaveBeenCalled();
    expect(s.inner.video).toBe(next);
    expect(snap(s.engine).localVideo).toBe(s.out);
  });

  it('turns the camera off when the new camera sends no frames', async () => {
    const s = setup();
    const processor = await running(s);
    const next = track('next');
    processor.setInput.mockRejectedValueOnce(new Error('no_video'));
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getTracks: () => [next] }),
      },
    });
    await s.engine.selectDevice('videoinput', 'cam2');
    expect(next.stop).toHaveBeenCalled();
    expectCameraOffAfterFailure(s, processor);
  });

  it('restarts through the processor when a busy camera had to go', async () => {
    const s = setup();
    const first = await running(s);
    s.sender.replaceTrack.mockClear();
    const next = track('next');
    const busy = Object.assign(new Error('busy'), { name: 'NotReadableError' });
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValue({ getTracks: () => [next] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const picked = s.engine.selectDevice('videoinput', 'cam2');
    await flush();
    expect(first.stop).toHaveBeenCalled();
    expect(s.raw.stop).toHaveBeenCalled();
    expect(sent(s.sender)).toEqual([null]);
    const out2 = track('out2');
    lastProcessor().started(out2);
    await picked;
    expect(lastProcessor().start).toHaveBeenCalledWith(next, BLUR);
    expect(sent(s.sender)).toEqual([null, out2]);
  });
});

describe('one publication per kind', () => {
  function racing() {
    const s = setup({ live: false, camera: false });
    const addTransceiver = vi.fn((t: MediaStreamTrack) => ({
      mid: t.id,
      sender: { replaceTrack: vi.fn(async () => {}) },
    }));
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        addTransceiver = addTransceiver;
        addEventListener() {}
        close() {}
      }
    );
    const raw = s.raw;
    const inner = s.inner as unknown as Inner & {
      open: () => Promise<MediaStreamTrack>;
      offer: () => Promise<void>;
      publish: unknown;
    };
    inner.open = async () => raw;
    inner.offer = async () => {};
    inner.api = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { participantId: 'seat', sessionId: 's', iceServers: [] },
    }));
    inner.subscribeRows = async () => {};
    inner.loadChat = async () => {};
    inner.heartbeat = async () => {};
    inner.replan = () => {};
    return { ...s, addTransceiver };
  }

  it('publishes the camera once when a toggle and a join both wait on the effect', async () => {
    const s = racing();
    await s.engine.setBackground(BLUR);
    const toggled = s.engine.toggleCamera();
    await flush();
    const joined = s.engine.join();
    await flush();
    lastProcessor().started(s.out);
    await Promise.all([toggled, joined]);
    expect(s.addTransceiver).toHaveBeenCalledTimes(1);
    expect(s.addTransceiver.mock.calls[0][0]).toBe(s.out);
    s.engine.detach();
  });

  it('publishes the mic once when it opens during a join', async () => {
    const s = racing();
    const mic = track('mic');
    const inner = s.inner as unknown as { audio: MediaStreamTrack | null };
    await s.engine.setBackground(BLUR);
    s.inner.video = s.raw;
    const joined = s.engine.join();
    await flush();
    (s.inner as unknown as { open: () => Promise<unknown> }).open = async () =>
      mic;
    await s.engine.toggleMic();
    expect(inner.audio).toBe(mic);
    lastProcessor().started(s.out);
    await joined;
    const tracks = s.addTransceiver.mock.calls.map((c) => c[0]);
    expect(tracks.filter((t) => t === mic)).toHaveLength(1);
    s.engine.detach();
  });
});

describe('choosing and stopping', () => {
  it('never leaves the raw camera on the sender while the effect loads', async () => {
    const s = setup();
    const picked = s.engine.setBackground(BLUR);
    await flush();
    expect(sent(s.sender)).toEqual([null]);
    lastProcessor().started(s.out);
    await picked;
    expect(sent(s.sender)).toEqual([null, s.out]);
  });

  it('shows the output as our self-view once it is ready', async () => {
    const s = setup();
    await running(s);
    expect(snap(s.engine).localVideo).toBe(s.out);
    expect(snap(s.engine).background).toEqual(BLUR);
  });

  it('switches effect on the same output track', async () => {
    const s = setup();
    const processor = await running(s);
    const next: BackgroundEffect = { kind: 'color', preset: 'navy' };
    await s.engine.setBackground(next);
    expect(processor.setEffect).toHaveBeenCalledWith(next);
    expect(fx.made).toHaveLength(1);
    expect(sent(s.sender)).toEqual([null, s.out, s.out]);
  });

  it('goes back to the raw camera only when none is chosen', async () => {
    const s = setup();
    const processor = await running(s);
    await s.engine.setBackground({ kind: 'none' });
    expect(processor.stop).toHaveBeenCalled();
    expect(sent(s.sender)).toEqual([null, s.out, s.raw]);
    expect(snap(s.engine).localVideo).toBe(s.raw);
  });

  it('stops the processor with the camera', async () => {
    const s = setup();
    const processor = await running(s);
    await s.engine.toggleCamera();
    expect(processor.stop).toHaveBeenCalled();
    expect(snap(s.engine).localVideo).toBeNull();
    expect(noticeKinds(s.engine)).toEqual([]);
  });

  it('stops the processor when the camera is unplugged', async () => {
    const s = setup();
    const processor = await running(s);
    s.inner.onTrackEnded('video', s.raw);
    expect(processor.stop).toHaveBeenCalled();
    expect(sent(s.sender)).toEqual([null, s.out, null]);
  });

  it('stops a processor still loading with the media', async () => {
    const s = setup();
    const picked = s.engine.setBackground(BLUR);
    s.inner.stopMedia();
    await picked; // settles at once: nobody waits on a stopped start
    expect(lastProcessor().stop).toHaveBeenCalled();
    lastProcessor().started(s.out); // a late answer changes nothing
    await flush();
    s.inner.emit();
    expect(snap(s.engine).localVideo).toBeNull();
    expect(snap(s.engine).backgroundBusy).toBe(false);
  });
});
