import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { fakeDb, type Row } from '@/lib/whatsapp/broadcast.fake';

// The hook module pulls in the browser Supabase client and the auth
// context; neither is needed for the pure helper under test.
const getSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession } }),
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ accountId: 'acct' }) }));

import { unsavedInMemory } from '@/lib/app-update/unsaved';
import {
  deliverOnServer,
  resolveSendTime,
  useBroadcastSending,
} from './use-broadcast-sending';

const DUBAI = { start: '21:00', end: '08:00', tz: 'Asia/Dubai' };

describe('resolveSendTime', () => {
  const now = new Date('2026-09-16T08:00:00Z'); // 12:00 Dubai

  it('sends now when nothing is scheduled and no quiet hours apply', () => {
    expect(resolveSendTime(now, null, null)).toBeNull();
  });

  it('keeps a future schedule as-is outside quiet hours', () => {
    const at = new Date('2026-09-17T09:00:00Z');
    expect(resolveSendTime(now, at, DUBAI)).toBe(at);
  });

  it('treats a schedule in the past as "send now"', () => {
    const past = new Date('2026-09-16T07:00:00Z');
    expect(resolveSendTime(now, past, null)).toBeNull();
  });

  it('turns a send-now inside quiet hours into a schedule for the window end', () => {
    const late = new Date('2026-09-16T19:30:00Z'); // 23:30 Dubai
    expect(resolveSendTime(late, null, DUBAI)?.toISOString()).toBe(
      '2026-09-17T04:00:00.000Z'
    );
  });

  it('pushes a schedule that lands inside quiet hours to the window end', () => {
    const at = new Date('2026-09-18T20:00:00Z'); // 00:00 Dubai on the 19th
    expect(resolveSendTime(now, at, DUBAI)?.toISOString()).toBe(
      '2026-09-19T04:00:00.000Z'
    );
  });
});

describe('deliverOnServer', () => {
  const answer = (status: number, body: Row) =>
    new Response(JSON.stringify(body), { status });
  const fetchMock = vi.fn<() => Promise<Response>>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    // A pass that always says there is more: the loop must end itself.
    let remaining = 5000;
    fetchMock.mockImplementation(async () =>
      answer(202, { remaining: (remaining -= 1000) })
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const tables = (row: Row) => ({
    broadcasts: [{ id: 'bc-1', delivery_locked_at: null }] as Row[],
    broadcast_recipients: [
      { id: 'r1', broadcast_id: 'bc-1', error_message: null, ...row },
    ] as Row[],
  });
  const run = async (t: Record<string, Row[]>) => {
    const done = deliverOnServer(fakeDb(t) as never, 'bc-1', 5000);
    done.catch(() => {});
    await vi.runAllTimersAsync();
    return done;
  };

  it('runs every pass of a campaign that keeps sending', async () => {
    await run(tables({ status: 'pending' }));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('stops after a pass that stopped early', async () => {
    await run(
      tables({ status: 'pending', error_message: 'This number reached…' })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('goes on past recipients that failed for their own reason', async () => {
    await run(tables({ status: 'failed', error_message: 'No such number' }));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('stops when a pass left as many as before', async () => {
    fetchMock.mockImplementation(async () => answer(202, { remaining: 1000 }));
    await run(tables({ status: 'pending' }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pauses when quiet hours begin between passes, and throws on the first', async () => {
    const t = tables({ status: 'pending' });
    const quiet = async () =>
      answer(400, { code: 'quiet_hours', error: 'quiet' });
    fetchMock
      .mockImplementationOnce(async () => answer(202, { remaining: 10 }))
      .mockImplementation(quiet);
    await run(t);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await expect(run(t)).rejects.toThrow('quiet');
  });

  it('leaves the status to the route when nothing is left to send', async () => {
    const t = tables({ status: 'sent' });
    t.broadcasts[0].status = 'sent';
    fetchMock.mockImplementation(async () =>
      answer(400, { code: 'nothing_to_resume' })
    );
    await run(t);
    expect(t.broadcasts[0].status).toBe('sent');
  });
});

describe('a campaign this tab is sending', () => {
  it('holds the tab from reloading by itself until it ends', async () => {
    let answer: (a: unknown) => void = () => {};
    getSession.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const seen =
      vi.fn<(hook: ReturnType<typeof useBroadcastSending>) => void>();
    function Screen() {
      seen(useBroadcastSending());
      return null;
    }
    renderToStaticMarkup(createElement(Screen));
    expect(unsavedInMemory()).toBe(false);

    const sending = seen.mock.calls[0][0].createAndSendBroadcast({} as never);
    expect(unsavedInMemory()).toBe(true);
    answer({ data: { session: null } });
    await expect(sending).rejects.toThrow('not signed in');
    expect(unsavedInMemory()).toBe(false);
  });
});
