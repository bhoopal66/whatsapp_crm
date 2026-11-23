import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingCallEngine } from '@/hooks/use-meeting-call';

// Production, 2026-11: Cloudflare dropped a slow joiner's session (410),
// the engine stopped the mic's transceiver and added another, Chrome never
// gave that one a mid, and the person sat in a room hearing nobody.

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

const ANSWER = {
  ok: true,
  status: 200,
  body: { sessionDescription: { type: 'answer', sdp: 'a' }, tracks: [] },
};
const failure = (status: number, body: unknown = null) => ({
  ok: false,
  status,
  body,
});

class FakeTransceiver {
  mid: string | null = null;
  direction = 'sendonly';
  currentDirection: string | null = null;
  sender = { replaceTrack: vi.fn(async () => {}) };
  receiver = { track: {} };
  stop = vi.fn(() => {
    this.direction = 'stopped';
  });
}

/** As Chrome: a stopped, never-negotiated transceiver takes the m-line. */
class FakePc {
  signalingState = 'stable';
  transceivers: FakeTransceiver[] = [];
  private provisional: FakeTransceiver[] = [];
  private next = 0;
  addTransceiver = vi.fn(() => {
    const t = new FakeTransceiver();
    this.transceivers.push(t);
    return t;
  });
  getTransceivers = () => this.transceivers;
  createOffer = async () => ({ type: 'offer', sdp: 'o' });
  localDescription = { sdp: 'o' };
  setLocalDescription = vi.fn(async (d: { type: string }) => {
    if (d.type === 'rollback') {
      for (const t of this.provisional) t.mid = null;
      this.next -= this.provisional.length;
      this.signalingState = 'stable';
      return;
    }
    const dead = this.transceivers.some(
      (t) => !t.mid && t.direction === 'stopped'
    );
    this.provisional = dead ? [] : this.transceivers.filter((t) => !t.mid);
    for (const t of this.provisional) t.mid = String(this.next++);
    this.signalingState = 'have-local-offer';
  });
  setRemoteDescription = vi.fn(async () => {
    this.signalingState = 'stable';
  });
  close = vi.fn();
}

interface Inner {
  attached: boolean;
  pc: unknown;
  participantId: string | null;
  audio: MediaStreamTrack | null;
  audioSender: unknown;
  videoSender: unknown;
  pulled: Map<string, unknown>;
  api: ReturnType<typeof vi.fn>;
  heartbeat: () => Promise<void>;
  reconnect: ReturnType<typeof vi.fn>;
  connectionFailed: ReturnType<typeof vi.fn>;
  publish: (e: unknown[]) => Promise<void>;
  pull: (refs: unknown[]) => Promise<void>;
  closeRemote: (names: string[]) => Promise<void>;
}

const mic = () =>
  ({
    id: 'mic',
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
  }) as unknown as MediaStreamTrack;

function setup(answers: unknown[]) {
  const engine = new MeetingCallEngine('m');
  const inner = engine as unknown as Inner;
  const pc = new FakePc();
  inner.attached = true;
  inner.pc = pc;
  inner.participantId = 'me';
  inner.api = vi.fn(async () => answers.shift() ?? ANSWER);
  inner.heartbeat = async () => {};
  inner.reconnect = vi.fn(async () => {});
  inner.connectionFailed = vi.fn();
  return { engine, inner, pc };
}

