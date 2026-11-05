import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingCallEngine } from '@/hooks/use-meeting-call';

// The lobby has no realtime channel, so it reads the meeting again by
// itself. Only a real call showed why: unlocking left the person waiting
// at the door until they reloaded.

const db = vi.hoisted(() => ({
  reads: [] as { data: unknown; error: unknown }[],
  count: 0,
  removed: false,
  /** Holds the next read open until released. */
  gate: null as Promise<void> | null,
}));

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.limit = async () => ({
        data: table === 'meeting_removed_users' && db.removed ? [{}] : [],
        error: null,
      });
      q.maybeSingle = async () => {
        db.count += 1;
        if (db.gate) await db.gate;
        return db.reads.shift() ?? { data: ROW, error: null };
      };
      return q;
    },
    rpc: async () => ({ data: false, error: null }),
  }),
}));

const ROW = {
  id: 'm',
  title: 'Weekly',
  status: 'scheduled',
  host_user_id: 'h',
  locked_at: '2026-11-05T10:00:00.000Z',
};

interface Inner {
  loadMeeting: () => Promise<void>;
  refreshLobby: () => Promise<void>;
  emit: (patch: Record<string, unknown>) => void;
  stopMedia: () => void;
}

async function waiting() {
  const e = new MeetingCallEngine('m');
  const inner = e as unknown as Inner;
  await inner.loadMeeting();
  expect(e.getSnapshot().meetingState).toBe('ready');
  db.count = 0;
  return { e, inner };
}

describe('the lobby keeps up with the meeting', () => {
  beforeEach(() => {
    db.reads = [];
    db.count = 0;
    db.removed = false;
    db.gate = null;
  });

  it('lets someone held by a lock in once it lifts', async () => {
    const { e, inner } = await waiting();
    expect(e.getSnapshot().locked).toBe(true);
    db.reads = [{ data: { ...ROW, locked_at: null }, error: null }];
    await inner.refreshLobby();
    expect(e.getSnapshot().locked).toBe(false);
  });

  it('shows a recording that started while they wait', async () => {
    const { e, inner } = await waiting();
    expect(e.getSnapshot().recording).toBeNull();
    db.reads = [
      {
        data: {
          ...ROW,
          recording_started_at: '2026-11-05T10:01:00.000Z',
          recording_by: 'h',
        },
        error: null,
      },
    ];
    await inner.refreshLobby();
    expect(e.getSnapshot().recording?.userId).toBe('h');
  });

  it('ends the lobby of a meeting that ended', async () => {
    const { e, inner } = await waiting();
    db.reads = [{ data: { ...ROW, status: 'ended' }, error: null }];
    await inner.refreshLobby();
    expect(e.getSnapshot().phase).toBe('ended');
  });

  it('tells someone removed while they wait', async () => {
    const { e, inner } = await waiting();
    db.removed = true;
    db.reads = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    await inner.refreshLobby();
    expect(e.getSnapshot().phase).toBe('removed');
  });

  it('changes nothing on a failed read', async () => {
    const { e, inner } = await waiting();
    // Two: a read that fell through to loadMeeting would read as missing.
    const failed = { data: null, error: { code: '57014' } };
    db.reads = [failed, failed];
    await inner.refreshLobby();
    expect(e.getSnapshot().meetingState).toBe('ready');
    expect(e.getSnapshot().locked).toBe(true);
  });

  it('reads nothing once they are joining', async () => {
    const { inner } = await waiting();
    inner.emit({ phase: 'joining' });
    await inner.refreshLobby();
    expect(db.count).toBe(0);
  });

  it('drops an answer that lands after they joined', async () => {
    const { e, inner } = await waiting();
    let open = () => {};
    db.gate = new Promise((resolve) => (open = resolve));
    db.reads = [{ data: { ...ROW, status: 'ended' }, error: null }];
    const reading = inner.refreshLobby();
    inner.emit({ phase: 'live' });
    open();
    await reading;
    expect(e.getSnapshot().phase).toBe('live');
  });
});
