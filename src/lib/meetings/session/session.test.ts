import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  endedNotice,
  isInCall,
  MeetingSession,
  offRoomTileSizes,
  readRejoinMarker,
  REJOIN_MARKER_TTL_MS,
  writeRejoinMarker,
  type SessionEnded,
  type SessionEngine,
  type SessionEngineSnapshot,
} from './session';

class FakeEngine implements SessionEngine {
  attach = vi.fn();
  detach = vi.fn();
  leave = vi.fn(async () => {
    this.set({ phase: 'left' });
  });
  private snap: SessionEngineSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(readonly meetingId: string) {
    this.snap = {
      phase: 'lobby',
      error: null,
      meeting: { title: `T-${meetingId}` },
    };
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snap;
  set(patch: Partial<SessionEngineSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((fn) => fn());
  }
}

describe('isInCall', () => {
  it('is true only while a seat is held or being taken', () => {
    for (const p of ['joining', 'live', 'reconnecting']) {
      expect(isInCall(p)).toBe(true);
    }
    for (const p of ['lobby', 'left', 'removed', 'ended', 'error']) {
      expect(isInCall(p)).toBe(false);
    }
  });
});

describe('MeetingSession', () => {
  let ticks: (() => void)[];
  let ended: SessionEnded[];
  let session: MeetingSession<FakeEngine>;
  const tick = () => ticks.splice(0).forEach((fn) => fn());
  const engineFor = (id: string) => {
    const engine = new FakeEngine(id);
    return { engine, create: vi.fn(() => engine) };
  };

  beforeEach(() => {
    ticks = [];
    ended = [];
    session = new MeetingSession<FakeEngine>({
      defer: (fn) => {
        ticks.push(fn);
        return () => {
          ticks = ticks.filter((f) => f !== fn);
        };
      },
      onEnded: (e) => ended.push(e),
    });
  });

  it('creates and attaches once, then reuses', () => {
    const { engine, create } = engineFor('a');
    expect(session.open('a', create)).toEqual({ kind: 'ready', engine });
    expect(session.open('a', create)).toEqual({ kind: 'ready', engine });
    expect(create).toHaveBeenCalledTimes(1);
    expect(engine.attach).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().engine).toBe(engine);
  });

  it('survives open, release, open within a tick', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    session.release('a');
    session.open('a', create);
    tick();
    expect(engine.attach).toHaveBeenCalledTimes(1);
    expect(engine.detach).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ engine, claimed: true });
  });

  it('releases a lobby after the tick, so its devices close', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    session.release('a');
    expect(engine.detach).not.toHaveBeenCalled();
    tick();
    expect(engine.detach).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().engine).toBeNull();
    expect(ended).toEqual([]);
  });

  it('keeps a live call when the room page goes away', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    engine.set({ phase: 'live' });
    session.release('a');
    tick();
    expect(engine.detach).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ engine, claimed: false });
  });

  it('reuses a held call when the room page comes back', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    engine.set({ phase: 'live' });
    session.release('a');
    tick();
    expect(session.open('a', create)).toEqual({ kind: 'ready', engine });
    expect(engine.attach).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().claimed).toBe(true);
  });

  it('reports a call that ends off the room once, then detaches', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    engine.set({ phase: 'live' });
    session.release('a');
    tick();
    engine.set({ phase: 'error', error: 'connection_failed' });
    engine.set({ phase: 'error', error: 'connection_failed' });
    expect(ended).toEqual([
      {
        meetingId: 'a',
        title: 'T-a',
        phase: 'error',
        error: 'connection_failed',
      },
    ]);
    expect(engine.detach).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().engine).toBeNull();
  });

  it('keeps a finished call while a room page shows its end screen', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    engine.set({ phase: 'live' });
    engine.set({ phase: 'ended' });
    expect(engine.detach).not.toHaveBeenCalled();
    expect(ended).toEqual([]);
    session.release('a');
    tick();
    expect(engine.detach).toHaveBeenCalledTimes(1);
    expect(ended).toEqual([]);
  });

  it('answers busy for another meeting and leaves the held call alone', () => {
    const a = engineFor('a');
    const b = engineFor('b');
    session.open('a', a.create);
    a.engine.set({ phase: 'live' });
    expect(session.open('b', b.create)).toEqual({
      kind: 'busy',
      held: { meetingId: 'a', title: 'T-a' },
    });
    expect(b.create).not.toHaveBeenCalled();
    expect(a.engine.detach).not.toHaveBeenCalled();
    expect(a.engine.leave).not.toHaveBeenCalled();
    session.release('b');
    tick();
    expect(a.engine.detach).not.toHaveBeenCalled();
    expect(session.getSnapshot().claimed).toBe(true);
  });

  it('takes over: leaves, detaches, attaches, with no end toast', async () => {
    const a = engineFor('a');
    const b = engineFor('b');
    session.open('a', a.create);
    a.engine.set({ phase: 'live' });
    session.release('a');
    tick();
    const result = await session.takeOver('b', b.create);
    expect(result).toEqual({ kind: 'ready', engine: b.engine });
    expect(a.engine.leave).toHaveBeenCalledTimes(1);
    expect(a.engine.detach).toHaveBeenCalledTimes(1);
    expect(b.engine.attach).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot()).toMatchObject({
      engine: b.engine,
      claimed: true,
    });
    expect(ended).toEqual([]);
  });

  it('opens nothing when the page left during a takeOver', async () => {
    const a = engineFor('a');
    const b = engineFor('b');
    session.open('a', a.create);
    a.engine.set({ phase: 'live' });
    const pending = session.takeOver('b', b.create);
    session.release('b');
    expect(await pending).toBeNull();
    expect(b.create).not.toHaveBeenCalled();
    expect(session.getSnapshot().engine).toBeNull();
  });

  it('replaces a held engine that is not in a call', () => {
    const a = engineFor('a');
    const b = engineFor('b');
    session.open('a', a.create);
    session.release('a');
    session.open('b', b.create);
    tick();
    expect(a.engine.detach).toHaveBeenCalledTimes(1);
    expect(b.engine.attach).toHaveBeenCalledTimes(1);
    expect(b.engine.detach).not.toHaveBeenCalled();
    expect(session.getSnapshot().engine).toBe(b.engine);
  });

  it('disposes whatever is held', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    engine.set({ phase: 'live' });
    session.dispose();
    expect(engine.detach).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().engine).toBeNull();
    expect(ended).toEqual([]);
  });

  it('tells subscribers when the title arrives, not on every change', () => {
    const { engine, create } = engineFor('a');
    session.open('a', create);
    const fn = vi.fn();
    session.subscribe(fn);
    engine.set({ phase: 'live' });
    expect(fn).not.toHaveBeenCalled();
    engine.set({ meeting: { title: 'New' } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().title).toBe('New');
  });
});