const audioPublish = (inner: Inner) => {
  inner.audio = mic();
  return inner.publish([{ track: inner.audio, kind: 'audio' }]);
};
const REF = {
  participantId: 'p',
  sessionId: 's',
  trackName: 'p:audio',
  kind: 'audio',
};

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('a failed publish', () => {
  it('retries on the same transceiver and never sends a null mid', async () => {
    const { inner, pc } = setup([failure(0)]);
    await audioPublish(inner);
    expect(pc.transceivers[0].stop).not.toHaveBeenCalled();
    await audioPublish(inner);
    expect(pc.addTransceiver).toHaveBeenCalledTimes(1);
    const mids = inner.api.mock.calls.map((c) => c[2].request.tracks[0].mid);
    expect(mids).toEqual(['0', '0']);
    expect(inner.audioSender).toBe(pc.transceivers[0].sender);
  });

  it('rejoins instead of sending a null mid', async () => {
    const { inner, pc } = setup([]);
    const dead = pc.addTransceiver();
    dead.stop();
    await audioPublish(inner);
    expect(inner.api).not.toHaveBeenCalled();
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
  });

  it('says the service is unreachable, not the microphone broken', async () => {
    const { engine, inner } = setup([failure(0)]);
    await audioPublish(inner);
    expect(engine.getSnapshot().devices.audio).toBe('unreachable');
    expect(engine.toCall(engine.getSnapshot()).rejoin).toBeTypeOf('function');
  });

  it('keeps the track when the session is gone, for the rejoin', async () => {
    const { inner } = setup([failure(410)]);
    await audioPublish(inner);
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
    expect(inner.audio).not.toBeNull();
    expect(inner.audio?.stop).not.toHaveBeenCalled();
  });

  it('is a failure when only its track was refused', async () => {
    const { inner, pc } = setup([
      {
        ...ANSWER,
        body: {
          ...ANSWER.body,
          tracks: [{ trackName: 'me:audio', mid: '0', errorCode: 'x' }],
        },
      },
    ]);
    const video = { ...mic(), kind: 'video' };
    inner.audio = mic();
    await inner.publish([
      { track: inner.audio, kind: 'audio' },
      { track: video, kind: 'video' },
    ]);
    expect(inner.audioSender).toBeNull();
    expect(inner.audio).toBeNull();
    expect(inner.videoSender).toBe(pc.transceivers[1].sender);
  });
});

describe('a pull on a dead session', () => {
  it('rejoins on 410, within the budget, then ends the call', async () => {
    const { inner } = setup(Array.from({ length: 4 }, () => failure(410)));
    for (let i = 0; i < 4; i++) await inner.pull([REF]);
    expect(inner.reconnect).toHaveBeenCalledTimes(3);
    expect(inner.connectionFailed).toHaveBeenCalledTimes(1);
  });

  it('rejoins on the second refusal in a row, never on an outage', async () => {
    const bad = failure(502, { sfuStatus: 400 });
    const { inner } = setup([bad, failure(502), failure(403), bad]);
    for (let i = 0; i < 3; i++) await inner.pull([REF]);
    expect(inner.reconnect).not.toHaveBeenCalled();
    await inner.pull([REF]);
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
  });

  it('leaves a seat closed under us alone', async () => {
    const { inner } = setup([failure(410)]);
    inner.heartbeat = async () => {
      inner.pc = null;
    };
    await inner.pull([REF]);
    expect(inner.reconnect).not.toHaveBeenCalled();
  });
});

describe('closing a received track', () => {
  function receiving(inner: Inner, pc: FakePc, n: number) {
    for (let i = 0; i < n; i++) {
      const t = pc.addTransceiver();
      t.mid = String(i);
      t.direction = 'recvonly';
      inner.pulled.set(`t${i}`, { mid: t.mid });
    }
  }

  it('rejoins when setLocalDescription throws', async () => {
    const { inner, pc } = setup([]);
    receiving(inner, pc, 2);
    pc.setLocalDescription.mockRejectedValue(new Error('no BUNDLE'));
    await inner.closeRemote(['t0']);
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
  });

  it('rejoins when the rollback fails', async () => {
    const { inner, pc } = setup([failure(0)]);
    receiving(inner, pc, 2);
    const apply = pc.setLocalDescription.getMockImplementation()!;
    pc.setLocalDescription.mockImplementation(async (d) => {
      if (d.type === 'rollback') throw new Error('refused');
      return apply(d);
    });
    await inner.closeRemote(['t0']);
    expect(inner.reconnect).toHaveBeenCalledTimes(1);
  });

  it('never stops the last m-line', async () => {
    const { inner, pc } = setup([]);
    receiving(inner, pc, 1);
    await inner.closeRemote(['t0']);
    expect(pc.transceivers[0].stop).not.toHaveBeenCalled();
    expect(pc.transceivers[0].direction).toBe('inactive');
    expect(pc.setLocalDescription).not.toHaveBeenCalled();
    expect(inner.api.mock.calls[0][2].request).toEqual({
      tracks: [{ mid: '0' }],
      force: true,
    });
  });
});
