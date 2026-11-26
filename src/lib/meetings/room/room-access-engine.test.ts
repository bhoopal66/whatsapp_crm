import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingCallEngine } from '@/hooks/use-meeting-call';

import { HEARTBEAT_INTERVAL_MS, REFUSED_FOR_MS } from './presence';

// A deactivated or removed person's heartbeat answers 401 or 403, and
// Cloudflare keeps relaying what they already pulled: the room has to end
// itself, but not for a token that renews by itself.

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));

interface Inner {
  attached: boolean;
  pc: unknown;
  participantId: string | null;
  audio: MediaStreamTrack | null;
  api: () => Promise<unknown>;
  heartbeat: () => Promise<void>;
  pushState: () => Promise<void>;
}

const answer = (status: number) => ({ ok: status === 200, status, body: {} });

function live(statuses: number[]) {
  const engine = new MeetingCallEngine('m');
  const inner = engine as unknown as Inner;
  const pc = { close: vi.fn() };
  const audio = { kind: 'audio', enabled: true, stop: vi.fn() };
  inner.attached = true;
  inner.pc = pc;
  inner.participantId = 'seat-1';
  inner.audio = audio as unknown as MediaStreamTrack;
  inner.api = vi.fn(async () => answer(statuses.shift() ?? 200));
  const error = () => engine.getSnapshot().error;
  const next = async () => {
    await inner.heartbeat();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
  };
  return { engine, inner, pc, audio, error, next };
}

describe('a seat the server refuses', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([401, 403])('ends the room on a second %i', async (status) => {
    const s = live([status, status]);
    await s.next();
    expect(s.error()).toBeNull();
    expect(s.pc.close).not.toHaveBeenCalled();
    await s.next();
    expect(s.engine.getSnapshot()).toMatchObject({
      phase: 'left',
      error: 'access_lost',
    });
    expect(s.pc.close).toHaveBeenCalledTimes(1);
    expect(s.audio.stop).toHaveBeenCalledTimes(1);
    expect(s.inner.participantId).toBeNull();
  });

  it('throws nobody out for a token renewed before the next heartbeat', async () => {
    const s = live([401, 200, 401, 200]);
    for (let n = 0; n < 4; n += 1) await s.next();
    expect(s.error()).toBeNull();
    expect(s.pc.close).not.toHaveBeenCalled();
  });

  it('does not count a burst of toggles in one moment as two refusals', async () => {
    const s = live([401, 401, 401, 200]);
    await s.inner.heartbeat();
    await s.inner.pushState();
    await vi.advanceTimersByTimeAsync(REFUSED_FOR_MS - 1);
    await s.inner.pushState();
    expect(s.error()).toBeNull();
    await s.next();
    expect(s.error()).toBeNull();
  });

  it.each([0, 503])(
    'is twice in a row: a %i in between starts it over',
    async (other) => {
      const s = live([403, other, 403, other, 403, 403]);
      for (let n = 0; n < 5; n += 1) await s.next();
      expect(s.error()).toBeNull();
      expect(s.pc.close).not.toHaveBeenCalled();
      await s.next();
      expect(s.error()).toBe('access_lost');
    }
  );
});
