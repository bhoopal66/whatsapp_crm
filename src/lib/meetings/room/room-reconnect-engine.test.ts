import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingCallEngine } from '@/hooks/use-meeting-call';

// A blip mid-reconnect is not the end of the call: the session drops the
// held engine, and the recorder stops, on any phase that is not in-call,
// and listeners run synchronously, so an `error` for one tick is fatal.

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const JOINED = {
  ok: true,
  status: 200,
  body: { participantId: 'seat-2', sessionId: 's', iceServers: [] },
};
const NETWORK = { ok: false, status: 0, body: null };

const track = (id: string) =>
  ({
    id,
    kind: 'video',
    enabled: true,
    stop: vi.fn(),
  }) as unknown as MediaStreamTrack;

/** The engine's privates these tests set up or replace. */
interface Inner {
  attached: boolean;
  pc: unknown;
  participantId: string | null;
  audio: MediaStreamTrack | null;
  video: MediaStreamTrack | null;
  api: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  leaveSeat: ReturnType<typeof vi.fn>;
  leaveQuietly: ReturnType<typeof vi.fn>;
  subscribeRows: () => Promise<void>;
  loadChat: () => Promise<void>;
  heartbeat: () => Promise<void>;
  replan: () => void;
  reconnect: () => Promise<void>;
  applyMeeting: (row: Record<string, unknown>) => void;
  viewer: { userId: string | null; role: null };
  session: number;
}

function setup(answers: unknown[]) {
  const engine = new MeetingCallEngine('m');
  const inner = engine as unknown as Inner;
  const phases: { phase: string; error: string | null }[] = [];
  inner.attached = true;
  inner.pc = { close: vi.fn() };
  inner.participantId = 'seat-1';
  inner.api = vi.fn(async () => answers.shift() ?? NETWORK);
  inner.publish = vi.fn(async () => {});
  inner.leaveSeat = vi.fn();
  inner.leaveQuietly = vi.fn();
  inner.subscribeRows = async () => {};
  inner.loadChat = async () => {};
  inner.heartbeat = async () => {};
  inner.replan = () => {};
  engine.subscribe(() => {
    const { phase, error } = engine.getSnapshot();
    phases.push({ phase, error });
  });
  return { engine, inner, phases };
}

const joinCalls = (inner: Inner) =>
  inner.api.mock.calls.filter((c) => c[0] === 'join').length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      addEventListener() {}
      close() {}
    }
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a rejoin the network refuses', () => {
  it('stays reconnecting, retries, and comes back live', async () => {
    const { engine, inner, phases } = setup([NETWORK, JOINED]);
    const done = inner.reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(joinCalls(inner)).toBe(1);
    expect(engine.getSnapshot().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(joinCalls(inner)).toBe(2);
    expect(engine.getSnapshot().phase).toBe('live');
    expect(phases.map((p) => p.phase)).not.toContain('error');
    engine.detach();
  });

  it('ends as connection_failed once the tries run out', async () => {
    const { engine, inner, phases } = setup([]);
    void inner.reconnect();
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
    expect(joinCalls(inner)).toBe(3);
    expect(engine.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'connection_failed',
    });
    const errors = phases.filter((p) => p.phase === 'error');
    expect(new Set(errors.map((p) => p.error))).toEqual(
      new Set(['connection_failed'])
    );
    engine.detach();
  });

  it('lets a refusal with a reason stand, with no retry', async () => {
    const closed = { ok: false, status: 409, body: { error: 'closed' } };
    const { engine, inner } = setup([closed]);
    void inner.reconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(joinCalls(inner)).toBe(1);
    expect(engine.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'meeting_closed',
    });
    engine.detach();
  });

  it('still shows join_failed for a first join', async () => {
    const { engine, inner } = setup([NETWORK]);
    inner.pc = null;
    inner.participantId = null;
    await engine.join();
    expect(engine.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'join_failed',
    });
    expect(joinCalls(inner)).toBe(1);
    engine.detach();
  });
});

describe('a recording already running when we arrive', () => {
  const FLAG = {
    id: 'm',
    status: 'scheduled',
    recording_by: 'someone',
    recording_started_at: '2026-11-05T10:00:00.000Z',
  };
  const started = (e: MeetingCallEngine) =>
    e.getSnapshot().notices.filter((n) => n.kind === 'recording_started');

  function arriving() {
    const s = setup([JOINED, JOINED]);
    s.inner.pc = null;
    s.inner.participantId = null;
    s.inner.applyMeeting(FLAG);
    return s;
  }

  it('is announced once on going live, not again on a rejoin', async () => {
    const { engine, inner } = arriving();
    expect(started(engine)).toHaveLength(0);
    await engine.join();
    expect(engine.getSnapshot().phase).toBe('live');
    expect(started(engine)).toHaveLength(1);
    void inner.reconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.getSnapshot().phase).toBe('live');
    expect(started(engine)).toHaveLength(1);
    engine.detach();
  });

  it('is not announced twice when the row already announced it', async () => {
    const { engine, inner } = setup([JOINED]);
    inner.pc = null;
    inner.participantId = null;
    inner.applyMeeting({ ...FLAG, recording_started_at: null });
    inner.applyMeeting(FLAG);
    expect(started(engine)).toHaveLength(1);
    await engine.join();
    expect(started(engine)).toHaveLength(1);
    engine.detach();
  });

  it('is not announced to the person recording', async () => {
    const { engine, inner } = arriving();
    inner.viewer = { userId: 'someone', role: null };
    await engine.join();
    expect(started(engine)).toHaveLength(0);
    engine.detach();
  });
});

describe('running out of tries', () => {
  it('releases the camera and mic, and refuses a late open', async () => {
    const { engine, inner } = setup([]);
    const camera = track('camera');
    const mic = track('mic');
    inner.video = camera;
    inner.audio = mic;
    const before = inner.session;
    void inner.reconnect();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(engine.getSnapshot().phase).toBe('error');
    expect(camera.stop).toHaveBeenCalled();
    expect(mic.stop).toHaveBeenCalled();
    expect(inner.video).toBeNull();
    expect(inner.audio).toBeNull();
    expect(inner.session).toBeGreaterThan(before);
    engine.detach();
  });
});