describe('endedNotice', () => {
  it('names how the call finished', () => {
    const of = (phase: string, error: string | null = null) =>
      endedNotice({ phase, error });
    expect(of('left')).toEqual({ key: 'left', rejoin: true });
    expect(of('ended')).toEqual({ key: 'ended', rejoin: false });
    expect(of('removed')).toEqual({ key: 'removed', rejoin: false });
    expect(of('left', 'seat_closed')).toEqual({
      key: 'elsewhere',
      rejoin: false,
    });
    expect(of('error', 'meeting_closed').key).toBe('ended');
    expect(of('error', 'connection_failed')).toEqual({
      key: 'lost',
      rejoin: true,
    });
    expect(of('lobby', 'join_failed').key).toBe('lost');
  });
});

describe('offRoomTileSizes', () => {
  it('makes every remote small and leaves ourselves out', () => {
    expect(offRoomTileSizes(['me', 'p1', 'p2'], 'me')).toEqual({
      p1: 'small',
      p2: 'small',
    });
  });
});

describe('rejoin marker', () => {
  const marker = { meetingId: 'a', title: 'Standup', userId: 'u1', at: 1000 };
  const raw = writeRejoinMarker(marker);

  it('reads back for the same person inside the window', () => {
    expect(readRejoinMarker(raw, 'u1', 2000)).toEqual(marker);
  });

  it('expires after two hours', () => {
    const edge = 1000 + REJOIN_MARKER_TTL_MS;
    expect(readRejoinMarker(raw, 'u1', edge - 1)).toEqual(marker);
    expect(readRejoinMarker(raw, 'u1', edge)).toBeNull();
  });

  it('is nothing to another user or to nobody', () => {
    expect(readRejoinMarker(raw, 'u2', 2000)).toBeNull();
    expect(readRejoinMarker(raw, null, 2000)).toBeNull();
  });

  it('tolerates junk', () => {
    for (const junk of [
      null,
      '',
      'not json',
      'null',
      '42',
      '[]',
      '{}',
      JSON.stringify({ ...marker, at: 'soon' }),
      JSON.stringify({ ...marker, meetingId: 7 }),
      JSON.stringify({ ...marker, at: 5000 }),
    ]) {
      expect(readRejoinMarker(junk, 'u1', 2000)).toBeNull();
    }
  });
});
